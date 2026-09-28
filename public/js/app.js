const $ = s => document.querySelector(s);
const APP_URL = "https://news18.suvadipchakraborty.workers.dev/";
const YEARS_BACK = 200;
const fmt = iso => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
const shift = (iso, d) => { const t = new Date(iso + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

function twoCenturiesAgo() {
  const n = new Date(), y = n.getFullYear() - YEARS_BACK, m = n.getMonth(), d = n.getDate();
  const t = new Date(Date.UTC(y, m, d, 12));
  if (t.getUTCMonth() !== m) t.setUTCDate(0); // Feb 29 -> Feb 28 when the past year had no leap day
  return t.toISOString().slice(0, 10);
}

let current = twoCenturiesAgo(), shown = current, pages = [], reqId = 0;

// ---- data ----
// loc.gov allows about 20 requests/minute per IP and blocks for an hour beyond that,
// so: at most one request per date (a second only when that day is empty), a throttle, and a session cache.
const LOC = "https://www.loc.gov/collections/chronicling-america/";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;
async function slot() { const w = Math.max(0, lastCall + 3200 - Date.now()); lastCall = Date.now() + w; if (w) await sleep(w); }

async function getData(day, span) {
  const key = `ca:${day}:${span}`;
  try { const c = sessionStorage.getItem(key); if (c) return JSON.parse(c); } catch (e) {}
  let why = "";
  await slot();
  try {
    const r = await fetch(`/api/pages?date=${day}&span=${span}`);
    if (r.ok) return remember(key, await r.json());
    let d = {}; try { d = await r.json(); } catch (e) {}
    why = d.upstream_status ? "archive said " + d.upstream_status : "server said " + r.status;
    if (d.upstream_status === 429 || d.upstream_status === 403) why += " — too many requests, wait a few minutes";
  } catch (e) { why = "network error"; }
  try { // fallback: ask the Library of Congress straight from the browser
    await slot();
    const r = await fetch(`${LOC}?dl=page&dates=${shift(day, -span)}/${shift(day, span)}&fo=json&c=100`);
    if (r.ok) return remember(key, await r.json());
    why += "; direct " + r.status;
  } catch (e) { why += "; direct request blocked"; }
  throw new Error(why);
}
function remember(key, data) { try { sessionStorage.setItem(key, JSON.stringify(data)); } catch (e) {} return data; }

async function load(iso) {
  const id = ++reqId;
  $("#grid").innerHTML = ""; $("#notice").hidden = true;
  $("#status").textContent = "Developing the plates…";
  $("#welcome").textContent = "Welcome to " + fmt(iso);
  $("#date").value = iso; current = iso;
  let found = [], used = iso;
  try {
    found = normalize((await getData(iso, 0)).results || []);
    if (id !== reqId) return;
    if (!found.length) {
      const near = normalize((await getData(iso, 2)).results || []);
      if (id !== reqId) return;
      if (near.length) {
        const dist = d => Math.abs(new Date(d + "T12:00:00Z") - new Date(iso + "T12:00:00Z")) + (d < iso ? 1 : 0);
        used = near.map(p => p.date).filter(Boolean).sort((x, y) => dist(x) - dist(y))[0] || iso;
        found = near.filter(p => p.date === used);
      }
    }
  } catch (e) {
    if (id !== reqId) return;
    $("#status").textContent = "The archive didn't answer (" + e.message + "). Tap a date arrow to retry.";
    return;
  }
  pages = found; shown = used;
  if (!pages.length) { $("#status").textContent = "No digitized newspapers found within two days of " + fmt(iso) + ". Try another date."; return; }
  if (used !== iso) {
    $("#notice").hidden = false;
    $("#notice").textContent = "No papers from " + fmt(iso) + " are in the archive. Showing " + fmt(used) + ", the nearest day with pages.";
  }
  render();
}

function normalize(results) {
  return results.filter(r => Array.isArray(r.image_url) && r.image_url.length).map(r => {
    const imgs = r.image_url.map(u => String(u).split("#")[0]);
    const big = imgs.find(u => /\.jpg$/i.test(u) && /(?:_|\/)?(?:full|service|large)/i.test(u)) || imgs[imgs.length - 1];
    const place = [].concat(r.location_city || [], r.location_state || []).map(s => String(s)).filter(Boolean);
    const num = parseInt(String(r.number_page || r.page || "").replace(/\D/g, ""), 10) || 0;
    return {
      title: String(r.partof_title || r.title || "Untitled newspaper").replace(/\s*\[volume\].*$/i, ""),
      thumb: imgs[0], full: big, num, date: String(r.date || "").slice(0, 10),
      place: place.length ? place.map(p => p.replace(/\b\w/g, c => c.toUpperCase())).join(", ") : "",
      url: r.url || r.id || "https://www.loc.gov/collections/chronicling-america/",
    };
  }).sort((a, b) => (a.num || 99) - (b.num || 99) || a.title.localeCompare(b.title));
}

function render() {
  const front = $("#frontOnly").checked && pages.some(p => p.num === 1);
  const list = front ? pages.filter(p => p.num === 1) : pages;
  $("#status").textContent = list.length + (list.length === 1 ? " page" : " pages") + " from " + fmt(shown) + (front ? " (front pages)" : "");
  const grid = $("#grid"); grid.innerHTML = "";
  list.forEach(p => {
    const c = document.createElement("button");
    c.className = "card";
    c.innerHTML = '<div class="img"><img loading="lazy" alt=""></div><h3></h3><p></p>';
    const img = c.querySelector("img");
    img.alt = "Newspaper page: " + p.title;
    img.onload = () => requestAnimationFrame(() => img.classList.add("developed"));
    img.src = p.thumb;
    c.querySelector("h3").textContent = p.title;
    c.querySelector("p").textContent = [p.place, p.num ? "Page " + p.num : ""].filter(Boolean).join(" · ");
    c.onclick = () => openViewer(p);
    grid.appendChild(c);
  });
}

// ---- viewer: zoom, pan, loupe ----
const st = { s: 1, x: 0, y: 0, page: null, loupe: false };
const stage = $("#stage"), vimg = $("#vimg"), lens = $("#lens");
const pointers = new Map(); let pinch = null;

function apply() { vimg.style.transform = `translate(${st.x}px,${st.y}px) scale(${st.s})`; }
function fit() {
  const w = stage.clientWidth, nw = vimg.naturalWidth || 1, nh = vimg.naturalHeight || 1;
  vimg.style.width = nw + "px"; vimg.style.height = nh + "px";
  st.s = Math.min(w / nw, stage.clientHeight / nh); st.x = (w - nw * st.s) / 2; st.y = 0; base = st.s; apply();
}
let base = 1;
function zoomAt(f, cx, cy) {
  const ns = Math.min(Math.max(st.s * f, base * .9), base * 8);
  st.x = cx - (cx - st.x) * (ns / st.s); st.y = cy - (cy - st.y) * (ns / st.s); st.s = ns; apply();
}
function openViewer(p) {
  st.page = p; $("#viewer").hidden = false; document.body.style.overflow = "hidden";
  $("#vtitle").textContent = p.title + " — " + fmt(shown);
  $("#vsource").href = p.url;
  vimg.onload = fit; vimg.src = p.full;
  if (vimg.complete && vimg.naturalWidth) fit();
}
function closeViewer() { $("#viewer").hidden = true; document.body.style.overflow = ""; vimg.removeAttribute("src"); }
$("#vclose").onclick = closeViewer;
addEventListener("keydown", e => { if (e.key === "Escape" && !$("#viewer").hidden) closeViewer(); });
$("#loupe").onclick = e => { st.loupe = !st.loupe; e.currentTarget.setAttribute("aria-pressed", st.loupe); lens.hidden = true; stage.style.cursor = st.loupe ? "crosshair" : "grab"; };

function showLens(e) {
  const r = vimg.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) { lens.hidden = true; return; }
  const bw = Math.max(r.width * 2.5, vimg.naturalWidth * 0.6), bh = bw * vimg.naturalHeight / vimg.naturalWidth;
  lens.style.backgroundImage = `url("${vimg.src}")`;
  lens.style.backgroundSize = `${bw}px ${bh}px`;
  lens.style.backgroundPosition = `${85 - fx * bw}px ${85 - fy * bh}px`;
  lens.style.left = (e.clientX - sr.left - 85) + "px";
  lens.style.top = (e.clientY - sr.top - (e.pointerType === "touch" ? 130 : 85)) + "px";
  lens.hidden = false;
}
stage.addEventListener("pointerdown", e => {
  stage.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (st.loupe && pointers.size === 1) showLens(e);
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
});
stage.addEventListener("pointermove", e => {
  const p = pointers.get(e.pointerId);
  if (st.loupe) { if (pointers.size || e.pointerType === "mouse") showLens(e); return; }
  if (!p) return;
  const sr = stage.getBoundingClientRect();
  if (pointers.size === 1) { st.x += e.clientX - p.x; st.y += e.clientY - p.y; apply(); }
  else if (pointers.size === 2) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch) zoomAt(d / pinch, (a.x + b.x) / 2 - sr.left, (a.y + b.y) / 2 - sr.top);
    pinch = d;
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
});
const up = e => { pointers.delete(e.pointerId); pinch = null; if (!pointers.size) lens.hidden = true; };
stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
stage.addEventListener("wheel", e => { e.preventDefault(); const sr = stage.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.15 : .87, e.clientX - sr.left, e.clientY - sr.top); }, { passive: false });
stage.addEventListener("dblclick", e => { const sr = stage.getBoundingClientRect(); if (st.s > base * 1.5) fit(); else zoomAt(3, e.clientX - sr.left, e.clientY - sr.top); });

// ---- sharing ----
async function share(data) {
  try {
    if (navigator.share) await navigator.share(data);
    else { await navigator.clipboard.writeText(data.text + " " + data.url); $("#status").textContent = "Link copied to clipboard."; }
  } catch (e) { /* user cancelled */ }
}
$("#share").onclick = () => share({ title: "200 Years Ago Today", text: `Read the newspapers printed on ${fmt(shown)}, exactly ${YEARS_BACK} years before today.`, url: APP_URL });
$("#vshare").onclick = () => { const p = st.page; share({ title: p.title, text: `${p.title}, ${fmt(shown)}. Front page from the Library of Congress.`, url: p.url }); };

// ---- controls & tabs ----
$("#date").onchange = e => e.target.value && load(e.target.value);
$("#prev").onclick = () => load(shift(current, -1));
$("#next").onclick = () => load(shift(current, 1));
$("#today").onclick = () => load(twoCenturiesAgo());
$("#frontOnly").onchange = render;
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
  for (const id of ["home", "about"]) $("#" + id).hidden = id !== b.dataset.tab;
  scrollTo(0, 0);
});

load(current);
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
