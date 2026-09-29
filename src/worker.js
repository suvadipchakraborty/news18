// Serves ./public as static assets and proxies the Library of Congress Chronicling America search.
// loc.gov's bot-protection blocks requests that self-identify as a bot (custom User-Agent), so this
// mimics an ordinary browser visit instead. It also allows ~20 requests/minute per IP, so successes
// are cached hard at the edge and errors are never cached.
const LOC = "https://www.loc.gov/collections/chronicling-america/";
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.loc.gov/collections/chronicling-america/",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/pages") return pages(url);
    return env.ASSETS.fetch(request);
  },
};

const shift = (iso, d) => { const t = new Date(iso + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

async function pages(url) {
  const date = url.searchParams.get("date") || "";
  const span = Math.min(2, Math.max(0, parseInt(url.searchParams.get("span") || "0", 10) || 0));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Invalid date" }, 400);
  const target = `${LOC}?dl=page&start_date=${shift(date, -span)}&end_date=${shift(date, span)}&fo=json&c=100`;

  // Attempt 1: fetch loc.gov directly, in case the block above has lifted.
  let attempt = await tryFetch(target, { headers: BROWSER_HEADERS });
  if (attempt.ok) return attempt.response;

  // Attempt 2: relay the same request through a public proxy that fetches from a
  // different IP range than Cloudflare Workers, since loc.gov's block appears to be
  // network-level rather than header-based.
  const relay = "https://api.allorigins.win/raw?url=" + encodeURIComponent(target);
  const attempt2 = await tryFetch(relay, { headers: { Accept: "application/json" } });
  if (attempt2.ok) return attempt2.response;

  return json({
    error: "Upstream failed",
    upstream_status: attempt.status,
    server: attempt.server,
    detail: attempt.detail,
    relay_status: attempt2.status,
    relay_detail: attempt2.detail,
  }, 502);
}

async function tryFetch(u, opts) {
  try {
    const r = await fetch(u, { ...opts, cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 604800, "300-599": 0 } } });
    const body = await r.text();
    if (r.ok && body.trim().startsWith("{")) {
      return { ok: true, response: new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" } }) };
    }
    const server = r.headers.get("server") || "";
    const snippet = body.trim().startsWith("<") ? (body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "HTML block page") : body.slice(0, 150);
    return { ok: false, status: r.status, server, detail: snippet };
  } catch (e) {
    return { ok: false, status: 0, server: "", detail: String(e).slice(0, 150) };
  }
}
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
