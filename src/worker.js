// Serves ./public as static assets and proxies the Library of Congress Chronicling America search.
// loc.gov allows ~20 requests/minute per IP and blocks for an hour beyond that, so responses are cached hard.
const LOC = "https://www.loc.gov/collections/chronicling-america/";
const UA = "200YearsAgoToday/1.0 (+https://news18.suvadipchakraborty.workers.dev; suvadipchakraborty@gmail.com)";

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
  const upstream = `${LOC}?dl=page&dates=${shift(date, -span)}/${shift(date, span)}&fo=json&c=100`;
  try {
    const r = await fetch(upstream, {
      headers: { Accept: "application/json", "User-Agent": UA },
      // Historical pages never change: cache successes for a week, never cache errors.
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 604800, "300-599": 0 } },
    });
    const body = await r.text();
    if (r.ok && body.trim().startsWith("{")) {
      return new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" } });
    }
    return json({ error: "Upstream failed", upstream_status: r.status, detail: body.trim().startsWith("<") ? "HTML/CAPTCHA page" : body.slice(0, 120) }, 502);
  } catch (e) {
    return json({ error: "Upstream unreachable", upstream_status: 0, detail: String(e).slice(0, 120) }, 502);
  }
}
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
