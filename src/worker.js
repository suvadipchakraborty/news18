// Serves ./public as static assets and provides /api/pages?date=YYYY-MM-DD for the app.
//
// Source order for each date:
//   1. Google Sheet cache via the Apps Script web app (env.SHEET_API_URL) -- the normal path.
//      The sheet holds only "100 years ago today" +/- 7 days, refreshed every morning ~5 AM IST.
//   2. Direct fetch from loc.gov (in case the sheet is unreachable).
//   3. Headless browser (Browser Rendering) if loc.gov shows its bot challenge.
import puppeteer from "@cloudflare/puppeteer";

const LOC = "https://www.loc.gov/collections/chronicling-america/";
const YEARS_BACK = 100;
const WINDOW_DAYS = 7;

// The tested loc.gov query: one day, JSON, results only. (c=100 raises the page size so busy days aren't cut off.)
const locUrl = d => `${LOC}?q=the&dates=${d}/${d}&fo=json&at=results&c=100`;

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": LOC,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/pages") return pages(url, env);
    return env.ASSETS.fetch(request);
  },
};

// ---- date helpers (window is centred on today's date in IST, minus 100 years) ----
function centerDate(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const m = ist.getUTCMonth();
  const t = new Date(Date.UTC(ist.getUTCFullYear() - YEARS_BACK, m, ist.getUTCDate(), 12));
  if (t.getUTCMonth() !== m) t.setUTCDate(0); // Feb 29 -> Feb 28 when the past year had no leap day
  return t.toISOString().slice(0, 10);
}
// +1 day of slack so visitors in other time zones aren't rejected around midnight.
const inWindow = d => Math.abs(Date.parse(d + "T12:00:00Z") - Date.parse(centerDate() + "T12:00:00Z")) / 864e5 <= WINDOW_DAYS + 1;

async function pages(url, env) {
  const date = url.searchParams.get("date") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + "T12:00:00Z"))) return json({ error: "Invalid date" }, 400);
  if (!inWindow(date)) return json({ error: "Date is outside the supported window", detail: `Only ${centerDate()} +/- ${WINDOW_DAYS} days is available.` }, 400);

  const cache = caches.default, key = new Request(`${url.origin}/api/pages?date=${date}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  const errors = {};

  // 1. Google Sheet (Apps Script)
  if (env.SHEET_API_URL) {
    const r = await tryFetch(`${env.SHEET_API_URL}${env.SHEET_API_URL.includes("?") ? "&" : "?"}date=${date}`, { headers: { Accept: "application/json" } });
    if (r.ok) return respond(cache, key, onlyDate(r.body, date));
    errors.sheet = r.detail;
  }

  // 2. loc.gov directly
  const direct = await tryFetch(locUrl(date), { headers: BROWSER_HEADERS });
  if (direct.ok) return respond(cache, key, onlyDate(direct.body, date));
  errors.direct = direct.detail;

  // 3. Real headless browser
  let browser;
  try { browser = await renderWithBrowser(env, locUrl(date)); }
  catch (e) { browser = { ok: false, detail: "Browser rendering error: " + String(e).slice(0, 150) }; }
  if (browser.ok) return respond(cache, key, onlyDate(browser.body, date));
  errors.browser = browser.detail;

  return json({ error: "Upstream failed", upstream_status: direct.status, detail: Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join(" | ") }, 502);
}

// loc.gov ignores the date filter when nothing matches and returns a huge unfiltered browse list.
// Keep only pages dated exactly `date` (and trim the fields the app needs), so "no news" becomes {"results":[]}.
function onlyDate(body, date) {
  try {
    const results = (JSON.parse(body).results || [])
      .filter(r => String(r.date || "").slice(0, 10) === date)
      .map(r => ({
        id: r.id || r.url, title: r.title, partof_title: r.partof_title, date: r.date, number_page: r.number_page,
        location_city: r.location_city, location_state: r.location_state,
        image_url: (r.image_url || []).map(u => String(u).split("#")[0]).filter(u => /\.jpe?g$/i.test(u)),
      }))
      .filter(r => r.image_url.length);
    return JSON.stringify({ results });
  } catch (e) { return body; }
}

// Days with pages are cached for a day; empty days only for an hour (in case the archive adds them).
async function respond(cache, key, body) {
  let count = 1;
  try { count = (JSON.parse(body).results || []).length; } catch (e) {}
  const res = new Response(body, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${count ? 86400 : 3600}` } });
  try { await cache.put(key, res.clone()); } catch (e) { /* ignore cache failures */ }
  return res;
}

// Accepts only a JSON object without an "error" field.
async function tryFetch(u, init) {
  try {
    const r = await fetch(u, { ...init, redirect: "follow" });
    const body = (await r.text()).trim();
    if (r.ok && body.startsWith("{")) {
      let parsed; try { parsed = JSON.parse(body); } catch (e) { return { ok: false, status: r.status, detail: "Bad JSON" }; }
      if (!parsed.error) return { ok: true, body };
      return { ok: false, status: parsed.upstream_status || r.status, detail: String(parsed.error + (parsed.detail ? ": " + parsed.detail : "")).slice(0, 150) };
    }
    const snippet = body.startsWith("<") ? (body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "HTML block page") : body.slice(0, 150);
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
    const title = await page.title();
    if (/just a moment|attention required|checking your browser/i.test(title)) {
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    }
    const text = await page.evaluate(() => document.body ? document.body.innerText : "");
    const trimmed = (text || "").trim();
    if (trimmed.startsWith("{")) return { ok: true, body: trimmed };
    return { ok: false, status: 0, detail: "Still blocked after render: " + (await page.title()) };
  } finally {
    await browser.close().catch(() => {});
  }
}

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
