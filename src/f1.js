#!/usr/bin/osascript -l JavaScript
// Formula 1 for Alfred: next race weekend, standings, results and schedule.
// Data: the Jolpica F1 API (the Ergast successor). No dependencies beyond macOS.
// Usage: osascript -l JavaScript f1.js race [query]      (Script Filter)
//        osascript -l JavaScript f1.js act <arg>         (action: open:<url> | ics:<season>:<round>:<key|all> | copy:<text>)
//        osascript -l JavaScript f1.js refresh <path>    (background cache refresh)
ObjC.import("Foundation");
ObjC.import("AppKit");

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}

// Test mode (any test override set): never reach the real API, open anything or touch the clipboard,
// even if the harness forgets one of the overrides.
const TEST_MODE = ["F1_NOW", "F1_API_BASE", "F1_SYNC", "F1_TEST_NO_OPEN"].some((k) => env(k, "") !== "");
const API_BASE = env("F1_API_BASE", TEST_MODE ? "" : "https://api.jolpi.ca/ergast/f1").replace(/\/+$/, "");
const UA = "alfred-f1/1.0 (+https://github.com/x-o-r-r-o/alfred-f1)";
const PAGE = 100; // Jolpica's maximum page size
const MIN = 60, HOUR = 3600, DAY = 86400;
const RETRY_AFTER = 60; // seconds before a failed background refresh is retried
let RERUN = null; // set when a background refresh is running
const NOTICES = [];

// ---------- clock ----------

// F1_NOW (an ISO date) makes the clock injectable for tests.
function now() {
  const fake = env("F1_NOW", "");
  if (fake) {
    const d = new Date(fake);
    if (!isNaN(d)) return d;
  }
  return new Date();
}
const NOW = now();
const THIS_YEAR = NOW.getFullYear();

// ---------- helpers ----------

function cacheDir() {
  const dir = env("alfred_workflow_cache", `${$.NSTemporaryDirectory().js}alfred-f1`);
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(`${dir}/api`, true, $(), $());
  return dir;
}

function readFile(path) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, $());
  return s.isNil() ? null : s.js;
}

function writeFile(path, text) {
  return $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, $());
}

function exists(path) {
  return $.NSFileManager.defaultManager.fileExistsAtPath(path);
}

function removeFile(path) {
  $.NSFileManager.defaultManager.removeItemAtPathError(path, $());
}

// Seconds since the file was modified (real clock, not F1_NOW), or null.
function fileAge(path) {
  const attrs = $.NSFileManager.defaultManager.attributesOfItemAtPathError(path, $());
  if (attrs.isNil()) return null;
  const m = attrs.objectForKey("NSFileModificationDate");
  return m.isNil() ? null : Date.now() / 1000 - m.timeIntervalSince1970;
}

function fold(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function info(title, subtitle, icon = "info", extra = {}) {
  return Object.assign({ title, subtitle: subtitle || "", valid: false, icon: { path: `icons/${icon}.png` } }, extra);
}

// Display strings: no control or bidi-override characters, no unpaired surrogates (Alfred rejects the JSON).
function clean(s) {
  return typeof s === "string" ? wellFormed(s).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ") : s;
}

function output(items) {
  const all = NOTICES.concat(items);
  for (const it of all) {
    it.title = clean(it.title);
    it.subtitle = clean(it.subtitle);
    for (const m of Object.values(it.mods || {})) m.subtitle = clean(m.subtitle);
  }
  const out = { skipknowledge: true, items: all };
  if (RERUN) out.rerun = RERUN;
  // no unpaired surrogates anywhere (arg, text.copy…): Alfred rejects the whole JSON otherwise
  return JSON.stringify(out, (k, v) => (typeof v === "string" ? wellFormed(v) : v));
}

// Lookup tables keyed by user or API strings: no prototype, so "constructor" or "__proto__" find nothing.
function dict(o) {
  return Object.assign(Object.create(null), o);
}

function kw() {
  return env("keyword_race", "").trim() || "race";
}

// ---------- flags ----------

const NATIONALITY = dict({
  american: "US", "american-italian": "US", argentine: "AR", argentinian: "AR", "argentine-italian": "AR", australian: "AU",
  austrian: "AT", belgian: "BE", brazilian: "BR", british: "GB", canadian: "CA", chilean: "CL", chinese: "CN",
  colombian: "CO", czech: "CZ", danish: "DK", dutch: "NL", "east german": "DE", emirati: "AE", estonian: "EE",
  finnish: "FI", french: "FR", german: "DE", "hong kong": "HK", hungarian: "HU", indian: "IN", indonesian: "ID",
  irish: "IE", israeli: "IL", italian: "IT", japanese: "JP", liechtensteiner: "LI", malaysian: "MY", mexican: "MX",
  monegasque: "MC", moroccan: "MA", "new zealander": "NZ", polish: "PL", portuguese: "PT", rhodesian: "ZW",
  russian: "RU", "south african": "ZA", spanish: "ES", swedish: "SE", swiss: "CH", thai: "TH", uruguayan: "UY",
  venezuelan: "VE", korean: "KR", "south korean": "KR", saudi: "SA", qatari: "QA", singaporean: "SG",
});
const COUNTRY = dict({
  argentina: "AR", australia: "AU", austria: "AT", azerbaijan: "AZ", bahrain: "BH", belgium: "BE", brazil: "BR",
  canada: "CA", china: "CN", france: "FR", germany: "DE", hungary: "HU", india: "IN", italy: "IT", japan: "JP",
  korea: "KR", "south korea": "KR", malaysia: "MY", mexico: "MX", monaco: "MC", morocco: "MA", netherlands: "NL",
  portugal: "PT", qatar: "QA", russia: "RU", "saudi arabia": "SA", singapore: "SG", "south africa": "ZA",
  spain: "ES", sweden: "SE", switzerland: "CH", turkey: "TR", uae: "AE", "united arab emirates": "AE",
  uk: "GB", "united kingdom": "GB", "great britain": "GB", usa: "US", "united states": "US", vietnam: "VN",
  thailand: "TH", rwanda: "RW",
});

function flagOf(code) {
  if (!code || !/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(0x1f1e6 + code.charCodeAt(0) - 65, 0x1f1e6 + code.charCodeAt(1) - 65);
}
function natFlag(n) {
  return flagOf(NATIONALITY[fold(n)]);
}
function countryFlag(c) {
  return flagOf(COUNTRY[fold(c)]);
}
function withFlag(flag, text) {
  return flag ? `${flag} ${text}` : text;
}

function teamIcon(id) {
  const p = `icons/team-${id}.png`;
  return { path: exists(p) ? p : "icons/team-unknown.png" };
}

// ---------- time ----------

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The locale behind "Same as macOS": the region settings (read from the user defaults, so it works
// without LANG, as in Alfred's environment). F1_LOCALE overrides it for tests.
function userLocale() {
  const id = env("F1_LOCALE", "");
  return id ? $.NSLocale.localeWithLocaleIdentifier(id) : $.NSLocale.currentLocale;
}
// Date format pattern letters outside 'quoted literals'.
function patternLetters(p) {
  return String(p || "").replace(/'[^']*'/g, "");
}

function use12h() {
  const f = env("time_format", "system");
  if (f === "12") return true;
  if (f === "24") return false;
  try {
    // the short time style follows the 24-hour time switch in System Settings; its hour symbol says
    // which clock it uses (h/K = 12-hour, also with "B" day periods as in zh_TW or hi_IN, which have no "a")
    const df = $.NSDateFormatter.alloc.init;
    df.locale = userLocale();
    df.dateStyle = $.NSDateFormatterNoStyle;
    df.timeStyle = $.NSDateFormatterShortStyle;
    let p = patternLetters(df.dateFormat.js);
    if (!/[hHkK]/.test(p)) p = patternLetters($.NSDateFormatter.dateFormatFromTemplateOptionsLocale("j", 0, userLocale()).js);
    return /[hK]/.test(p);
  } catch (e) {
    return false;
  }
}
const H12 = use12h();

// "Fri 2 Oct" or "Fri Oct 2": the Workflow Configuration, or the macOS region's order.
function monthFirst() {
  const f = env("date_format", "system");
  if (f === "dmy") return false;
  if (f === "mdy") return true;
  try {
    const t = $.NSDateFormatter.dateFormatFromTemplateOptionsLocale("MMMd", 0, userLocale());
    if (t.isNil()) return false;
    const p = patternLetters(t.js);
    const m = p.search(/[ML]/), d = p.indexOf("d"); // "L" is the stand-alone month (fa_IR: "d LLL")
    return m >= 0 && d >= 0 && m < d;
  } catch (e) {
    return false;
  }
}
const MDY = monthFirst();

function pad(n) {
  return String(n).padStart(2, "0");
}
function fmtDay(d, withYear) {
  if (MDY) return `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}${withYear ? ", " + d.getFullYear() : ""}`;
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}${withYear ? " " + d.getFullYear() : ""}`;
}
function fmtTime(d) {
  if (!H12) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const h = d.getHours() % 12 || 12;
  return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
}
// A date-only session: "2026-10-02" is shown as that calendar day, no time-zone conversion.
function dateOnly(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}
function localDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function daysBetween(a, b) {
  const [y1, m1, d1] = a.split("-").map(Number), [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  if (d > 0) return `${plural(d, "day")}${h ? ` ${h} h` : ""}`;
  if (h > 0) return `${h} h${mi ? ` ${mi} min` : ""}`;
  return `${mi} min`;
}
function until(ms) {
  return ms < 60000 ? "in under a minute" : `in ${duration(ms)}`;
}
function ago(ms) {
  return ms < 60000 ? "just now" : `${duration(ms)} ago`;
}
function dayCountdown(dateStr) {
  const n = daysBetween(localDateStr(NOW), dateStr);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n > 1) return `in ${n} days`;
  return n === -1 ? "yesterday" : `${-n} days ago`;
}

// ---------- sessions ----------

// [API key, name, short name, icon, duration in minutes]
const SESSION_DEFS = [
  ["FirstPractice", "Practice 1", "FP1", "practice", 60],
  ["SecondPractice", "Practice 2", "FP2", "practice", 60],
  ["ThirdPractice", "Practice 3", "FP3", "practice", 60],
  ["SprintShootout", "Sprint Shootout", "SS", "quali", 45],
  ["SprintQualifying", "Sprint Qualifying", "SQ", "quali", 45],
  ["Sprint", "Sprint", "Sprint", "sprint", 60],
  ["Qualifying", "Qualifying", "Quali", "quali", 60],
  ["Race", "Race", "Race", "race", 120],
];
const RACE_OVER_MS = 3 * 3600 * 1000; // a race is "over" three hours after the start (red flags)

function parseStart(date, time) {
  if (!date || !time) return null;
  let t = String(time).trim();
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(t)) t += "Z";
  const d = new Date(`${date}T${t}`);
  return isNaN(d) ? null : d;
}

function sessionsOf(race) {
  const out = [];
  SESSION_DEFS.forEach(([key, name, short, icon, dur], i) => {
    const s = key === "Race" ? { date: race.date, time: race.time } : race[key];
    if (!s || !s.date) return;
    const start = parseStart(s.date, s.time);
    out.push({ key, name, short, icon, dur, date: s.date, start, order: i });
  });
  const sortVal = (s) => (s.start ? s.start.getTime() : Date.UTC(...s.date.split("-").map((v, j) => (j === 1 ? v - 1 : +v))) + 12 * 3600000);
  out.sort((a, b) => sortVal(a) - sortVal(b) || a.order - b.order);
  return out;
}

function sessionState(s) {
  if (s.start) {
    const t = NOW.getTime(), st = s.start.getTime();
    if (t < st) return "upcoming";
    if (t < st + s.dur * 60000) return "live";
    return "done";
  }
  const n = daysBetween(localDateStr(NOW), s.date);
  return n > 0 ? "upcoming" : n === 0 ? "today" : "done";
}

function hasStarted(s) {
  const st = sessionState(s);
  return st === "live" || st === "done" || st === "today";
}

function raceStart(race) {
  return parseStart(race.date, race.time);
}
function raceOver(race) {
  const st = raceStart(race);
  if (st) return NOW.getTime() > st.getTime() + RACE_OVER_MS;
  return daysBetween(localDateStr(NOW), race.date) < 0;
}
function isSprintWeekend(race) {
  return !!(race.Sprint);
}
function whenText(s, withYear) {
  if (s.start) return `${fmtDay(s.start, withYear)} ${fmtTime(s.start)}`;
  return `${fmtDay(dateOnly(s.date), withYear)} · time TBC`;
}

// ---------- links ----------

const F1_SLUGS = dict({
  albert_park: "australia", shanghai: "china", suzuka: "japan", bahrain: "bahrain", jeddah: "saudi-arabia",
  miami: "miami", imola: "emiliaromagna", monaco: "monaco", catalunya: "spain", villeneuve: "canada",
  red_bull_ring: "austria", silverstone: "great-britain", spa: "belgium", hungaroring: "hungary",
  zandvoort: "netherlands", monza: "italy", baku: "azerbaijan", marina_bay: "singapore", americas: "united-states",
  rodriguez: "mexico", interlagos: "brazil", vegas: "las-vegas", losail: "qatar", yas_marina: "united-arab-emirates",
  madring: "spain", ricard: "france", portimao: "portugal", istanbul: "turkey", sochi: "russia", mugello: "tuscany",
  nurburgring: "eifel", sepang: "malaysia", hockenheimring: "germany",
});

function f1Url(race) {
  let slug = F1_SLUGS[race.Circuit && race.Circuit.circuitId];
  if (race.Circuit && race.Circuit.circuitId === "catalunya" && /barcelona/i.test(race.raceName)) slug = "barcelona-catalunya";
  if (!slug || +race.season < 2018) return null;
  return `https://www.formula1.com/en/racing/${race.season}/${slug}`;
}
// Only plain http(s) links from the API (no whitespace or control characters: they end up in .ics files).
function safeUrl(u) {
  return /^https?:\/\/[^\s"<>\\\u0000-\u001f\u007f]+$/.test(u || "") ? u.replace(/^http:/, "https:") : "";
}
function wikiUrl(race) {
  return safeUrl(race.url) || null;
}
// [primary, alternative] race pages, following the Workflow Configuration
function racePages(race) {
  const f1 = f1Url(race), wiki = wikiUrl(race);
  const pref = env("race_page", "f1") === "wikipedia" ? [wiki, f1] : [f1, wiki];
  const list = pref.filter(Boolean);
  return [list[0] || null, list[1] || list[0] || null];
}
function pageName(url) {
  return /formula1\.com/.test(url || "") ? "formula1.com" : "Wikipedia";
}

// ---------- HTTP + cache ----------

// Run a command, return { status, out }.
function run_(path, args) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const outP = $.NSPipe.pipe;
  task.standardOutput = outP;
  task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
  if (!task.launchAndReturnError($())) return { status: -1, out: "" };
  const data = outP.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  const s = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return { status: task.terminationStatus, out: s.isNil() ? "" : s.js };
}

const CURL_ERRORS = { 6: "No internet connection (could not resolve the host)", 7: "Could not connect to the F1 API", 28: "The F1 API timed out", 35: "Secure connection failed", 52: "The F1 API returned nothing", 56: "The connection was interrupted" };

// ---------- rate limiting (shared by every process through the cache folder) ----------
// Jolpica allows 4 requests a second and 500 an hour. A keystroke storm (each keystroke runs a
// Script Filter) plus background refreshers must stay well below that, so every request reserves
// a slot in a small log: at most RATE_BURST requests per RATE_WINDOW and RATE_HOURLY in any hour.
// The window is longer than a second because network jitter can bunch requests together on arrival.
const RATE_BURST = 2;
const RATE_WINDOW = 1250; // ms
const RATE_HOURLY = 400;
const RATE_MAX_WAIT = 4000; // ms: give up (and show cached data) rather than queue for longer
const COOLDOWN = 60; // seconds without any request after an HTTP 429
const RATE_MSG = "The F1 API is rate limiting requests (HTTP 429): try again in a minute";

function mkdirExclusive(path) {
  return !!$.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, false, $(), $());
}

// Run fn while holding a short mutex (mkdir is atomic). A lock left by a killed process expires.
function withMutex(path, fn) {
  for (let i = 0; i < 200; i++) {
    if (mkdirExclusive(path)) {
      try {
        return fn();
      } finally {
        removeFile(path);
      }
    }
    const a = fileAge(path);
    if (a !== null && a > 3) removeFile(path);
    else $.NSThread.sleepForTimeInterval(0.01);
  }
  return undefined; // couldn't get the lock: callers treat this as busy rather than run unguarded
}

// Reserve a request slot. Returns null (go ahead) or { error, status }.
function throttle() {
  const dir = `${cacheDir()}/api`;
  const cool = fileAge(`${dir}/.cooldown`);
  if (cool !== null && cool < COOLDOWN) return { error: RATE_MSG, status: 429 };
  let wait = 0, err = { error: "Too many requests at once: try again in a few seconds", status: 429 };
  withMutex(`${dir}/.rate.lock`, () => {
    err = null;
    const t = Date.now();
    let log = [];
    try {
      log = JSON.parse(readFile(`${dir}/.rate.json`) || "[]");
      if (!Array.isArray(log)) log = [];
    } catch (e) {
      log = [];
    }
    log = log.filter((x) => typeof x === "number" && x > t - HOUR * 1000 && x < t + 60000).sort((a, b) => a - b);
    if (log.length >= RATE_HOURLY) {
      err = { error: "Hourly request limit reached: try again later", status: 429 };
      return;
    }
    let slot = Math.max(t, log.length ? log[log.length - 1] : 0);
    if (log.length >= RATE_BURST) slot = Math.max(slot, log[log.length - RATE_BURST] + RATE_WINDOW);
    if (slot - t > RATE_MAX_WAIT) {
      err = { error: "Too many requests at once: try again in a few seconds", status: 429 };
      return;
    }
    log.push(slot);
    writeFile(`${dir}/.rate.json`, JSON.stringify(log));
    wait = slot - t;
  });
  if (err) return err;
  if (wait > 0) $.NSThread.sleepForTimeInterval(wait / 1000);
  return null;
}

// One GET. Returns { data } (MRData) or { error, status }.
function httpGet(url) {
  if (!/^https?:\/\//.test(url)) return { error: "Test mode: F1_API_BASE is not set", status: 0 };
  const blocked = throttle();
  if (blocked) return blocked;
  const r = run_("/usr/bin/curl", ["-sS", "-L", "--compressed", "--connect-timeout", "4", "--max-time", "12", "-A", UA, "-H", "Accept: application/json", "-w", "\n%{http_code}", url]);
  if (r.status !== 0) return { error: CURL_ERRORS[r.status] || `Network error (curl ${r.status})`, status: 0 };
  const cut = r.out.lastIndexOf("\n");
  const code = +r.out.slice(cut + 1), body = r.out.slice(0, cut);
  if (code === 429) {
    writeFile(`${cacheDir()}/api/.cooldown`, String(Date.now()));
    return { error: RATE_MSG, status: 429 };
  }
  if (code !== 200) return { error: `The F1 API returned HTTP ${code}`, status: code };
  try {
    const j = JSON.parse(body);
    if (!j || !j.MRData) throw new Error("no MRData");
    return { data: j.MRData };
  } catch (e) {
    return { error: "Unexpected response from the F1 API", status: code };
  }
}

// Merge a following page into the first (races split across pages keep one entry).
function mergePage(a, b) {
  if (a.RaceTable && b.RaceTable) {
    const ra = a.RaceTable.Races, rb = b.RaceTable.Races || [];
    for (const r of rb) {
      const last = ra[ra.length - 1];
      if (last && last.season === r.season && last.round === r.round) {
        for (const k of Object.keys(r)) if (Array.isArray(r[k])) last[k] = (last[k] || []).concat(r[k]);
      } else ra.push(r);
    }
  }
  if (a.StandingsTable && b.StandingsTable) {
    const la = a.StandingsTable.StandingsLists, lb = b.StandingsTable.StandingsLists || [];
    for (const l of lb) {
      const last = la[la.length - 1];
      if (last && last.season === l.season) {
        for (const k of Object.keys(l)) if (Array.isArray(l[k])) last[k] = (last[k] || []).concat(l[k]);
      } else la.push(l);
    }
  }
}

// Fetch every page of an endpoint (at most 10; throttle() spaces the requests).
// deadline (ms since the epoch) bounds a background refresh, so it always ends before its lock expires.
function fetchAll(path, deadline) {
  const first = httpGet(`${API_BASE}/${path}/?limit=${PAGE}`);
  if (first.error) return first;
  const total = +first.data.total || 0;
  const step = +first.data.limit || PAGE; // the API may cap the page size below what was asked
  for (let off = step, n = 1; off < total && n < 10; off += step, n++) {
    if (deadline && Date.now() > deadline) return { error: "The F1 API timed out", status: 0 };
    const p = httpGet(`${API_BASE}/${path}/?limit=${step}&offset=${off}`);
    if (p.error) return p;
    mergePage(first.data, p.data);
  }
  return first;
}

function cacheFile(path) {
  return `${cacheDir()}/api/${path.replace(/[^A-Za-z0-9]+/g, "_")}.json`;
}

function refreshNow(path, deadline) {
  const file = cacheFile(path);
  const r = fetchAll(path, deadline);
  if (r.data) {
    writeFile(file, JSON.stringify(r.data));
    removeFile(`${file}.attempt`);
    pruneCache(false);
  }
  return r;
}

// A background refresh holds `<file>.lock` (a folder: mkdir is atomic, so two Script Filters
// can never both start one). It stops fetching after BG_DEADLINE, and a lock older than
// LOCK_TTL (left by a refresher that was killed) is taken over.
const LOCK_TTL = 90; // seconds
const BG_DEADLINE = 60; // seconds; plus one curl --max-time (12 s) is still < LOCK_TTL

function takeLock(lock) {
  if (mkdirExclusive(lock)) return true;
  const a = fileAge(lock);
  if (a === null || a < LOCK_TTL) return false;
  removeFile(lock);
  return mkdirExclusive(lock);
}

// Refresh a stale cache entry in a separate process, so Alfred shows the cached data at once.
// NSTask starts the child in its own process group and it is reparented to launchd when the
// Script Filter exits, so Alfred terminating the Script Filter on the next keystroke (SIGTERM
// to the process or its group) doesn't stop the refresh; stdio go to /dev/null, so Alfred
// doesn't wait for it either.
function refreshInBackground(path) {
  const file = cacheFile(path);
  const lock = `${file}.lock`;
  if (!takeLock(lock)) return; // another process is already refreshing this entry
  writeFile(`${file}.attempt`, JSON.stringify({ status: 0, error: "The update was interrupted" }));
  const script = `${$.NSFileManager.defaultManager.currentDirectoryPath.js}/f1.js`;
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath("/usr/bin/osascript");
  task.arguments = ["-l", "JavaScript", script, "refresh", path];
  task.standardOutput = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
  if (!task.launchAndReturnError($())) removeFile(lock);
}

// Background entry point: fetch, then record the outcome for the next Script Filter run.
function backgroundRefresh(path) {
  const file = cacheFile(path);
  try {
    const r = refreshNow(path, Date.now() + BG_DEADLINE * 1000);
    if (r.error) writeFile(`${file}.attempt`, JSON.stringify({ status: r.status, error: r.error }));
    else removeFile(`${file}.attempt`);
  } finally {
    removeFile(`${file}.lock`);
  }
  return "";
}

// Keep the cache small: once a day, drop API responses nobody has needed for 60 days (anything
// read after its TTL is rewritten by a refresh), keep at most CACHE_MAX_FILES of them, and remove
// calendar files, stale locks and old failure records.
const CACHE_MAX_AGE = 60 * DAY;
const CACHE_MAX_FILES = 300;

function listDir(dir) {
  const a = $.NSFileManager.defaultManager.contentsOfDirectoryAtPathError(dir, $());
  return a.isNil() ? [] : ObjC.deepUnwrap(a) || [];
}

function pruneCache(force) {
  const root = cacheDir();
  const marker = `${root}/.pruned`;
  const last = fileAge(marker);
  if (!force && last !== null && last < DAY) return;
  writeFile(marker, "");
  const api = `${root}/api`;
  const data = [];
  for (const name of listDir(api)) {
    const p = `${api}/${name}`;
    const a = fileAge(p);
    if (a === null) continue;
    if (/\.json$/.test(name) && !name.startsWith(".")) {
      if (a > CACHE_MAX_AGE) removeFile(p);
      else data.push([a, p]);
    } else if (/\.json\.attempt$/.test(name) && a > DAY) removeFile(p);
    else if (/\.json\.lock$/.test(name) && a > LOCK_TTL) removeFile(p);
  }
  data.sort((x, y) => x[0] - y[0]);
  for (const [, p] of data.slice(CACHE_MAX_FILES)) removeFile(p);
  const ics = `${root}/ics`;
  for (const name of listDir(ics)) {
    const a = fileAge(`${ics}/${name}`);
    if (a !== null && a > DAY) removeFile(`${ics}/${name}`);
  }
}

function staleNotice(age, error, status) {
  const title = status ? `Couldn’t update: showing data from ${ago(age * 1000)}` : `Offline: showing data from ${ago(age * 1000)}`;
  const n = info(title, `${error || "Could not update"} · Updates when the F1 API is reachable`, "offline");
  if (!NOTICES.some((x) => x.icon.path === "icons/offline.png")) NOTICES.push(n);
}

// Cached GET: fresh cache → cached data; stale → cached data + background refresh; none → fetch now.
// Returns { data } or { error }.
function api(path, ttl, season) {
  const file = cacheFile(path);
  const age = fileAge(file);
  // a past season's long TTL only holds for data fetched after that season ended (not, say, standings
  // cached before its final race)
  if (season && ttl > HOUR && age !== null && Date.now() - age * 1000 < Date.UTC(season + 1, 0, 1)) ttl = HOUR;
  const cached = age === null ? null : readFile(file);
  let data = null;
  if (cached) {
    try {
      data = JSON.parse(cached);
    } catch (e) {
      data = null;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) data = null; // corrupt: fetch again
  }
  if (data && age < ttl) return { data };
  if (data) {
    const lockAge = fileAge(`${file}.lock`);
    const attemptAge = fileAge(`${file}.attempt`);
    if (lockAge !== null && lockAge < LOCK_TTL) {
      RERUN = 0.5;
      return { data, refreshing: true };
    }
    if (attemptAge !== null && attemptAge < RETRY_AFTER) {
      // the last refresh finished without updating the cache: it failed
      const a = lastAttempt(file);
      staleNotice(age, a.error, a.status);
      return { data, stale: true };
    }
    if (env("F1_SYNC", "") === "1") {
      const r = refreshNow(path);
      if (r.data) return { data: r.data };
      staleNotice(age, r.error, r.status);
      return { data, stale: true };
    }
    refreshInBackground(path);
    RERUN = 0.5;
    return { data, refreshing: true };
  }
  // nothing cached: fetch now, but don't retry a failure on every keystroke
  const attemptAge = fileAge(`${file}.attempt`);
  if (attemptAge !== null && attemptAge < 10) {
    const a = lastAttempt(file);
    if (a.error) return a;
  }
  const r = refreshNow(path);
  if (r.error) writeFile(`${file}.attempt`, JSON.stringify({ status: r.status, error: r.error }));
  return r;
}

function lastAttempt(file) {
  try {
    const a = JSON.parse(readFile(`${file}.attempt`) || "{}");
    return { status: a.status || 0, error: a.error || "" };
  } catch (e) {
    return { status: 0, error: "" };
  }
}

// ---------- data access ----------

function errorItems(r, what) {
  const offline = r.status === 0;
  const hint = /try again/i.test(r.error || "") ? "" : offline ? " · Check your connection, then type again" : " · Try again in a few minutes";
  return [
    info(offline ? "Can’t reach the Formula 1 API" : `Couldn’t load ${what}`, `${r.error}${hint}`, offline ? "offline" : "error"),
  ];
}

function pastSeason(year) {
  return year < THIS_YEAR;
}

function schedule(year) {
  const r = api(`${year}/races`, pastSeason(year) ? 30 * DAY : DAY, year);
  if (r.error) return r;
  return { races: (r.data.RaceTable && r.data.RaceTable.Races) || [] };
}

// Results change often around a race: refresh every 10 minutes from the first session
// of a weekend until a day after its race; otherwise every 6 hours.
function hot(races) {
  const t = NOW.getTime();
  return races.some((race) => {
    const ss = sessionsOf(race);
    const first = ss.find((s) => s.start) || null;
    const st = raceStart(race);
    const from = first ? first.start.getTime() : Date.UTC(...race.date.split("-").map((v, j) => (j === 1 ? v - 1 : +v))) - 3 * DAY * 1000;
    const to = (st ? st.getTime() : Date.UTC(...race.date.split("-").map((v, j) => (j === 1 ? v - 1 : +v))) + DAY * 1000) + DAY * 1000;
    return t >= from && t <= to;
  });
}

function resultsTtl(year, races, empty) {
  if (pastSeason(year) && !empty) return 30 * DAY;
  if (empty) return 10 * MIN;
  return hot(races || []) ? 10 * MIN : 6 * HOUR;
}

const RESULT_KEYS = { results: "Results", qualifying: "QualifyingResults", sprint: "SprintResults" };

function cachedJSON(path) {
  const txt = readFile(cacheFile(path));
  if (!txt) return null;
  try {
    const j = JSON.parse(txt);
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch (e) {
    return null;
  }
}

function sessionResults(year, round, kind, races) {
  const path = `${year}/${round}/${kind}`;
  // an empty response means the results aren't published yet: re-check it every 10 minutes
  const c = cachedJSON(path);
  const empty = !!(c && c.RaceTable && !(c.RaceTable.Races || []).length);
  const r = api(path, resultsTtl(year, races, empty), year);
  if (r.error) return r;
  const race = (r.data.RaceTable && r.data.RaceTable.Races || [])[0];
  return { race: race || null, rows: race ? race[RESULT_KEYS[kind]] || [] : [] };
}

function standings(year, which) {
  const path = `${year}/${which}standings`;
  const c = cachedJSON(path);
  const empty = !!(c && c.StandingsTable && !(c.StandingsTable.StandingsLists || []).length);
  const r = api(path, empty ? 10 * MIN : pastSeason(year) ? 30 * DAY : HOUR, year);
  if (r.error) return r;
  const lists = (r.data.StandingsTable && r.data.StandingsTable.StandingsLists) || [];
  const l = lists[lists.length - 1];
  const key = which === "driver" ? "DriverStandings" : "ConstructorStandings";
  return { season: l ? +l.season : year, round: l ? +l.round : 0, rows: l ? l[key] || [] : [] };
}

// ---------- menu ----------

const COMMANDS = [
  ["drivers", "Driver Standings", "Points, wins, teams and the gap to the leader", "drivers"],
  ["teams", "Team Standings", "Constructors’ championship", "teams"],
  ["results", "Race Results", "Last race classification with the fastest lap; add a round number", "results"],
  ["quali", "Qualifying", "Last qualifying with Q1, Q2 and Q3 times", "quali"],
  ["sprint", "Sprint Results", "Last sprint classification", "sprint"],
  ["schedule", "Season Schedule", "Every round with winners and upcoming races", "calendar"],
];
const ALIASES = dict({
  drivers: "drivers", driver: "drivers", wdc: "drivers", standings: "drivers",
  teams: "teams", team: "teams", constructors: "teams", constructor: "teams", wcc: "teams",
  results: "results", result: "results", res: "results", winner: "results",
  quali: "quali", qualifying: "quali", qualy: "quali", grid: "quali",
  sprint: "sprint", sprints: "sprint",
  schedule: "schedule", calendar: "schedule", cal: "schedule", season: "schedule", races: "schedule",
  next: "next",
});

function menuItems(year, filter) {
  const pre = year ? `${year} ` : "";
  const f = fold(filter);
  return COMMANDS.filter(([k, name]) => !f || k.startsWith(f) || fold(name).startsWith(f) || fold(name).split(" ").some((w) => w.startsWith(f)))
    .map(([k, name, sub, icon]) => ({
      title: year ? `${year} ${name}` : name,
      subtitle: `${sub} · ${kw()} ${pre}${k}`,
      autocomplete: `${pre}${k} `,
      valid: false,
      icon: { path: `icons/${icon}.png` },
    }));
}

// ---------- next race weekend ----------

function roundText(race, races) {
  const contiguous = races.length && +races[races.length - 1].round === races.length;
  return `Round ${race.round}${contiguous ? ` of ${races.length}` : ""}`;
}

function raceHeader(race, races, sessions) {
  const [page, alt] = racePages(race);
  const flag = countryFlag(race.Circuit.Location.country);
  const loc = [race.Circuit.circuitName, race.Circuit.Location.locality].filter(Boolean).join(", ");
  const live = sessions.find((s) => sessionState(s) === "live");
  const next = sessions.find((s) => sessionState(s) === "upcoming" || sessionState(s) === "today");
  let status = "";
  if (live) status = `🔴 ${live.name} live now`;
  else if (next) status = `${next.name} ${next.start ? until(next.start.getTime() - NOW.getTime()) : dayCountdown(next.date) + " (time TBC)"}`;
  else status = "Race finished";
  const parts = [roundText(race, races), loc];
  if (isSprintWeekend(race)) parts.push("Sprint weekend");
  parts.push(status);
  const copy = [`${race.raceName} (${race.season}, round ${race.round})`, loc].concat(sessions.map((s) => `${s.name}: ${whenText(s)}`)).join("\n");
  return {
    title: withFlag(flag, race.raceName),
    subtitle: parts.join(" · "),
    arg: page ? `open:${page}` : "",
    valid: !!page,
    quicklookurl: page || undefined,
    text: { copy, largetype: copy },
    icon: { path: "icons/race.png" },
    mods: {
      cmd: { arg: `ics:${race.season}:${race.round}:all`, valid: true, subtitle: "Add every session of the weekend to Calendar" },
      alt: { arg: alt ? `open:${alt}` : "", valid: !!alt, subtitle: alt ? `Open on ${pageName(alt)}` : "No other page" },
    },
  };
}

function sessionItem(race, s, withYear) {
  const [page, alt] = racePages(race);
  const state = sessionState(s);
  let sub;
  if (state === "live") sub = `🔴 Live now · started ${ago(NOW.getTime() - s.start.getTime())}`;
  else if (state === "done") sub = "Finished";
  else if (s.start) sub = until(s.start.getTime() - NOW.getTime());
  else sub = `${dayCountdown(s.date)} · time to be confirmed`;
  if (s.key === "Race" && state !== "done") sub += ` · ${race.Circuit.circuitName}`;
  const text = `${race.raceName} ${s.name}: ${whenText(s, withYear)}`;
  const done = state === "done";
  return {
    title: `${s.name}  ·  ${whenText(s, withYear)}`,
    subtitle: sub,
    arg: page ? `open:${page}` : "",
    valid: !!page,
    quicklookurl: page || undefined,
    text: { copy: text, largetype: text },
    icon: { path: `icons/${done ? "done" : state === "live" ? "live" : s.icon}.png` },
    mods: {
      cmd: done
        ? { arg: "", valid: false, subtitle: "This session has finished" }
        : { arg: `ics:${race.season}:${race.round}:${s.key}`, valid: true, subtitle: `Add ${s.name} to Calendar` },
      alt: { arg: alt ? `open:${alt}` : "", valid: !!alt, subtitle: alt ? `Open on ${pageName(alt)}` : "No other page" },
    },
  };
}

function nextRaceItems() {
  let sch = schedule(THIS_YEAR);
  if (sch.error) return errorItems(sch, "the schedule").concat(menuItems(null, ""));
  let races = sch.races;
  let race = races.find((r) => !raceOver(r));
  if (!races.length) {
    // January: this season's calendar isn't out yet; point at last season's final race
    const prev = schedule(THIS_YEAR - 1);
    const items = [info("Off-season: no upcoming races", `The ${THIS_YEAR} calendar hasn’t been published yet`, "season")];
    const last = !prev.error && prev.races[prev.races.length - 1];
    if (last) items.push(info(`Last race: ${withFlag(countryFlag(last.Circuit.Location.country), last.raceName)}`, `${fmtDay(dateOnly(last.date), true)} · Tab for the results`, "results", { autocomplete: `${last.season} results ${last.round} ` }));
    return items.concat(menuItems(null, ""));
  }
  if (!race) {
    const nxt = schedule(THIS_YEAR + 1);
    if (!nxt.error && nxt.races.length) {
      races = nxt.races;
      race = races.find((r) => !raceOver(r));
    }
  }
  if (!race) {
    const items = [info("Off-season: no upcoming races", `The ${THIS_YEAR + 1} calendar hasn’t been published yet`, "season")];
    const last = sch.races[sch.races.length - 1];
    if (last) items.push(info(`Last race: ${withFlag(countryFlag(last.Circuit.Location.country), last.raceName)}`, `${fmtDay(dateOnly(last.date), true)} · Tab for the results`, "results", { autocomplete: `${last.season} results ${last.round} ` }));
    return items.concat(menuItems(null, ""));
  }
  const sessions = sessionsOf(race);
  const withYear = +race.season !== THIS_YEAR;
  return [raceHeader(race, races, sessions)].concat(sessions.map((s) => sessionItem(race, s, withYear)), menuItems(null, ""));
}

// ---------- standings ----------

function driverName(d) {
  return `${d.givenName} ${d.familyName}`;
}

function driverStandingItems(year, filter) {
  let st = standings(year, "driver");
  let note = null;
  if (!st.error && !st.rows.length && year === THIS_YEAR) {
    note = info(`The ${year} season hasn’t started yet`, `Showing the final ${year - 1} standings`, "info");
    st = standings(year - 1, "driver");
    year -= 1;
  }
  if (st.error) return errorItems(st, "the driver standings");
  if (!st.rows.length) return [info(`No driver standings for ${year}`, "The season may not have started yet", "info")];
  const leader = +st.rows[0].points;
  const second = st.rows[1] ? +st.rows[1].points : leader;
  const table = st.rows.map((r) => `${r.positionText || r.position}. ${driverName(r.Driver)} (${(r.Constructors || []).map((c) => c.name).join(", ")}) ${ptsText(+r.points)}`).join("\n");
  const f = fold(filter).trim();
  const items = [];
  if (note) items.push(note);
  const final = isFinal(year, st.round);
  items.push({
    title: `${year} Drivers’ Championship`,
    subtitle: `${final ? "Final standings" : `After round ${st.round}`} · ⌘↩ copies the table`,
    arg: `copy:${table}`,
    valid: true,
    text: { copy: table, largetype: table },
    icon: { path: "icons/drivers.png" },
    mods: { cmd: { arg: `copy:${table}`, valid: true, subtitle: "Copy the standings table" } },
  });
  const rows = st.rows.filter((r) => {
    if (!f) return true;
    const hay = fold([driverName(r.Driver), r.Driver.code, r.Driver.permanentNumber, r.Driver.nationality, ...(r.Constructors || []).map((c) => c.name)].join(" "));
    return f.split(/\s+/).every((w) => hay.includes(w));
  });
  if (!rows.length) items.push(info(`No driver matches “${filter.trim()}”`, "Search by name, code, number, nationality or team"));
  for (const r of rows) {
    const d = r.Driver, teams = r.Constructors || [];
    const current = teams[teams.length - 1];
    const pts = +r.points;
    const pos = /^\d+$/.test(r.positionText || "") ? r.positionText : r.position || "–";
    const gap = gapText(pos, pts, leader, second, st.rows.length);
    const teamText = teams.map((c) => c.name).join(" → ");
    // permanentNumber is the driver's number today, so only show it for the current season
    const num = d.permanentNumber && year >= THIS_YEAR ? `  #${d.permanentNumber}` : "";
    const title = `${pos}. ${withFlag(natFlag(d.nationality), driverName(d))}${num}`;
    const text = `${pos}. ${driverName(d)} (${teamText}) ${ptsText(+r.points)}, ${plural(+r.wins, "win")}`;
    const url = safeUrl(d.url);
    items.push({
      title: r.positionText === "D" ? `DSQ ${withFlag(natFlag(d.nationality), driverName(d))}` : title,
      subtitle: `${ptsText(pts)} · ${plural(+r.wins, "win")} · ${teamText || "—"} · ${gap}`,
      arg: url ? `open:${url}` : "",
      valid: !!url,
      quicklookurl: url || undefined,
      text: { copy: text, largetype: text },
      icon: current ? teamIcon(current.constructorId) : { path: "icons/team-unknown.png" },
      mods: { cmd: { arg: `copy:${table}`, valid: true, subtitle: "Copy the standings table" } },
    });
  }
  return items;
}

function fmtPts(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}
function ptsText(n) {
  return `${fmtPts(n)} ${n === 1 ? "pt" : "pts"}`;
}
// "leads by 12" / "−40 to the leader" / "level on points"
function gapText(pos, pts, leader, second, count) {
  if (count < 2) return "leader";
  if (pos === "1") return pts === second ? "level on points" : `leads by ${fmtPts(pts - second)}`;
  if (pts === leader) return "level on points with the leader";
  return `−${fmtPts(leader - pts)} to the leader`;
}

// A season's standings are final once the last scheduled round is in (only if the schedule is cached).
function isFinal(year, round) {
  if (year > THIS_YEAR) return false;
  const path = `${year}/races`;
  const txt = readFile(cacheFile(path));
  if (!txt) return pastSeason(year);
  try {
    const races = JSON.parse(txt).RaceTable.Races;
    return races.length > 0 && round >= +races[races.length - 1].round;
  } catch (e) {
    return pastSeason(year);
  }
}

function teamStandingItems(year, filter) {
  let st = standings(year, "constructor");
  let note = null;
  if (!st.error && !st.rows.length && year === THIS_YEAR) {
    const prev = standings(year - 1, "constructor");
    if (!prev.error && prev.rows.length) {
      note = info(`The ${year} season hasn’t started yet`, `Showing the final ${year - 1} standings`, "info");
      st = prev;
      year -= 1;
    }
  }
  if (st.error) return errorItems(st, "the team standings");
  if (!st.rows.length) return [info(`No team standings for ${year}`, year < 1958 ? "The constructors’ championship started in 1958" : "The season may not have started yet", "info")];
  const drivers = standings(year, "driver");
  const byTeam = Object.create(null);
  if (!drivers.error) {
    for (const r of drivers.rows) {
      for (const c of r.Constructors || []) (byTeam[c.constructorId] = byTeam[c.constructorId] || []).push(r.Driver.familyName);
    }
  }
  const leader = +st.rows[0].points;
  const second = st.rows[1] ? +st.rows[1].points : leader;
  const table = st.rows.map((r) => `${r.positionText || r.position}. ${r.Constructor.name} ${ptsText(+r.points)}`).join("\n");
  const items = [];
  if (note) items.push(note);
  items.push({
    title: `${year} Constructors’ Championship`,
    subtitle: `${isFinal(year, st.round) ? "Final standings" : `After round ${st.round}`} · ⌘↩ copies the table`,
    arg: `copy:${table}`,
    valid: true,
    text: { copy: table, largetype: table },
    icon: { path: "icons/teams.png" },
    mods: { cmd: { arg: `copy:${table}`, valid: true, subtitle: "Copy the standings table" } },
  });
  const f = fold(filter).trim();
  const rows = st.rows.filter((r) => !f || f.split(/\s+/).every((w) => fold([r.Constructor.name, r.Constructor.nationality, ...(byTeam[r.Constructor.constructorId] || [])].join(" ")).includes(w)));
  if (!rows.length) items.push(info(`No team matches “${filter.trim()}”`, "Search by team, nationality or driver"));
  for (const r of rows) {
    const c = r.Constructor, pts = +r.points;
    const pos = /^\d+$/.test(r.positionText || "") ? r.positionText : r.position || "–";
    const gap = gapText(pos, pts, leader, second, st.rows.length);
    const ds = byTeam[c.constructorId] || [];
    const text = `${pos}. ${c.name} ${ptsText(+r.points)}, ${plural(+r.wins, "win")}`;
    const url = safeUrl(c.url);
    items.push({
      title: `${pos}. ${withFlag(natFlag(c.nationality), c.name)}`,
      subtitle: [ptsText(pts), plural(+r.wins, "win"), ds.join(", "), gap].filter(Boolean).join(" · "),
      arg: url ? `open:${url}` : "",
      valid: !!url,
      quicklookurl: url || undefined,
      text: { copy: text, largetype: text },
      icon: teamIcon(c.constructorId),
      mods: { cmd: { arg: `copy:${table}`, valid: true, subtitle: "Copy the standings table" } },
    });
  }
  return items;
}

// ---------- results ----------

const KINDS = {
  results: { label: "Race", session: "Race", icon: "results" },
  qualifying: { label: "Qualifying", session: "Qualifying", icon: "quali" },
  sprint: { label: "Sprint", session: "Sprint", icon: "sprint" },
};
const STATUS_CODES = dict({ R: "DNF", D: "DSQ", E: "EX", W: "DNS", F: "DNQ", N: "NC" });

function lapMs(t) {
  // "1:42.526" or "42.526" → milliseconds
  const m = String(t || "").match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? Math.round(((+m[1] || 0) * 60 + +m[2]) * 1000) : null;
}
function fmtGap(ms) {
  return `+${(ms / 1000).toFixed(3)}`;
}

function kindSession(race, kind) {
  const key = KINDS[kind].session;
  return sessionsOf(race).find((s) => s.key === key || (kind === "sprint" && s.key === "Sprint")) || null;
}

function parseResultArgs(rest, kind) {
  let round = null;
  const words = [];
  for (const w of rest) {
    const l = fold(w);
    if (/^\d{1,2}$/.test(l)) round = +l;
    else if (["quali", "qualifying", "qualy", "q", "grid"].includes(l)) kind = "qualifying";
    else if (["sprint", "sprints"].includes(l)) kind = "sprint";
    else if (["race", "results", "result", "gp"].includes(l)) kind = "results";
    else if (l !== "last" && l !== "round") words.push(l);
  }
  return { round, kind, text: words.join(" ") };
}

function matchRace(races, text) {
  const f = fold(text);
  return races.find((r) => fold([r.raceName, r.Circuit.circuitName, r.Circuit.circuitId, r.Circuit.Location.locality, r.Circuit.Location.country].join(" ")).includes(f)) || null;
}

function resultItems(year, rest, kind, yearGiven) {
  const args = parseResultArgs(rest, kind);
  kind = args.kind;
  const K = KINDS[kind];
  const sch = schedule(year);
  if (sch.error) return errorItems(sch, "the schedule");
  const races = sch.races;
  if (!races.length) return [info(`No races in ${year}`, year > THIS_YEAR ? "The calendar hasn’t been published yet" : "", "info")];
  let race = null;
  const notes = [];
  if (args.text) {
    race = matchRace(races, args.text);
    if (!race) return [info(`No ${year} race matches “${args.text}”`, "Try a round number, race, circuit, city or country")].concat(scheduleShortList(races, year, kind));
  } else if (args.round !== null) {
    race = races.find((r) => +r.round === args.round);
    if (!race) return [info(`${year} has no round ${args.round}`, `Rounds 1 to ${races[races.length - 1].round}`)];
  }
  const explicit = !!race;
  let candidates;
  if (explicit) candidates = [race];
  else {
    // latest weekends where this session has started, newest first
    candidates = races.filter((r) => {
      const s = kindSession(r, kind);
      return s && hasStarted(s);
    }).reverse();
    if (!candidates.length) {
      const first = races.find((r) => kindSession(r, kind));
      if (!yearGiven && year === THIS_YEAR && year > 1950) {
        const s0 = first && kindSession(first, kind);
        const note = info(`No ${K.label.toLowerCase()} yet in ${year}`, s0 ? `Showing ${year - 1} · First ${year}: ${first.raceName} ${whenText(s0)}` : `Showing ${year - 1}`, "info");
        return [note].concat(resultItems(year - 1, rest, kind, true));
      }
      if (!first) return [info(`No ${K.label.toLowerCase()} results in ${year}`, kind === "sprint" ? "No sprint weekends that season" : "", "info")];
      const s = kindSession(first, kind);
      return [info(`No ${K.label.toLowerCase()} yet in ${year}`, `First: ${first.raceName} ${whenText(s)}`, "info")].concat(menuItems(year === THIS_YEAR ? null : year, ""));
    }
  }
  let res = null, picked = null;
  for (const [i, r] of candidates.slice(0, 3).entries()) {
    const s = kindSession(r, kind);
    if (!s) {
      return [info(`${r.raceName} had no sprint`, "Sprint weekends have Sprint Qualifying and a Sprint on Saturday", "info")].concat(switchItems(year, r, races));
    }
    if (!hasStarted(s)) {
      return [info(`${r.raceName} ${K.label.toLowerCase()} hasn’t happened yet`, `${whenText(s)} · ${s.start ? until(s.start.getTime() - NOW.getTime()) : dayCountdown(s.date)}`, "calendar")].concat(switchItems(year, r, races));
    }
    res = sessionResults(year, r.round, kind, races);
    if (res.error) return errorItems(res, "the results");
    if (res.rows.length) {
      picked = r;
      break;
    }
    notes.push(info(`${r.raceName} ${K.label.toLowerCase()} results aren’t published yet`, explicit ? "They usually appear within a few hours: try again later" : i < 2 ? "Showing the previous round" : "", "info"));
    if (explicit) return notes.concat(switchItems(year, r, races));
  }
  if (!picked) return notes.length ? notes : [info("No results found", "", "info")];
  return notes.concat(classification(picked, res, kind, races, year));
}

function classification(race, res, kind, races, year) {
  const K = KINDS[kind];
  const [page] = racePages(race);
  const rows = res.rows;
  const flag = countryFlag(race.Circuit.Location.country);
  const winner = rows[0];
  const withYear = +race.season !== THIS_YEAR;
  const s = kindSession(race, kind);
  const when = s ? (s.start ? fmtDay(s.start, withYear) : fmtDay(dateOnly(s.date), withYear)) : fmtDay(dateOnly(race.date), withYear);
  const fl = rows.find((r) => r.FastestLap && r.FastestLap.rank === "1");
  const winnerLaps = winner ? +winner.laps : 0;
  const poleMs = kind === "qualifying" && winner ? lapMs(winner.Q3 || winner.Q2 || winner.Q1) : null;

  const lines = [];
  const items = [];
  const rowItems = rows.map((r) => {
    const d = r.Driver, c = r.Constructor || {};
    const pt = r.positionText || r.position;
    const pos = /^\d+$/.test(pt) ? `${pt}.` : STATUS_CODES[pt] || pt;
    const name = withFlag(natFlag(d.nationality), driverName(d));
    const parts = [c.name];
    let summary;
    if (kind === "qualifying") {
      const best = r.Q3 || r.Q2 || r.Q1;
      const seg = r.Q3 ? "Q3" : r.Q2 ? "Q2" : r.Q1 ? "Q1" : "";
      const bestMs = lapMs(best);
      summary = best ? `${seg} ${best}` : "No time";
      parts.push(summary);
      if (r.position !== "1" && bestMs && poleMs && seg === "Q3") parts.push(fmtGap(bestMs - poleMs));
      const others = [["Q2", r.Q2], ["Q1", r.Q1]].filter(([q, t]) => t && q !== seg).map(([q, t]) => `${q} ${t}`);
      if (others.length) parts.push(others.join(", "));
    } else {
      const lapped = +r.laps < winnerLaps && /^(Finished|Lapped|\+\d+ Laps?)$/.test(r.status || "");
      if (/^\d+$/.test(pt) && lapped) summary = `+${plural(winnerLaps - +r.laps, "lap")}`;
      else if (/^\d+$/.test(pt) && r.Time && r.Time.time) summary = r.Time.time;
      else if (/^\d+$/.test(pt)) summary = r.status || "";
      else {
        // retired cars sometimes keep a "Finished"/"Lapped" status: say what the position code means
        const st = !r.status || /^(Finished|Lapped|\+\d+ Laps?)$/.test(r.status) ? dict({ DNF: "Retired", DSQ: "Disqualified", DNS: "Did not start", NC: "Not classified", EX: "Excluded", DNQ: "Did not qualify" })[STATUS_CODES[pt]] || r.status || "" : r.status;
        summary = `${st}${r.laps && +r.laps > 0 ? ` (lap ${r.laps})` : ""}`;
      }
      parts.push(summary);
      if (+r.points > 0) parts.push(`+${ptsText(+r.points)}`);
      const grid = +r.grid;
      if (r.grid !== undefined) {
        if (grid === 0) parts.push("pit lane start");
        else if (/^\d+$/.test(pt)) {
          const delta = grid - +pt;
          parts.push(`grid ${grid}${delta > 0 ? ` ▲${delta}` : delta < 0 ? ` ▼${-delta}` : ""}`);
        } else parts.push(`grid ${grid}`);
      }
      if (r.FastestLap && r.FastestLap.rank === "1") parts.push(`⏱ fastest lap ${r.FastestLap.Time ? r.FastestLap.Time.time : ""}`.trim());
    }
    lines.push(`${pos} ${driverName(d)} (${c.name}) ${summary}`);
    const url = safeUrl(d.url);
    const text = `${pos} ${driverName(d)}, ${parts.join(", ")}`;
    return {
      title: `${pos} ${name}`,
      subtitle: parts.filter(Boolean).join(" · "),
      arg: url ? `open:${url}` : "",
      valid: !!url,
      quicklookurl: url || undefined,
      text: { copy: text, largetype: text },
      icon: teamIcon(c.constructorId),
    };
  });
  const table = `${race.raceName} ${race.season} (${K.label})\n${lines.join("\n")}`;
  for (const it of rowItems) it.mods = { cmd: { arg: `copy:${table}`, valid: true, subtitle: "Copy the classification" } };
  const head = [`Round ${race.round}`, when];
  if (winner) head.push(`${kind === "qualifying" ? "Pole" : "Winner"} ${winner.Driver.familyName}`);
  if (fl && kind !== "qualifying") head.push(`Fastest lap ${fl.Driver.familyName}${fl.FastestLap.Time ? ` ${fl.FastestLap.Time.time}` : ""}`);
  items.push({
    title: `${withFlag(flag, race.raceName)} · ${K.label}`,
    subtitle: head.join(" · "),
    arg: page ? `open:${page}` : `copy:${table}`,
    valid: true,
    quicklookurl: page || undefined,
    text: { copy: table, largetype: table },
    icon: { path: `icons/${K.icon}.png` },
    mods: { cmd: { arg: `copy:${table}`, valid: true, subtitle: "Copy the classification" } },
  });
  return items.concat(rowItems, switchItems(year, race, races, kind));
}

// Tab-completion shortcuts to other sessions and rounds of the same season
function switchItems(year, race, races, current) {
  const pre = +year === THIS_YEAR ? "" : `${year} `;
  const items = [];
  const kinds = [["results", "Race"], ["qualifying", "Qualifying"]];
  if (isSprintWeekend(race)) kinds.push(["sprint", "Sprint"]);
  const word = { results: "results", qualifying: "quali", sprint: "sprint" };
  for (const [k, label] of kinds) {
    if (k === current) continue;
    items.push(info(`${label} · ${race.raceName}`, `Tab to show · ${kw()} ${pre}${word[k]} ${race.round}`, KINDS[k].icon, { autocomplete: `${pre}${word[k]} ${race.round} ` }));
  }
  const i = races.indexOf(race);
  const w = word[current || "results"];
  if (i > 0) items.push(info(`◀ Round ${races[i - 1].round} · ${races[i - 1].raceName}`, "Tab to show the previous round", "results", { autocomplete: `${pre}${w} ${races[i - 1].round} ` }));
  // offer the next round once its session has happened (qualifying is done a day before the race)
  const nextS = i >= 0 && i < races.length - 1 ? kindSession(races[i + 1], current || "results") : null;
  if (nextS && hasStarted(nextS)) items.push(info(`Round ${races[i + 1].round} · ${races[i + 1].raceName} ▶`, "Tab to show the next round", "results", { autocomplete: `${pre}${w} ${races[i + 1].round} ` }));
  return items;
}

function scheduleShortList(races, year, kind) {
  const pre = +year === THIS_YEAR ? "" : `${year} `;
  const w = { results: "results", qualifying: "quali", sprint: "sprint" }[kind] || "results";
  return races.filter(raceOver).slice(-5).reverse().map((r) => info(withFlag(countryFlag(r.Circuit.Location.country), r.raceName), `Round ${r.round} · Tab to show`, "results", { autocomplete: `${pre}${w} ${r.round} ` }));
}

// ---------- schedule ----------

function scheduleItems(year, filter) {
  const sch = schedule(year);
  if (sch.error) return errorItems(sch, "the schedule");
  const races = sch.races;
  if (!races.length) return [info(`The ${year} calendar hasn’t been published yet`, "Try again closer to the season", "season")];
  const pre = +year === THIS_YEAR ? "" : `${year} `;
  const anyDone = races.some(raceOver);
  const winners = Object.create(null);
  let winnersError = null;
  if (anyDone) {
    const w = api(`${year}/results/1`, resultsTtl(year, races, false), year);
    if (w.error) winnersError = w;
    else for (const r of (w.data.RaceTable && w.data.RaceTable.Races) || []) if (r.Results && r.Results[0] && r.Results[0].Driver) winners[r.round] = r.Results[0];
  }
  const next = races.find((r) => !raceOver(r));
  const withYear = +year !== THIS_YEAR;
  const f = fold(filter).trim();
  const shown = races.filter((r) => !f || f.split(/\s+/).every((wd) => fold([r.raceName, r.Circuit.circuitName, r.Circuit.Location.locality, r.Circuit.Location.country, `round ${r.round}`].join(" ")).includes(wd)));
  const items = [];
  if (winnersError) items.push(info("Winners unavailable", winnersError.error, winnersError.status === 0 ? "offline" : "error"));
  // every session still to come, in one calendar file
  const left = races.filter((r) => !raceOver(r));
  if (!f && left.length) {
    const n = left.reduce((sum, r) => sum + sessionsOf(r).filter((s) => sessionState(s) !== "done").length, 0);
    const title = left.length === races.length ? `Add the ${year} season to Calendar` : `Add the rest of the ${year} season to Calendar`;
    const sub = `${plural(left.length, "race weekend")} · ${plural(n, "session")} in one calendar file`;
    items.push({
      title,
      subtitle: sub,
      arg: `ics:${year}:rest`,
      valid: true,
      icon: { path: "icons/calendar.png" },
      mods: {
        cmd: { arg: `ics:${year}:rest`, valid: true, subtitle: sub },
        alt: { arg: "", valid: false, subtitle: sub },
      },
    });
  }
  if (!shown.length) items.push(info(`No ${year} race matches “${filter.trim()}”`, "Search by race, circuit, city or country"));
  for (const r of shown) {
    const [page, alt] = racePages(r);
    const st = raceStart(r);
    const when = st ? `${fmtDay(st, withYear)} ${fmtTime(st)}` : `${fmtDay(dateOnly(r.date), withYear)}`;
    const over = raceOver(r);
    const flag = countryFlag(r.Circuit.Location.country);
    const parts = [];
    let icon = "calendar";
    if (over) {
      icon = "done";
      const w = winners[r.round];
      parts.push(`✓ ${when}`);
      if (w) parts.push(`Winner ${driverName(w.Driver)} (${w.Constructor.name})`);
      else if (!winnersError) parts.push("Results pending");
    } else if (r === next) {
      icon = "next";
      const sessions = sessionsOf(r);
      const upcoming = sessions.find((s) => sessionState(s) !== "done");
      parts.push(`Next · ${when}`);
      const raceS = sessions.find((s) => s.key === "Race");
      const rs = raceS ? sessionState(raceS) : "upcoming";
      // the weekend stays "next" until three hours after the start: never show a negative countdown
      if (rs === "live") parts.push("🔴 Race live now");
      else if (rs === "done") parts.push("Race finished");
      else if (st) parts.push(until(st.getTime() - NOW.getTime()));
      else parts.push(dayCountdown(r.date));
      if (upcoming && upcoming.key !== "Race" && hasStarted(sessions[0])) parts.push(`${upcoming.name} ${sessionState(upcoming) === "live" ? "live now" : "next"}`);
    } else {
      parts.push(when);
    }
    parts.push(r.Circuit.Location.locality || r.Circuit.circuitName);
    if (isSprintWeekend(r)) parts.push("Sprint");
    const text = `Round ${r.round}: ${r.raceName}, ${when}`;
    items.push({
      title: `${r.round}. ${withFlag(flag, r.raceName)}`,
      subtitle: parts.join(" · "),
      arg: page ? `open:${page}` : "",
      valid: !!page,
      quicklookurl: page || undefined,
      autocomplete: over ? `${pre}results ${r.round} ` : undefined,
      text: { copy: text, largetype: text },
      icon: { path: `icons/${icon}.png` },
      mods: {
        cmd: over
          ? { arg: "", valid: false, subtitle: "This race weekend is over · Tab shows the results" }
          : { arg: `ics:${r.season}:${r.round}:all`, valid: true, subtitle: "Add every session of the weekend to Calendar" },
        alt: { arg: alt ? `open:${alt}` : "", valid: !!alt, subtitle: alt ? `Open on ${pageName(alt)}` : "No other page" },
      },
    });
  }
  return items;
}

// ---------- seasons ----------

function seasonItems(year) {
  const items = [];
  if (year < THIS_YEAR) {
    const st = standings(year, "driver");
    if (!st.error && st.rows.length) {
      const c = st.rows[0];
      items.push(info(`${year} Champion: ${withFlag(natFlag(c.Driver.nationality), driverName(c.Driver))}`, `${ptsText(+c.points)} · ${plural(+c.wins, "win")} · ${(c.Constructors || []).map((x) => x.name).join(" → ")}`, "drivers", { autocomplete: `${year} drivers ` }));
    }
  }
  return items.concat(menuItems(year, ""));
}

// ---------- calendar ----------

// Replace unpaired UTF-16 surrogates (they can't be written as UTF-8) with U+FFFD.
function wellFormed(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      } else out += "\ufffd";
    } else if (c >= 0xdc00 && c <= 0xdfff) out += "\ufffd";
    else out += s[i];
  }
  return out;
}
// TEXT value (RFC 5545 §3.3.11): escape \ ; , and newlines; other control characters aren't allowed.
function icsEscape(s) {
  return wellFormed(String(s))
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n").replace(/[\u0000-\u001f\u007f]/g, " ");
}
function utf8Len(ch) {
  const c = ch.codePointAt(0);
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
}
// Fold content lines at 75 octets (RFC 5545 §3.1) without splitting a UTF-8 sequence.
function icsFold(line) {
  const out = [];
  let cur = "", len = 0, limit = 75;
  for (const ch of line) {
    const n = utf8Len(ch);
    if (len + n > limit) {
      out.push(cur);
      cur = "";
      len = 0;
      limit = 74; // continuation lines start with a space
    }
    cur += ch;
    len += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}
function icsStamp(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// weekends: [[race, sessions], …]
function buildIcs(weekends) {
  const alert = Math.floor(+env("calendar_alert", "15")) || 0;
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//x-o-r-r-o//Alfred F1//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const [race, sessions] of weekends) {
  const loc = [race.Circuit.circuitName, race.Circuit.Location.locality, race.Circuit.Location.country].filter(Boolean).join(", ");
  const [page] = racePages(race);
  for (const s of sessions) {
    L.push("BEGIN:VEVENT");
    L.push(`UID:f1-${+race.season}-${+race.round}-${s.key.toLowerCase()}@io.github.x-o-r-r-o.f1`);
    L.push(`DTSTAMP:${icsStamp(new Date())}`);
    if (s.start) {
      L.push(`DTSTART:${icsStamp(s.start)}`);
      L.push(`DTEND:${icsStamp(new Date(s.start.getTime() + s.dur * 60000))}`);
    } else {
      const [y, m, d] = s.date.split("-").map(Number);
      const next = new Date(Date.UTC(y, m - 1, d + 1));
      L.push(`DTSTART;VALUE=DATE:${s.date.replace(/-/g, "")}`);
      L.push(`DTEND;VALUE=DATE:${next.getUTCFullYear()}${pad(next.getUTCMonth() + 1)}${pad(next.getUTCDate())}`);
    }
    L.push(`SUMMARY:${icsEscape(`F1 ${race.raceName}: ${s.name}`)}`);
    L.push(`LOCATION:${icsEscape(loc)}`);
    L.push(`DESCRIPTION:${icsEscape(`Round ${race.round} of the ${race.season} Formula 1 World Championship${s.start ? "" : "\nStart time to be confirmed"}`)}`);
    if (page) L.push(`URL:${page}`);
    if (alert > 0 && s.start) L.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(`${s.name} starts in ${alert} minutes`)}`, `TRIGGER:-PT${alert}M`, "END:VALARM");
    L.push("END:VEVENT");
  }
  }
  L.push("END:VCALENDAR");
  return L.map(icsFold).join("\r\n") + "\r\n";
}

// ---------- actions ----------

function openURL(url) {
  if (!/^https?:\/\/[^\s]+$/.test(url)) return "Invalid link";
  const u = $.NSURL.URLWithString(url);
  if (u.isNil()) return "Invalid link";
  if (!TEST_MODE) $.NSWorkspace.sharedWorkspace.openURL(u);
  return "";
}

function act(arg) {
  const m = String(arg).match(/^(\w+):([\s\S]*)$/);
  if (!m) return "";
  const [, kind, rest] = m;
  if (kind === "open") return openURL(rest);
  if (kind === "copy") {
    const pb = $.NSPasteboard.generalPasteboard;
    if (!TEST_MODE) {
      pb.clearContents;
      pb.setStringForType($(rest), $.NSPasteboardTypeString);
    }
    return "Copied to the clipboard";
  }
  if (kind === "ics") {
    // ics:<season>:<round>:<session key | all>, or ics:<season>:rest for every session still to come
    const p = rest.match(/^(\d{4}):(?:(\d{1,2}):(\w+)|(rest))$/);
    if (!p) return "Invalid calendar request";
    const sch = schedule(+p[1]);
    if (sch.error) return sch.error;
    let weekends, name;
    if (p[4]) {
      weekends = sch.races.filter((r) => !raceOver(r)).map((r) => [r, sessionsOf(r).filter((s) => sessionState(s) !== "done")]).filter(([, ss]) => ss.length);
      if (!weekends.length) return `No races left in ${p[1]}`;
      name = `f1-${p[1]}-rest`;
    } else {
      const race = sch.races.find((r) => r.round === p[2]);
      if (!race) return "That race is no longer on the calendar";
      const all = sessionsOf(race);
      const sessions = p[3] === "all" ? all : all.filter((s) => s.key === p[3]);
      if (!sessions.length) return "That session is no longer on the schedule";
      weekends = [[race, sessions]];
      name = `f1-${p[1]}-${p[2]}-${p[3]}`;
    }
    const dir = `${cacheDir()}/ics`;
    $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
    pruneCache(false);
    const file = `${dir}/${name}.ics`;
    if (!writeFile(file, buildIcs(weekends))) return "Could not write the calendar file";
    if (!TEST_MODE) $.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath(file));
    return "";
  }
  return "";
}

// ---------- entry ----------

function raceCommand(query) {
  const words = String(query || "").replace(/[\u0000-\u001f]/g, " ").trim().split(/\s+/).filter(Boolean);
  let year = null;
  const yi = words.findIndex((w) => /^\d{4}$/.test(w));
  if (yi >= 0) {
    year = +words.splice(yi, 1)[0];
    if (year < 1950 || year > THIS_YEAR + 1) return [info(`No Formula 1 season in ${year}`, `Seasons run from 1950 to ${THIS_YEAR + 1}`, "error")];
  }
  const y = year || THIS_YEAR;
  if (!words.length) return year ? seasonItems(year) : nextRaceItems();
  const word = fold(words[0]);
  const cmd = ALIASES[word];
  const rest = words.slice(1);
  switch (cmd) {
    case "next": return nextRaceItems();
    case "drivers": return driverStandingItems(y, rest.join(" "));
    case "teams": return teamStandingItems(y, rest.join(" "));
    case "results": return resultItems(y, rest, "results", !!year);
    case "quali": return resultItems(y, rest, "qualifying", !!year);
    case "sprint": return resultItems(y, rest, "sprint", !!year);
    case "schedule": return scheduleItems(y, rest.join(" "));
  }
  const menu = menuItems(year, words[0]);
  if (menu.length) return menu;
  // anything else searches the season's races
  return scheduleItems(y, words.join(" "));
}

function run(argv) {
  const [cmd, ...rest] = argv;
  const query = rest.join(" ");
  try {
    switch (cmd) {
      case "race": return output(raceCommand(query));
      // no output at all when there's nothing to say: osascript would print an empty line, which
      // Alfred passes on and the notification ("only show if populated") would show as a blank banner
      case "act": return act(query) || undefined;
      case "refresh": backgroundRefresh(query); return undefined;
      default: return output([info(`Unknown command: ${cmd}`, "", "error")]);
    }
  } catch (e) {
    if (cmd === "act" || cmd === "refresh") return String(e && e.message ? e.message : e);
    return output([info("Formula 1 error", String(e && e.message ? e.message : e), "error")]);
  }
}
