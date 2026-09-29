// Serves ./public as static assets and proxies the Library of Congress Chronicling America search.
// loc.gov sits behind Cloudflare's own bot-challenge ("Just a moment..."), which a plain fetch() can
// never solve because it requires running the challenge's JavaScript. So: try a plain fetch first
// (cheap, and works again if the block ever lifts), and only spin up a real headless browser
// (Browser Rendering) when that fails.
import puppeteer from "@cloudflare/puppeteer";

const LOC = "https://www.loc.gov/collections/chronicling-america/";
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.loc.gov/collections/chronicling-america/",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/pages") return pages(url, env);
    return env.ASSETS.fetch(request);
  },
};

const shift = (iso, d) => { const t = new Date(iso + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

async function pages(url, env) {
  const date = url.searchParams.get("date") || "";
  const span = Math.min(2, Math.max(0, parseInt(url.searchParams.get("span") || "0", 10) || 0));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Invalid date" }, 400);
  const target = `${LOC}?dl=page&start_date=${shift(date, -span)}&end_date=${shift(date, span)}&fo=json&c=100`;
  const cache = caches.default, key = new Request(url.toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  // Attempt 1: plain fetch, in case the block has lifted.
  const attempt = await tryFetch(target);
  if (attempt.ok) {
    const res = new Response(attempt.body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" } });
    return cachePut(cache, key, res.clone(), res);
  }

  // Attempt 2: a real headless browser, which can run the challenge's JavaScript.
  let browserResult;
  try {
    browserResult = await renderWithBrowser(env, target);
  } catch (e) {
    browserResult = { ok: false, status: 0, detail: "Browser rendering error: " + String(e).slice(0, 150) };
  }
  if (browserResult.ok) {
    const res = new Response(browserResult.body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" } });
    const c = res.clone();
    return cachePut(cache, key, c, res);
  }

  return json({
    error: "Upstream failed",
    upstream_status: attempt.status,
    detail: attempt.detail,
    browser_status: browserResult.status,
    browser_detail: browserResult.detail,
  }, 502);
}

async function cachePut(cache, key, toCache, toReturn) {
  try { await cache.put(key, toCache); } catch (e) { /* ignore cache failures */ }
  return toReturn;
}

async function tryFetch(u) {
  try {
    const r = await fetch(u, { headers: BROWSER_HEADERS });
    const body = await r.text();
    if (r.ok && body.trim().startsWith("{")) {
      return { ok: true, body };
    }
    const snippet = body.trim().startsWith("<") ? (body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "HTML block page") : body.slice(0, 150);
    return { ok: false, status: r.status, detail: snippet };
  } catch (e) {
    return { ok: false, status: 0, detail: String(e).slice(0, 150) };
  }
}

async function renderWithBrowser(env, target) {
  if (!env.MYBROWSER) return { ok: false, status: 0, detail: "No browser binding configured" };
  const browser = await puppeteer.launch(env.MYBROWSER);
  try {
    const page = await browser.newPage();
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 20000 });
    // If Cloudflare's challenge is showing, wait for its automatic redirect to finish.
    const title = await page.title();
    if (/just a moment|attention required|checking your browser/i.test(title)) {
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    }
    const text = await page.evaluate(() => document.body ? document.body.innerText : "");
    const trimmed = (text || "").trim();
    if (trimmed.startsWith("{")) return { ok: true, body: trimmed };
    const finalTitle = await page.title();
    return { ok: false, status: 0, detail: "Still blocked after render: " + finalTitle };
  } finally {
    await browser.close().catch(() => {});
  }
}

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
