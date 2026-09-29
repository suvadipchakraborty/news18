// Google Apps Script -- keeps a Google Sheet cache of Chronicling America (loc.gov) results for
// "100 years ago today" +/- 7 days, and serves it to the Cloudflare Worker as a Web App.
//
// FIRST-TIME SETUP
//   1. Run setup() once from the editor (authorize when asked). It creates/repairs the sheet,
//      installs the daily ~5 AM IST trigger, prunes old rows and fills the 15-day window.
//   2. Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone.
//      Put the /exec URL in wrangler.toml as SHEET_API_URL.
//   After editing this file later: Deploy > Manage deployments > Edit > New version.

const SPREADSHEET_ID = "1AIdg2cnLfqbKJzSA6eCDgRgeUz4Cvsh9fG5-Frg3q4c";
const CACHE_SHEET = "cache";
const YEARS_BACK = 100;
const WINDOW_DAYS = 7;          // keep target date +/- 7 days (15 dates in total)
const TZ = "Asia/Kolkata";      // IST
const TRIGGER_HOUR = 5;         // runs between 5:00 and 5:15 AM IST
const FETCH_GAP_MS = 3500;      // loc.gov allows ~20 requests/minute
const CHUNK = 45000;            // a cell holds at most 50,000 characters, so long JSON is split across columns
const FIRST_JSON_COL = 4;       // columns: A date | B fetched_at | C result_count | D... json chunks
const LOC = "https://www.loc.gov/collections/chronicling-america/";

// ---------------------------------------------------------------- dates

function shiftDate_(iso, days) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Today's date in IST, minus 100 years.
function targetDate_() {
  const p = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd").split("-").map(Number);
  const t = new Date(Date.UTC(p[0] - YEARS_BACK, p[1] - 1, p[2], 12));
  if (t.getUTCMonth() !== p[1] - 1) t.setUTCDate(0); // Feb 29 -> Feb 28 when the past year had no leap day
  return t.toISOString().slice(0, 10);
}

// target +/- (WINDOW_DAYS + slack), oldest first
function windowDates_(slack) {
  const c = targetDate_(), n = WINDOW_DAYS + (slack || 0), out = [];
  for (let i = -n; i <= n; i++) out.push(shiftDate_(c, i));
  return out;
}

// ---------------------------------------------------------------- sheet helpers

let ss_ = null;
function getSs_() { return ss_ || (ss_ = SpreadsheetApp.openById(SPREADSHEET_ID)); }

function getSheet_() {
  const ss = getSs_();
  let sh = ss.getSheetByName(CACHE_SHEET);
  if (!sh) sh = ss.insertSheet(CACHE_SHEET);
  if (String(sh.getRange(1, 1).getValue()) !== "date") {
    sh.getRange(1, 1, 1, 4).setValues([["date", "fetched_at", "result_count", "json (split across columns D onward)"]]);
    sh.setFrozenRows(1);
    sh.getRange("A:A").setNumberFormat("@"); // plain text, so "1926-09-29" is never turned into a date
  }
  return sh;
}

function keyOf_(v) {
  return v instanceof Date ? Utilities.formatDate(v, getSs_().getSpreadsheetTimeZone(), "yyyy-MM-dd") : String(v).trim();
}

function findRow_(sh, date) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const keys = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < keys.length; i++) if (keyOf_(keys[i][0]) === date) return i + 2;
  return 0;
}

function readCache_(date) {
  const sh = getSheet_(), row = findRow_(sh, date);
  if (!row) return null;
  const v = sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0];
  const json = v.slice(FIRST_JSON_COL - 1).join("");
  return json ? { json: json, count: Number(v[2]) || 0 } : null;
}

function writeCache_(date, json, count) {
  withLock_(function () {
    const sh = getSheet_();
    const chunks = [];
    for (let i = 0; i < json.length; i += CHUNK) chunks.push(json.slice(i, i + CHUNK));
    if (!chunks.length) chunks.push("");
    const need = FIRST_JSON_COL - 1 + chunks.length;
    if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
    let row = findRow_(sh, date);
    if (row) sh.getRange(row, FIRST_JSON_COL, 1, sh.getMaxColumns() - FIRST_JSON_COL + 1).clearContent();
    else row = Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(row, 1, 1, need).setValues([[date, new Date(), count].concat(chunks)]);
  });
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------- loc.gov

// Keeps only what the app needs (same field names as loc.gov, so the app reads it the same way).
function slim_(results, date) {
  // loc.gov ignores the date filter when nothing matches and returns an unfiltered browse list,
  // so keep only pages whose own date is the requested date.
  return results.filter(function (r) { return String(r.date || "").slice(0, 10) === date; }).map(function (r) {
    return {
      id: r.id || r.url,
      title: r.title,
      partof_title: r.partof_title,
      date: r.date,
      number_page: r.number_page,
      location_city: r.location_city,
      location_state: r.location_state,
      image_url: (r.image_url || []).map(function (u) { return String(u).split("#")[0]; })
                                    .filter(function (u) { return /\.jpe?g$/i.test(u); }),
    };
  }).filter(function (r) { return r.image_url.length; });
}

// One request for one day. Returns {ok:true, json, count} or {ok:false, status, detail}.
function fetchFromLoc_(date) {
  const url = LOC + "?q=the&dates=" + date + "/" + date + "&fo=json&at=results&c=100";
  const res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": LOC,
    },
  });
  const status = res.getResponseCode(), body = res.getContentText();
  if (status === 200 && body.trim().charAt(0) === "{") {
    try {
      const results = slim_(JSON.parse(body).results || [], date);
      return { ok: true, json: JSON.stringify({ results: results }), count: results.length };
    } catch (e) {
      return { ok: false, status: status, detail: "Bad JSON: " + String(e).slice(0, 100) };
    }
  }
  const t = body.match(/<title[^>]*>([^<]*)<\/title>/i);
  return { ok: false, status: status, detail: t ? t[1] : body.slice(0, 150) };
}

// ---------------------------------------------------------------- web app

// GET ?date=YYYY-MM-DD  ->  {"results":[...]}  (empty list = no news that day)
function doGet(e) {
  const out = function (s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON); };
  const date = ((e && e.parameter && e.parameter.date) || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return out(JSON.stringify({ error: "Invalid date" }));
  if (windowDates_(1).indexOf(date) < 0) {
    return out(JSON.stringify({ error: "Date is outside the supported window", detail: "Only " + targetDate_() + " +/- " + WINDOW_DAYS + " days." }));
  }

  const cached = readCache_(date);
  if (cached) return out(cached.json);

  const r = fetchFromLoc_(date);
  if (r.ok) { writeCache_(date, r.json, r.count); return out(r.json); }
  return out(JSON.stringify({ error: "Upstream failed", upstream_status: r.status, detail: r.detail }));
}

// ---------------------------------------------------------------- daily job, pruning, setup

// Runs every morning ~5 AM IST: prune, then add whatever is missing (normally just one new day).
// Dates that were cached as "no news" are re-checked too.
function dailyUpdate() {
  pruneCache();
  let calls = 0;
  windowDates_(0).forEach(function (date) {
    const c = readCache_(date);
    if (c && c.count > 0) return;
    if (calls++ > 0) Utilities.sleep(FETCH_GAP_MS);
    const r = fetchFromLoc_(date);
    if (r.ok) writeCache_(date, r.json, r.count);
    else Logger.log("Fetch failed for " + date + ": " + r.status + " " + r.detail);
  });
  Logger.log("dailyUpdate done for window around " + targetDate_() + " (" + calls + " fetches)");
}

// Deletes every row that is not one of the 15 window dates (old dates, legacy "date:span" keys,
// blanks) and any duplicate rows. Returns the number of rows removed.
function pruneCache() {
  return withLock_(function () {
    const keep = {};
    windowDates_(0).forEach(function (d) { keep[d] = true; });
    const sh = getSheet_(), last = sh.getLastRow();
    if (last < 2) return 0;
    const keys = sh.getRange(2, 1, last - 1, 1).getValues(), seen = {}, del = [];
    keys.forEach(function (row, i) {
      const k = keyOf_(row[0]);
      if (!keep[k] || seen[k]) del.push(i + 2); else seen[k] = true;
    });
    for (let i = del.length - 1; i >= 0; i--) sh.deleteRow(del[i]);
    Logger.log("Pruned " + del.length + " row(s)");
    return del.length;
  });
}

function installTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const h = t.getHandlerFunction();
    if (h === "dailyUpdate" || h === "dailyPrefetch") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("dailyUpdate").timeBased().everyDays(1).atHour(TRIGGER_HOUR).nearMinute(0).inTimezone(TZ).create();
}

// Run this once. Safe to run again.
function setup() {
  getSheet_();          // create / repair the "cache" sheet
  installTrigger_();    // daily ~5 AM IST
  dailyUpdate();        // prune + fill the 15-day window now
  Logger.log("Setup complete. Target date: " + targetDate_() + ". Now deploy as a Web App.");
}
