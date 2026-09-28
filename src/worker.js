// Serves ./public as static assets and proxies Library of Congress Chronicling America search.
const LOC = "https://www.loc.gov/collections/chronicling-america/";
const UA = "200YearsAgoToday/1.0 (+https://news18.suvadipchakraborty.workers.dev; suvadipchakraborty@gmail.com)";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/pages") return pages(url, ctx);
    return env.ASSETS.fetch(request);
  },
};

async function pages(url, ctx) {
  const date = url.searchParams.get("date") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Invalid date" }, 400);
  const cache = caches.default, key = new Request(url.toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const upstream = `${LOC}?dl=page&start_date=${date}&end_date=${date}&fo=json&c=100`;
  let last = { status: 0, detail: "" };
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(upstream, { headers: { Accept: "application/json", "User-Agent": UA } });
      if (r.ok) {
        const body = await r.text();
        const res = new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      }
      last = { status: r.status, detail: (await r.text()).slice(0, 200) };
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) { last = { status: 0, detail: String(e).slice(0, 200) }; }
    await new Promise(r => setTimeout(r, 800));
  }
  return json({ error: "Upstream failed", upstream_status: last.status, detail: last.detail }, 502);
}
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
