// Serves ./public as static assets and proxies Library of Congress Chronicling America search.
// (The legacy chroniclingamerica.loc.gov search API was retired in 2025; the loc.gov JSON API replaces it.)
const LOC = "https://www.loc.gov/collections/chronicling-america/";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/pages") {
      const date = url.searchParams.get("date") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Invalid date" }, 400);
      const upstream = `${LOC}?dl=page&start_date=${date}&end_date=${date}&fo=json&c=100&at=results,pagination`;
      const cache = caches.default;
      const key = new Request(url.toString());
      let res = await cache.match(key);
      if (res) return res;
      try {
        const r = await fetch(upstream, { headers: { Accept: "application/json" } });
        if (!r.ok) return json({ error: "Upstream " + r.status }, 502);
        res = new Response(r.body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      } catch (e) {
        return json({ error: "Upstream unreachable" }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
