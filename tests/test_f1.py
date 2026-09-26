#!/usr/bin/env python3
"""End-to-end tests: run the Script Filter the way Alfred does, against a mock of the Jolpica API
serving real responses saved in tests/fixtures, with an injectable clock (F1_NOW) and time zone (TZ)."""
import copy, json, os, plistlib, re, shutil, signal, subprocess, sys, tempfile, threading, time, unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
FIX = os.path.join(ROOT, "tests", "fixtures")
DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def fixture(name):
    with open(os.path.join(FIX, name.replace("/", "_") + ".json")) as f:
        return json.load(f)


# ---------- mock API ----------

class Mock:
    mode = "ok"          # ok | down (503) | 429 | html
    overrides = {}       # path -> JSON document
    page_size = None     # force pagination
    delay = 0            # seconds before answering
    hits = []
    times = []           # arrival time of each request


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path.replace("/ergast/f1/", "", 1).strip("/")
        Mock.hits.append(path)
        Mock.times.append(time.time())
        if Mock.delay:
            time.sleep(Mock.delay)
        if Mock.mode == "down":
            return self.reply(503, b"Service Unavailable", "text/plain")
        if Mock.mode == "429":
            return self.reply(429, b'{"detail":"Too many requests"}')
        if Mock.mode == "html":
            return self.reply(200, b"<html>Cloudflare error</html>", "text/html")
        if path in Mock.overrides:
            doc = copy.deepcopy(Mock.overrides[path])
        else:
            f = os.path.join(FIX, path.replace("/", "_") + ".json")
            if not os.path.exists(f):
                return self.reply(404, b'{"detail":"Not found"}')
            with open(f) as fh:
                doc = json.load(fh)
        q = parse_qs(u.query)
        limit = Mock.page_size or int(q.get("limit", ["30"])[0])
        offset = int(q.get("offset", ["0"])[0])
        md = doc["MRData"]
        if "StandingsTable" in md and md["StandingsTable"]["StandingsLists"]:
            lst = md["StandingsTable"]["StandingsLists"][0]
            key = "DriverStandings" if "DriverStandings" in lst else "ConstructorStandings"
            md["total"] = str(len(lst[key]))
            lst[key] = lst[key][offset:offset + limit]
        md["limit"], md["offset"] = str(limit), str(offset)
        self.reply(200, json.dumps(doc).encode())

    def reply(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


SERVER = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=SERVER.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{SERVER.server_address[1]}/ergast/f1"


# ---------- harness ----------

def new_cache():
    return tempfile.mkdtemp(prefix="f1-test-")


def run_js(args, cache, now=None, tz="Europe/London", **env):
    e = dict(os.environ, alfred_workflow_cache=cache, F1_API_BASE=BASE, TZ=tz, time_format="24", date_format="dmy", F1_TEST_NO_OPEN="1")
    e.update(env)
    if now:
        e["F1_NOW"] = now
    out = subprocess.run(["osascript", "-l", "JavaScript", "./f1.js", *args], cwd=SRC, env=e,
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return out.stdout


def sf(query="", now="2026-09-26T15:00:00Z", cache=None, tz="Europe/London", raw=False, **env):
    cache = cache or new_cache()
    data = json.loads(run_js(["race", query], cache, now, tz, **env))
    validate(data)
    return data if raw else data["items"]


def act(arg, cache, now="2026-09-26T15:00:00Z", **env):
    return run_js(["act", arg], cache, now, **env).strip()


def validate(data):
    assert isinstance(data.get("items"), list)
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        assert os.path.exists(os.path.join(SRC, it["icon"]["path"])), it["icon"]
        if it.get("valid", True) is not False:
            assert it.get("arg"), it
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m and "arg" in m, it


def titles(items):
    return [i["title"] for i in items]


def find(items, prefix):
    for i in items:
        if i["title"].startswith(prefix):
            return i
    raise AssertionError(f"no item starting with {prefix!r}: {titles(items)}")


def local(date, t, tz):
    d = datetime.fromisoformat(f"{date}T{t.rstrip('Z')}+00:00").astimezone(ZoneInfo(tz))
    return f"{DOW[d.weekday()]} {d.day} {MON[d.month - 1]} {d:%H:%M}"


def reset():
    Mock.mode, Mock.overrides, Mock.page_size, Mock.delay = "ok", {}, None, 0
    Mock.hits.clear()
    Mock.times.clear()


def age(path, seconds):
    t = time.time() - seconds
    os.utime(path, (t, t))


def cache_file(cache, path):
    return os.path.join(cache, "api", re.sub(r"[^A-Za-z0-9]+", "_", path) + ".json")


def schedule_without(round_):
    doc = fixture("2026/races")
    doc["MRData"]["RaceTable"]["Races"] = [r for r in doc["MRData"]["RaceTable"]["Races"] if r["round"] != str(round_)]
    doc["MRData"]["total"] = str(len(doc["MRData"]["RaceTable"]["Races"]))
    return doc


EMPTY_STANDINGS = {"MRData": {"total": "0", "StandingsTable": {"season": "2027", "StandingsLists": []}}}


class Base(unittest.TestCase):
    def setUp(self):
        reset()


# ---------- next race ----------

class NextRaceTests(Base):
    def test_next_weekend_local_times_and_countdown(self):
        it = sf("", now="2026-09-26T15:00:00Z")
        head = it[0]
        self.assertEqual(head["title"], "🇲🇾 Bahrain Grand Prix in Malaysia")
        self.assertIn("Round 16 of 23", head["subtitle"])
        # FP1 2026-10-02 04:30Z is 5 days 13 h 30 min away
        self.assertIn("Practice 1 in 5 days 13 h", head["subtitle"])
        race = fixture("2026/races")["MRData"]["RaceTable"]["Races"][15]
        self.assertEqual(it[1]["title"], f"Practice 1  ·  {local('2026-10-02', '04:30:00Z', 'Europe/London')}")
        self.assertEqual(it[1]["title"], "Practice 1  ·  Fri 2 Oct 05:30")
        self.assertEqual(titles(it)[1:6], ["Practice 1  ·  Fri 2 Oct 05:30", "Practice 2  ·  Fri 2 Oct 09:00",
                                           "Practice 3  ·  Sat 3 Oct 05:30", "Qualifying  ·  Sat 3 Oct 09:00",
                                           "Race  ·  Sun 4 Oct 08:00"])
        self.assertEqual(it[5]["subtitle"], "in 7 days 16 h · " + race["Circuit"]["circuitName"])
        self.assertEqual(head["mods"]["cmd"]["arg"], "ics:2026:16:all")
        self.assertEqual(it[4]["mods"]["cmd"]["arg"], "ics:2026:16:Qualifying")
        self.assertTrue(head["arg"].startswith("open:https://www.formula1.com/en/racing/2026/"))
        self.assertTrue(head["mods"]["alt"]["arg"].startswith("open:https://en.wikipedia.org/"))
        # the menu follows the sessions
        self.assertIn("Driver Standings", titles(it))

    def test_wikipedia_preference(self):
        head = sf("", race_page="wikipedia")[0]
        self.assertEqual(head["arg"], "open:https://en.wikipedia.org/wiki/2026_Bahrain_Grand_Prix")
        self.assertTrue(head["mods"]["alt"]["arg"].startswith("open:https://www.formula1.com/"))

    def test_weekend_in_progress_live_and_done(self):
        # Baku 2026: race on Saturday 26 Sep 11:00Z; at 11:30Z the race is live
        it = sf("", now="2026-09-26T11:30:00Z")
        self.assertEqual(it[0]["title"], "🇦🇿 Azerbaijan Grand Prix")
        self.assertIn("🔴 Race live now", it[0]["subtitle"])
        race = find(it, "Race  ·")
        self.assertTrue(race["subtitle"].startswith("🔴 Live now · started 30 min ago"))
        self.assertEqual(race["icon"]["path"], "icons/live.png")
        fp1 = find(it, "Practice 1")
        self.assertEqual(fp1["subtitle"], "Finished")
        self.assertEqual(fp1["icon"]["path"], "icons/done.png")
        self.assertIs(fp1["mods"]["cmd"]["valid"], False)

    def test_race_stays_until_three_hours_after_start(self):
        self.assertEqual(sf("", now="2026-09-26T13:59:00Z")[0]["title"], "🇦🇿 Azerbaijan Grand Prix")
        self.assertIn("Race finished", sf("", now="2026-09-26T13:59:00Z")[0]["subtitle"])
        self.assertEqual(sf("", now="2026-09-26T14:01:00Z")[0]["title"], "🇲🇾 Bahrain Grand Prix in Malaysia")

    def test_sprint_weekend_order(self):
        it = sf("", now="2026-10-05T12:00:00Z")
        self.assertEqual(it[0]["title"], "🇸🇬 Singapore Grand Prix")
        self.assertIn("Sprint weekend", it[0]["subtitle"])
        names = [t.split("  ·  ")[0] for t in titles(it)[1:6]]
        self.assertEqual(names, ["Practice 1", "Sprint Qualifying", "Sprint", "Qualifying", "Race"])
        self.assertEqual(find(it, "Sprint  ·")["icon"]["path"], "icons/sprint.png")

    def test_season_boundary(self):
        # after Abu Dhabi 2025, the next race is Australia 2026
        it = sf("", now="2025-12-20T12:00:00Z")
        self.assertEqual(it[0]["title"], "🇦🇺 Australian Grand Prix")
        self.assertIn("Round 1 of 23", it[0]["subtitle"])
        # FP1 2026-03-06 01:30Z is 75 days 13 h 30 min away; dates show the year
        self.assertIn("Practice 1 in 75 days 13 h", it[0]["subtitle"])
        self.assertEqual(it[1]["title"], "Practice 1  ·  Fri 6 Mar 2026 01:30")

    def test_off_season(self):
        it = sf("", now="2026-12-20T12:00:00Z")
        self.assertEqual(it[0]["title"], "Off-season: no upcoming races")
        self.assertIn("2027 calendar", it[0]["subtitle"])
        last = find(it, "Last race")
        self.assertEqual(last["autocomplete"], "2026 results 23 ")

    def test_cancelled_race_is_skipped(self):
        Mock.overrides["2026/races"] = schedule_without(16)
        it = sf("", now="2026-09-26T15:00:00Z")
        self.assertEqual(it[0]["title"], "🇸🇬 Singapore Grand Prix")
        self.assertTrue(it[0]["subtitle"].startswith("Round 17 · "), it[0]["subtitle"])

    def test_missing_session_times_are_tbc(self):
        it = sf("", now="2021-07-15T12:00:00Z")
        self.assertEqual(it[0]["title"], "🇬🇧 British Grand Prix")
        self.assertEqual(titles(it)[1:6], ["Practice 1  ·  Fri 16 Jul · time TBC", "Qualifying  ·  Fri 16 Jul · time TBC",
                                           "Practice 2  ·  Sat 17 Jul · time TBC", "Sprint  ·  Sat 17 Jul · time TBC",
                                           "Race  ·  Sun 18 Jul 15:00"])
        self.assertEqual(it[1]["subtitle"], "tomorrow · time to be confirmed")
        self.assertIn("Practice 1 tomorrow (time TBC)", it[0]["subtitle"])
        # on the day, a date-only session is "today", not finished
        it = sf("", now="2021-07-16T20:00:00Z")
        self.assertEqual(it[1]["subtitle"], "today · time to be confirmed")

    def test_empty_query_uses_one_request(self):
        cache = new_cache()
        sf("", cache=cache)
        sf("", cache=cache)
        self.assertEqual(Mock.hits, ["2026/races"])


class TimeZoneTests(Base):
    CASES = ["Europe/London", "America/Los_Angeles", "Asia/Kolkata", "Australia/Melbourne", "Asia/Kathmandu", "Pacific/Chatham",
             "Pacific/Kiritimati", "Pacific/Pago_Pago"]  # both sides of the date line

    def test_local_times_in_many_zones(self):
        race = fixture("2026/races")["MRData"]["RaceTable"]["Races"][20]  # Las Vegas: crosses midnight UTC
        sessions = [("Practice 1", race["FirstPractice"]), ("Practice 2", race["SecondPractice"]),
                    ("Practice 3", race["ThirdPractice"]), ("Qualifying", race["Qualifying"]),
                    ("Race", {"date": race["date"], "time": race["time"]})]
        for tz in self.CASES:
            it = sf("", now="2026-11-18T12:00:00Z", tz=tz)
            self.assertEqual(it[0]["title"], "🇺🇸 Las Vegas Grand Prix", tz)
            expected = [f"{n}  ·  {local(s['date'], s['time'], tz)}" for n, s in sessions]
            self.assertEqual(titles(it)[1:6], expected, tz)

    def test_dst_change_on_race_weekend(self):
        # Europe leaves summer time on 25 Oct 2026 01:00Z: Friday is BST (+1), Sunday is GMT (+0)
        it = sf("", now="2026-10-20T12:00:00Z", tz="Europe/London")
        self.assertEqual(it[0]["title"], "🇺🇸 United States Grand Prix")
        self.assertEqual(it[1]["title"], "Practice 1  ·  Fri 23 Oct 18:30")
        self.assertEqual(find(it, "Race")["title"], "Race  ·  Sun 25 Oct 20:00")
        # US leaves summer time on 1 Nov: Austin (Central) is still CDT (−5)
        it = sf("", now="2026-10-20T12:00:00Z", tz="America/Chicago")
        self.assertEqual(find(it, "Race")["title"], "Race  ·  Sun 25 Oct 15:00")

    def test_countdown_across_dst_is_real_elapsed_time(self):
        # 24 Oct 20:00Z → 25 Oct 20:00Z is exactly one day, even though London's clock moves back an hour
        it = sf("", now="2026-10-24T20:00:00Z", tz="Europe/London")
        self.assertEqual(find(it, "Race")["subtitle"].split(" · ")[0], "in 1 day")

    def test_12_hour_format(self):
        it = sf("", now="2026-09-26T15:00:00Z", time_format="12")
        self.assertEqual(it[1]["title"], "Practice 1  ·  Fri 2 Oct 5:30 AM")
        self.assertEqual(find(it, "Race")["title"], "Race  ·  Sun 4 Oct 8:00 AM")


# ---------- standings ----------

class StandingsTests(Base):
    def test_drivers(self):
        it = sf("drivers")
        self.assertEqual(it[0]["title"], "2026 Drivers’ Championship")
        self.assertIn("After round 15", it[0]["subtitle"])
        first = it[1]
        self.assertEqual(first["title"], "1. 🇮🇹 Andrea Kimi Antonelli  #12")
        self.assertEqual(first["subtitle"], "292 pts · 8 wins · Mercedes · leads by 81")
        self.assertEqual(first["icon"]["path"], "icons/team-mercedes.png")
        self.assertEqual(find(it, "2. ")["subtitle"], "211 pts · 2 wins · Mercedes · −81 to the leader")
        self.assertEqual(len(it), 24)
        self.assertTrue(it[0]["mods"]["cmd"]["arg"].startswith("copy:1. Andrea Kimi Antonelli (Mercedes) 292 pts"))

    def test_mid_season_team_change(self):
        law = find(sf("drivers"), "9. ")
        self.assertIn("RB F1 Team → Red Bull", law["subtitle"])
        self.assertEqual(law["icon"]["path"], "icons/team-red_bull.png")  # the current (last) team

    def test_filter_is_accent_insensitive(self):
        it = sf("drivers hulk")
        self.assertEqual(titles(it)[1:], ["15. 🇩🇪 Nico Hülkenberg  #27"])
        it = sf("drivers ferrari")
        self.assertEqual(len(it), 3)
        it = sf("drivers zzz")
        self.assertEqual(it[1]["title"], "No driver matches “zzz”")

    def test_teams(self):
        it = sf("teams")
        self.assertEqual(it[0]["title"], "2026 Constructors’ Championship")
        rb = find(it, "4. ")
        self.assertEqual(rb["title"], "4. 🇦🇹 Red Bull")
        self.assertIn("Verstappen, Hadjar, Lawson", rb["subtitle"])
        for i in it[1:]:
            self.assertTrue(i["icon"]["path"].startswith("icons/team-"))
        self.assertEqual(find(it, "11. ")["icon"]["path"], "icons/team-cadillac.png")

    def test_pre_season_falls_back_to_final_standings(self):
        Mock.overrides["2027/driverstandings"] = EMPTY_STANDINGS
        it = sf("drivers", now="2027-01-15T12:00:00Z")
        self.assertEqual(it[0]["title"], "The 2027 season hasn’t started yet")
        self.assertEqual(it[1]["title"], "2026 Drivers’ Championship")

    def test_past_season(self):
        it = sf("2021 drivers")
        self.assertEqual(it[0]["title"], "2021 Drivers’ Championship")
        # permanentNumber is today's number (Verstappen raced as #33 in 2021), so past seasons omit it
        self.assertEqual(it[1]["title"], "1. 🇳🇱 Max Verstappen")
        self.assertIn("395.5 pts", it[1]["subtitle"])

    def test_pagination(self):
        Mock.page_size = 10
        it = sf("drivers")
        self.assertEqual(len(it), 24)
        self.assertEqual(Mock.hits.count("2026/driverstandings"), 3)
        self.assertEqual(it[-1]["title"], "23. 🇲🇽 Sergio Pérez  #11")


# ---------- results ----------

class ResultsTests(Base):
    def test_pending_results_fall_back_to_previous_round(self):
        it = sf("results", now="2026-09-26T15:00:00Z")
        self.assertEqual(it[0]["title"], "Azerbaijan Grand Prix race results aren’t published yet")
        self.assertEqual(it[1]["title"], "🇪🇸 Spanish Grand Prix · Race")
        self.assertIn("Winner Antonelli", it[1]["subtitle"])
        self.assertIn("Fastest lap Russell 1:35.587", it[1]["subtitle"])
        self.assertEqual(it[2]["subtitle"], "Mercedes · 1:34:23.754 · +25 pts · grid 2 ▲1")
        self.assertIn("⏱ fastest lap", find(it, "5. ")["subtitle"])
        self.assertEqual(find(it, "9. ")["subtitle"].split(" · ")[1], "+1 lap")
        self.assertEqual(find(it, "17. ")["subtitle"].split(" · ")[1], "+2 laps")
        self.assertEqual(find(it, "DNF 🇬🇧 Lewis")["subtitle"], "Ferrari · Retired (lap 6) · grid 4")

    def test_explicit_round_and_sessions(self):
        it = sf("results 12")
        self.assertEqual(it[0]["title"], "🇳🇱 Dutch Grand Prix · Race")
        self.assertIn("Sprint · Dutch Grand Prix", titles(it))
        it = sf("results 12 sprint")
        self.assertEqual(it[0]["title"], "🇳🇱 Dutch Grand Prix · Sprint")
        self.assertEqual(it[1]["subtitle"], "Mercedes · 30:25.318 · +8 pts · grid 1")
        self.assertEqual(sf("sprint 12")[0]["title"], "🇳🇱 Dutch Grand Prix · Sprint")
        self.assertEqual(sf("results dutch")[0]["title"], "🇳🇱 Dutch Grand Prix · Race")

    def test_qualifying(self):
        it = sf("quali")  # Baku qualifying is done (Friday), so it is the latest
        self.assertEqual(it[0]["title"], "🇦🇿 Azerbaijan Grand Prix · Qualifying")
        self.assertIn("Pole Russell", it[0]["subtitle"])
        self.assertEqual(it[1]["subtitle"], "Mercedes · Q3 1:42.526 · Q2 1:43.462, Q1 1:43.615")
        self.assertEqual(it[2]["subtitle"], "Ferrari · Q3 1:43.363 · +0.837 · Q2 1:43.780, Q1 1:44.360")
        self.assertEqual(find(it, "22. ")["subtitle"], "Cadillac F1 Team · Q1 1:48.290")

    def test_latest_sprint_is_found(self):
        it = sf("sprint", now="2026-09-26T15:00:00Z")
        self.assertEqual(it[0]["title"], "🇳🇱 Dutch Grand Prix · Sprint")

    def test_no_sprint_future_and_unknown_round(self):
        self.assertEqual(sf("sprint 15")[0]["title"], "Azerbaijan Grand Prix had no sprint")
        it = sf("results 20")
        self.assertEqual(it[0]["title"], "Brazilian Grand Prix race hasn’t happened yet")
        self.assertEqual(sf("results 30")[0]["title"], "2026 has no round 30")
        self.assertEqual(sf("results zzz")[0]["title"], "No 2026 race matches “zzz”")

    def test_past_season_last_round(self):
        it = sf("2025 results")
        self.assertEqual(it[0]["title"], "🇦🇪 Abu Dhabi Grand Prix · Race")
        self.assertIn("Sun 7 Dec 2025", it[0]["subtitle"])

    def test_copy_table(self):
        it = sf("results 12")
        table = it[0]["mods"]["cmd"]["arg"]
        self.assertTrue(table.startswith("copy:Dutch Grand Prix 2026 (Race)\n1. "))


# ---------- schedule, seasons, menu ----------

class ScheduleTests(Base):
    def test_markers_and_winners(self):
        it = sf("schedule")
        self.assertEqual(len(it), 23)
        first = it[0]
        self.assertEqual(first["title"], "1. 🇦🇺 Australian Grand Prix")
        self.assertIn("Winner George Russell (Mercedes)", first["subtitle"])
        self.assertEqual(first["icon"]["path"], "icons/done.png")
        self.assertEqual(first["autocomplete"], "results 1 ")
        self.assertIn("Results pending", it[14]["subtitle"])
        nxt = it[15]
        self.assertEqual(nxt["icon"]["path"], "icons/next.png")
        self.assertTrue(nxt["subtitle"].startswith("Next · Sun 4 Oct 08:00 · in 7 days 16 h"))
        self.assertIn("Sprint", it[16]["subtitle"])
        self.assertEqual(it[16]["mods"]["cmd"]["arg"], "ics:2026:17:all")

    def test_filter_and_search(self):
        self.assertEqual(titles(sf("schedule monaco")), ["6. 🇲🇨 Monaco Grand Prix"])
        self.assertEqual(titles(sf("monaco")), ["6. 🇲🇨 Monaco Grand Prix"])
        self.assertEqual(sf("schedule atlantis")[0]["title"], "No 2026 race matches “atlantis”")

    def test_season_menu_and_bounds(self):
        it = sf("2021")
        self.assertEqual(it[0]["title"], "2021 Champion: 🇳🇱 Max Verstappen")
        self.assertEqual(find(it, "2021 Driver Standings")["autocomplete"], "2021 drivers ")
        self.assertEqual(sf("1900")[0]["title"], "No Formula 1 season in 1900")
        self.assertEqual(sf("2027 schedule")[0]["title"], "The 2027 calendar hasn’t been published yet")

    def test_menu_prefix(self):
        it = sf("dr")
        self.assertEqual(titles(it), ["Driver Standings"])
        self.assertEqual(it[0]["autocomplete"], "drivers ")
        self.assertEqual(sf("2021 te")[0]["autocomplete"], "2021 teams ")

    def test_old_seasons_without_times(self):
        it = sf("1950 schedule")
        self.assertEqual(it[0]["title"], "1. 🇬🇧 British Grand Prix")
        self.assertIn("Sat 13 May 1950", it[0]["subtitle"])
        self.assertIn("Winner Nino Farina (Alfa Romeo)", it[0]["subtitle"])

    def test_unicode_and_quotes(self):
        for q in ['drivers "Hülk\'', "results 'monaco\"", "drivers \n\t", "😀", "schedule ;rm -rf ~"]:
            sf(q)


# ---------- cache & outages ----------

class CacheTests(Base):
    def test_fresh_cache_avoids_requests(self):
        cache = new_cache()
        sf("drivers", cache=cache)
        n = len(Mock.hits)
        sf("drivers", cache=cache)
        self.assertEqual(len(Mock.hits), n)

    def test_outage_without_cache(self):
        Mock.mode = "down"
        it = sf("drivers")
        self.assertEqual(it[0]["title"], "Couldn’t load the driver standings")
        self.assertEqual(it[0]["subtitle"], "The F1 API returned HTTP 503 · Try again in a few minutes")
        Mock.mode = "429"
        self.assertIn("rate limiting", sf("drivers")[0]["subtitle"])
        Mock.mode = "html"
        self.assertEqual(sf("drivers")[0]["subtitle"], "Unexpected response from the F1 API · Try again in a few minutes")

    def test_no_network(self):
        it = sf("", F1_API_BASE="http://127.0.0.1:9/ergast/f1")
        self.assertEqual(it[0]["title"], "Can’t reach the Formula 1 API")
        self.assertIn("Driver Standings", titles(it))

    def test_stale_cache_served_when_offline(self):
        cache = new_cache()
        sf("drivers", cache=cache)
        age(cache_file(cache, "2026/driverstandings"), 2 * 3600)
        it = sf("drivers", cache=cache, F1_SYNC="1", F1_API_BASE="http://127.0.0.1:9/ergast/f1")
        self.assertTrue(it[0]["title"].startswith("Offline: showing data from 2 h"), it[0]["title"])
        self.assertEqual(it[1]["title"], "2026 Drivers’ Championship")

    def test_background_refresh(self):
        cache = new_cache()
        sf("drivers", cache=cache)
        f = cache_file(cache, "2026/driverstandings")
        age(f, 2 * 3600)
        n = len(Mock.hits)
        data = sf("drivers", cache=cache, raw=True)
        self.assertEqual(data["rerun"], 0.5)
        self.assertEqual(data["items"][0]["title"], "2026 Drivers’ Championship")  # stale data at once
        for _ in range(100):
            if not os.path.exists(f + ".lock"):
                break
            time.sleep(0.1)
        self.assertGreater(len(Mock.hits), n)
        self.assertLess(time.time() - os.path.getmtime(f), 60)
        self.assertNotIn("rerun", sf("drivers", cache=cache, raw=True))

    def test_background_refresh_failure_shows_notice(self):
        cache = new_cache()
        sf("drivers", cache=cache)
        f = cache_file(cache, "2026/driverstandings")
        age(f, 3 * 3600)
        Mock.mode = "down"
        self.assertEqual(sf("drivers", cache=cache, raw=True).get("rerun"), 0.5)
        for _ in range(100):
            if not os.path.exists(f + ".lock"):
                break
            time.sleep(0.1)
        it = sf("drivers", cache=cache)
        self.assertTrue(it[0]["title"].startswith("Couldn’t update: showing data from 3 h"), it[0]["title"])
        self.assertIn("HTTP 503", it[0]["subtitle"])

    def test_results_refresh_every_10_minutes_around_race_time(self):
        cache = new_cache()
        sf("results 12", cache=cache, now="2026-09-26T15:00:00Z")
        f = cache_file(cache, "2026/12/results")
        age(f, 15 * 60)
        # a race weekend is on: 15 minutes is stale
        sf("results 12", cache=cache, now="2026-09-26T15:00:00Z", F1_SYNC="1")
        self.assertEqual(Mock.hits.count("2026/12/results"), 2)
        # mid-week: 6 hours
        age(f, 15 * 60)
        sf("results 12", cache=cache, now="2026-09-30T12:00:00Z", F1_SYNC="1")
        self.assertEqual(Mock.hits.count("2026/12/results"), 2)

    def test_pending_results_rechecked(self):
        cache = new_cache()
        sf("results 15", cache=cache)
        f = cache_file(cache, "2026/15/results")
        age(f, 11 * 60)
        Mock.overrides["2026/15/results"] = fixture("2026/14/results")
        it = sf("results 15", cache=cache, F1_SYNC="1")
        self.assertIn("· Race", it[0]["title"])

    def test_corrupt_cache_is_refetched(self):
        cache = new_cache()
        sf("drivers", cache=cache)
        with open(cache_file(cache, "2026/driverstandings"), "w") as fh:
            fh.write("{not json")
        self.assertEqual(sf("drivers", cache=cache)[0]["title"], "2026 Drivers’ Championship")


# ---------- actions ----------

class ActionTests(Base):
    def ics(self, arg, now="2026-09-26T15:00:00Z", **env):
        cache = new_cache()
        self.assertEqual(act(arg, cache, now, **env), "")
        season, rnd, key = arg.split(":")[1:]
        with open(os.path.join(cache, "ics", f"f1-{season}-{rnd}-{key}.ics"), "rb") as fh:
            return fh.read().decode()

    def test_weekend_ics(self):
        ics = self.ics("ics:2026:17:all")
        self.assertTrue(ics.startswith("BEGIN:VCALENDAR\r\n"))
        self.assertEqual(ics.count("BEGIN:VEVENT"), 5)
        self.assertIn("DTSTART:20261009T083000Z", ics)
        self.assertIn("DTEND:20261009T093000Z", ics)
        self.assertIn("DTSTART:20261011T120000Z\r\nDTEND:20261011T140000Z", ics)
        self.assertIn("SUMMARY:F1 Singapore Grand Prix: Sprint Qualifying", ics)
        self.assertIn("LOCATION:Marina Bay Street Circuit\\, Marina Bay\\, Singapore", ics)
        self.assertIn("TRIGGER:-PT15M", ics)
        for line in ics.split("\r\n"):
            self.assertLessEqual(len(line.encode()), 75, line)
        self.assertNotIn("\n", ics.replace("\r\n", ""))

    def test_single_session_and_alert_setting(self):
        ics = self.ics("ics:2026:16:Qualifying", calendar_alert="0")
        self.assertEqual(ics.count("BEGIN:VEVENT"), 1)
        self.assertIn("UID:f1-2026-16-qualifying@io.github.x-o-r-r-o.f1", ics)
        self.assertNotIn("VALARM", ics)

    def test_tbc_sessions_are_all_day(self):
        ics = self.ics("ics:2021:10:all", now="2021-07-15T12:00:00Z")
        self.assertIn("DTSTART;VALUE=DATE:20210716\r\nDTEND;VALUE=DATE:20210717", ics)
        self.assertIn("DTSTART:20210718T140000Z", ics)

    def test_ics_folding_with_unicode(self):
        doc = fixture("2026/races")
        r = doc["MRData"]["RaceTable"]["Races"][16]
        r["raceName"] = "Grande Prémio de São Paulo — Fórmula 1 “Heineken” Singapore, Grand Prix; Edition"
        Mock.overrides["2026/races"] = doc
        ics = self.ics("ics:2026:17:Race")
        for line in ics.split("\r\n"):
            self.assertLessEqual(len(line.encode()), 75, line)
        unfolded = ics.replace("\r\n ", "")
        self.assertIn("SUMMARY:F1 Grande Prémio de São Paulo — Fórmula 1 “Heineken” Singapore\\, Grand Prix\\; Edition: Race", unfolded)

    def test_bad_actions(self):
        cache = new_cache()
        self.assertEqual(act("open:javascript:alert(1)", cache), "Invalid link")
        self.assertEqual(act("open:https://example.com/a b", cache), "Invalid link")
        self.assertEqual(act("open:https://www.formula1.com/en/racing/2026/japan", cache), "")
        self.assertEqual(act("ics:2026:99:all", cache), "That race is no longer on the calendar")
        self.assertEqual(act("ics:2026:16:Sprint", cache), "That session is no longer on the schedule")
        self.assertEqual(act("ics:x", cache), "Invalid calendar request")
        self.assertEqual(act("copy:hello\n\"world\"", cache), "Copied to the clipboard")


class AuditRegressionTests(Base):
    """One test per bug found while auditing."""

    # --- pass 1 ---
    def test_january_before_calendar_is_published(self):
        Mock.overrides["2027/races"] = fixture("2027/races")
        it = sf("", now="2027-01-10T12:00:00Z")
        self.assertEqual(it[0]["subtitle"], "The 2027 calendar hasn’t been published yet")
        self.assertEqual(find(it, "Last race")["autocomplete"], "2026 results 23 ")
        self.assertNotIn("2028/races", Mock.hits)

    def test_singular_point(self):
        self.assertEqual(find(sf("drivers"), "20. ")["subtitle"].split(" · ")[0], "1 pt")
        self.assertIn("+1 pt ", find(sf("results 14"), "10. ")["subtitle"] + " ")

    def test_tie_for_the_lead(self):
        doc = fixture("2026/driverstandings")
        rows = doc["MRData"]["StandingsTable"]["StandingsLists"][0]["DriverStandings"]
        rows[1]["points"] = rows[0]["points"]
        Mock.overrides["2026/driverstandings"] = doc
        it = sf("drivers")
        self.assertTrue(it[1]["subtitle"].endswith("level on points"))
        self.assertTrue(it[2]["subtitle"].endswith("level on points with the leader"))

    def test_retired_car_with_lapped_status(self):
        # the API marks Hülkenberg's sprint retirement as position "R" with status "Lapped"
        self.assertEqual(find(sf("sprint 12"), "DNF 🇩🇪")["subtitle"], "Audi · Retired (lap 7) · grid 14")

    def test_disqualified_in_standings(self):
        doc = fixture("2026/driverstandings")
        row = doc["MRData"]["StandingsTable"]["StandingsLists"][0]["DriverStandings"][2]
        row["positionText"] = "D"
        del row["position"]
        Mock.overrides["2026/driverstandings"] = doc
        self.assertEqual(sf("drivers")[3]["title"], "DSQ 🇬🇧 Lewis Hamilton")

    def test_year_anywhere_in_query(self):
        self.assertEqual(sf("drivers 2021")[0]["title"], "2021 Drivers’ Championship")
        self.assertEqual(sf("results 2021 10 sprint")[0]["title"], "🇬🇧 British Grand Prix · Sprint")


class AuditPass2Tests(Base):
    def test_round_of_total_needs_contiguous_rounds(self):
        # a cancelled race removed without renumbering must not give "Round 17 of 22"
        Mock.overrides["2026/races"] = schedule_without(16)
        self.assertNotIn(" of 22", sf("")[0]["subtitle"])
        Mock.overrides.clear()
        self.assertIn("Round 16 of 23", sf("")[0]["subtitle"])

    def test_winners_unavailable_is_not_results_pending(self):
        cache = new_cache()
        sf("", cache=cache)  # schedule cached, winners not
        Mock.mode = "down"
        it = sf("schedule", cache=cache)
        self.assertEqual(it[0]["title"], "Winners unavailable")
        self.assertFalse(any("Results pending" in i["subtitle"] for i in it))
        self.assertEqual(len(it), 24)

    def test_results_before_the_first_race_show_last_season(self):
        it = sf("results", now="2026-02-15T12:00:00Z")
        self.assertEqual(it[0]["title"], "No race yet in 2026")
        self.assertIn("Showing 2025", it[0]["subtitle"])
        self.assertEqual(it[1]["title"], "🇦🇪 Abu Dhabi Grand Prix · Race")
        # an explicit year never falls back
        self.assertEqual(sf("2026 results", now="2026-02-15T12:00:00Z")[0]["title"], "No race yet in 2026")

    def test_http_error_on_refresh_is_not_called_offline(self):
        cache = new_cache()
        sf("drivers", cache=cache)
        age(cache_file(cache, "2026/driverstandings"), 2 * 3600)
        Mock.mode = "429"
        it = sf("drivers", cache=cache, F1_SYNC="1")
        self.assertTrue(it[0]["title"].startswith("Couldn’t update: showing data from 2 h"), it[0]["title"])
        self.assertIn("rate limiting", it[0]["subtitle"])

    def test_every_historical_nationality_and_country_has_a_flag(self):
        with open(os.path.join(SRC, "f1.js")) as fh:
            js = fh.read()
        def keys(name):
            body = re.search(name + r" = (?:dict\()?\{(.*?)\}\)?;", js, re.S).group(1)
            return set(k.strip('"') for k in re.findall(r'("[^"]+"|[a-z]+):', body))
        nat, country = keys("NATIONALITY"), keys("COUNTRY")
        # every value the API has used (drivers, constructors and circuits since 1950)
        for n in ["American", "Argentine", "Australian", "Austrian", "Belgian", "Brazilian", "British", "Canadian", "Chilean",
                  "Chinese", "Colombian", "Czech", "Danish", "Dutch", "East German", "Finnish", "French", "German", "Hong Kong",
                  "Hungarian", "Indian", "Indonesian", "Irish", "Italian", "Japanese", "Liechtensteiner", "Malaysian", "Mexican",
                  "Monegasque", "New Zealander", "Polish", "Portuguese", "Rhodesian", "Russian", "South African", "Spanish",
                  "Swedish", "Swiss", "Thai", "Uruguayan", "Venezuelan"]:
            self.assertIn(n.lower(), nat)
        for c in ["Argentina", "Australia", "Austria", "Azerbaijan", "Bahrain", "Belgium", "Brazil", "Canada", "China", "France",
                  "Germany", "Hungary", "India", "Italy", "Japan", "Korea", "Malaysia", "Mexico", "Monaco", "Morocco",
                  "Netherlands", "Portugal", "Qatar", "Russia", "Saudi Arabia", "Singapore", "South Africa", "Spain", "Sweden",
                  "Switzerland", "Turkey", "UAE", "UK", "USA"]:
            self.assertIn(c.lower(), country)


class AuditPass3Tests(Base):
    def test_next_round_shortcut_follows_the_session(self):
        # Friday evening in Baku: qualifying for round 15 is done, the race (Saturday) is not
        it = sf("quali 14", now="2026-09-25T20:00:00Z")
        self.assertEqual(find(it, "Round 15")["autocomplete"], "quali 15 ")
        it = sf("results 14", now="2026-09-25T20:00:00Z")
        self.assertFalse(any(t.startswith("Round 15") for t in titles(it)))

    def test_schedule_never_shows_a_negative_countdown(self):
        # found against the live API: 2 h 30 min after the start the race is still "next"
        row = sf("schedule", now="2026-09-26T13:30:00Z")[14]
        self.assertIn("Race finished", row["subtitle"])
        self.assertNotIn("in under a minute", row["subtitle"])
        self.assertIn("🔴 Race live now", sf("schedule", now="2026-09-26T11:30:00Z")[14]["subtitle"])

    def test_malformed_winners_response(self):
        Mock.overrides["2026/results/1"] = {"MRData": {"total": "0"}}
        it = sf("schedule")
        self.assertEqual(it[0]["title"], "1. 🇦🇺 Australian Grand Prix")
        self.assertIn("Results pending", it[0]["subtitle"])


# ---------- strict RFC 5545 checks (icalendar isn't installed, so by hand) ----------

ICS_LINE = re.compile(r'^([A-Za-z0-9-]+)((?:;[A-Za-z0-9-]+=(?:"[^"\x00-\x1f]*"|[^";:,\x00-\x1f]*)(?:,(?:"[^"]*"|[^";:,\x00-\x1f]*))*)*):(.*)$')
ICS_TEXT = {"SUMMARY", "LOCATION", "DESCRIPTION"}


def check_ics(test, ics):
    """Validate an .ics document against RFC 5545: CRLF lines of at most 75 octets, folding,
    content-line grammar, TEXT escaping, component nesting and required properties."""
    raw = ics.encode("utf-8")
    test.assertTrue(raw.endswith(b"\r\n"))
    test.assertNotIn(b"\r\n\r\n", raw)
    physical = raw[:-2].split(b"\r\n")
    for ln in physical:
        test.assertNotIn(b"\n", ln)
        test.assertNotIn(b"\r", ln)
        test.assertLessEqual(len(ln), 75, ln)
        ln.decode("utf-8")  # a fold never splits a UTF-8 sequence
    lines = []
    for ln in physical:
        if ln[:1] in (b" ", b"\t"):
            lines[-1] += ln[1:]
        else:
            lines.append(ln)
    stack, comps = [], []
    for b in lines:
        line = b.decode("utf-8")
        m = ICS_LINE.match(line)
        test.assertTrue(m, line)
        name, params, value = m.group(1).upper(), m.group(2), m.group(3)
        test.assertIsNone(re.search(r"[\x00-\x08\x0a-\x1f\x7f]", value), line)
        if name == "BEGIN":
            stack.append((value, {}))
            continue
        if name == "END":
            comp, props = stack.pop()
            test.assertEqual(comp, value)
            comps.append((comp, props))
            continue
        stack[-1][1].setdefault(name, []).append((params, value))
        if name in ICS_TEXT:
            # every \\ starts an escape, and ; and , are always escaped
            test.assertIsNone(re.search(r"(?<!\\)(?:\\\\)*[;,]", value.replace("\\\\", "")), line)
            test.assertIsNone(re.search(r"\\[^\;,nN]", value.replace("\\\\", "")), line)
    test.assertEqual(stack, [])
    cal = [p for c, p in comps if c == "VCALENDAR"]
    test.assertEqual(len(cal), 1)
    for k in ("VERSION", "PRODID"):
        test.assertEqual(len(cal[0].get(k, [])), 1, k)
    events = [p for c, p in comps if c == "VEVENT"]
    for ev in events:
        for k in ("UID", "DTSTAMP", "DTSTART"):
            test.assertEqual(len(ev.get(k, [])), 1, k)
        test.assertRegex(ev["DTSTAMP"][0][1], r"^\d{8}T\d{6}Z$")
        (sp, sv), (ep, evv) = ev["DTSTART"][0], ev["DTEND"][0]
        if sp == ";VALUE=DATE":
            test.assertEqual(ep, ";VALUE=DATE")
            test.assertRegex(sv, r"^\d{8}$")
            test.assertGreater(evv, sv)
        else:
            test.assertEqual((sp, ep), ("", ""))
            test.assertRegex(sv, r"^\d{8}T\d{6}Z$")
            test.assertGreater(evv, sv)
        if "URL" in ev:
            test.assertRegex(ev["URL"][0][1], r"^https?://\S+$")
    for c, p in comps:
        if c == "VALARM":
            test.assertEqual(p["ACTION"][0][1], "DISPLAY")
            test.assertIn("DESCRIPTION", p)
            test.assertRegex(p["TRIGGER"][0][1], r"^-PT\d+M$")
    return events


class AuditPass4Tests(Base):
    """Background refresh, rate limits, cache size, .ics strictness, dates."""

    def stale_drivers(self):
        cache = new_cache()
        sf("drivers", cache=cache)
        f = cache_file(cache, "2026/driverstandings")
        age(f, 2 * 3600)
        return cache, f

    def wait_unlocked(self, f, timeout=15):
        end = time.time() + timeout
        while os.path.exists(f + ".lock") and time.time() < end:
            time.sleep(0.05)
        self.assertFalse(os.path.exists(f + ".lock"))

    def env(self, cache, **extra):
        e = dict(os.environ, alfred_workflow_cache=cache, F1_API_BASE=BASE, TZ="Europe/London", time_format="24",
                 date_format="dmy", F1_TEST_NO_OPEN="1", F1_NOW="2026-09-26T15:00:00Z")
        e.update(extra)
        return e

    def test_refresh_survives_alfred_killing_the_script_filter(self):
        cache, f = self.stale_drivers()
        Mock.delay = 1.5
        p = subprocess.Popen(["osascript", "-l", "JavaScript", "./f1.js", "race", "drivers"], cwd=SRC, env=self.env(cache),
                             stdout=subprocess.PIPE, start_new_session=True)
        out = p.stdout.readline()
        # Alfred terminates the previous run on the next keystroke: kill its whole process group
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(p.pid, sig)
            except (ProcessLookupError, PermissionError):
                pass  # the group is already gone (or only a zombie is left)
        p.wait()
        p.stdout.close()
        self.assertEqual(json.loads(out)["rerun"], 0.5)
        self.wait_unlocked(f)
        self.assertLess(time.time() - os.path.getmtime(f), 30)  # the refresh completed
        self.assertNotIn("rerun", sf("drivers", cache=cache, raw=True))

    def test_one_refresher_for_concurrent_keystrokes(self):
        cache, f = self.stale_drivers()
        Mock.delay = 1
        n = Mock.hits.count("2026/driverstandings")
        procs = [subprocess.Popen(["osascript", "-l", "JavaScript", "./f1.js", "race", "drivers" + " " * i], cwd=SRC,
                                  env=self.env(cache), stdout=subprocess.PIPE) for i in range(6)]
        for p in procs:
            self.assertEqual(json.loads(p.communicate()[0])["rerun"], 0.5)
        self.wait_unlocked(f)
        self.assertEqual(Mock.hits.count("2026/driverstandings") - n, 1)

    def test_a_lock_left_by_a_killed_refresher_expires(self):
        cache, f = self.stale_drivers()
        os.mkdir(f + ".lock")
        age(f + ".lock", 60)  # a slow refresh is still running: wait for it
        n = len(Mock.hits)
        self.assertEqual(sf("drivers", cache=cache, raw=True)["rerun"], 0.5)
        time.sleep(0.5)
        self.assertEqual(len(Mock.hits), n)
        age(f + ".lock", 120)  # older than any refresh can take: take it over
        sf("drivers", cache=cache)
        self.wait_unlocked(f)
        self.assertEqual(len(Mock.hits), n + 1)

    def test_keystroke_storm_stays_under_the_rate_limit(self):
        cache = new_cache()
        sf("", cache=cache)  # the schedule
        Mock.times.clear()
        procs = [subprocess.Popen(["osascript", "-l", "JavaScript", "./f1.js", "race", f"results {r}"], cwd=SRC,
                                  env=self.env(cache), stdout=subprocess.PIPE) for r in range(1, 15)]
        for p in procs:
            validate(json.loads(p.communicate()[0]))
        times = sorted(Mock.times)
        self.assertGreater(len(times), 3)
        for i, t in enumerate(times):
            self.assertLessEqual(sum(1 for u in times[i:] if u - t < 1.0), 4, times)  # Jolpica: 4 a second

    def test_hourly_cap(self):
        cache = new_cache()
        os.makedirs(os.path.join(cache, "api"))
        now = time.time() * 1000
        with open(os.path.join(cache, "api", ".rate.json"), "w") as fh:
            json.dump([now - 1000 * i for i in range(400)], fh)
        it = sf("drivers", cache=cache)
        self.assertEqual(it[0]["subtitle"], "Hourly request limit reached: try again later")
        self.assertEqual(Mock.hits, [])

    def test_429_pauses_every_request(self):
        cache = new_cache()
        Mock.mode = "429"
        self.assertIn("rate limiting", sf("drivers", cache=cache)[0]["subtitle"])
        Mock.mode = "ok"
        n = len(Mock.hits)
        self.assertIn("rate limiting", sf("teams", cache=cache)[0]["subtitle"])
        self.assertEqual(len(Mock.hits), n)

    def test_cache_is_pruned(self):
        cache = new_cache()
        api = os.path.join(cache, "api")
        os.makedirs(api)
        os.makedirs(os.path.join(cache, "ics"))
        for i in range(340):
            p = os.path.join(api, f"x_{i}.json")
            with open(p, "w") as fh:
                fh.write("{}")
            age(p, i * 3600)
        old = os.path.join(api, "ancient.json")
        with open(old, "w") as fh:
            fh.write("{}")
        age(old, 61 * 86400)
        ics = os.path.join(cache, "ics", "f1-2026-1-all.ics")
        with open(ics, "w") as fh:
            fh.write("x")
        age(ics, 2 * 86400)
        act("ics:2026:17:all", cache)
        names = os.listdir(api)
        self.assertNotIn("ancient.json", names)
        self.assertLessEqual(len([n for n in names if n.endswith(".json") and not n.startswith(".")]), 300)
        self.assertIn("x_0.json", names)
        self.assertFalse(os.path.exists(ics))
        self.assertTrue(os.path.exists(os.path.join(cache, "ics", "f1-2026-17-all.ics")))

    def ics(self, arg, **env):
        cache = new_cache()
        self.assertEqual(act(arg, cache, **env), "")
        season, rnd, key = arg.split(":")[1:]
        with open(os.path.join(cache, "ics", f"f1-{season}-{rnd}-{key}.ics"), "rb") as fh:
            return fh.read().decode()

    def test_ics_is_strict_rfc5545(self):
        events = check_ics(self, self.ics("ics:2026:17:all"))
        self.assertEqual(len(events), 5)
        check_ics(self, self.ics("ics:2021:10:all"))
        check_ics(self, self.ics("ics:1950:1:all"))

    def test_ics_hostile_names(self):
        doc = fixture("2026/races")
        r = doc["MRData"]["RaceTable"]["Races"][16]
        r["raceName"] = "Back\\slash; comma, \"quote\" line\r\nBEGIN:VALARM\rbell\x07 tab\t é" + "é" * 40 + "😀" * 30 + "é" * 20 + "\ud800 end"
        r["Circuit"]["Location"]["locality"] = "Marina,Bay;\nX"
        r["url"] = "https://en.wikipedia.org/wiki/X\r\nATTACH:http://evil"
        Mock.overrides["2026/races"] = doc
        ics = self.ics("ics:2026:17:all")
        events = check_ics(self, ics)
        self.assertEqual(ics.count("\r\nBEGIN:VALARM\r\n"), 5)
        self.assertNotIn("ATTACH", ics)
        unfolded = ics.replace("\r\n ", "")
        self.assertIn("SUMMARY:F1 Back\\\\slash\\; comma\\, \"quote\" line\\nBEGIN:VALARM\\nbell  tab  é", unfolded)
        self.assertIn("� end: Sprint", unfolded)

    def test_ics_alert_values(self):
        self.assertIn("TRIGGER:-PT7M", self.ics("ics:2026:16:Race", calendar_alert="7.9"))
        self.assertNotIn("VALARM", self.ics("ics:2026:16:Race", calendar_alert="soon"))
        self.assertNotIn("VALARM", self.ics("ics:2026:16:Race", calendar_alert="-5"))

    def test_southern_dst_starts_on_race_day(self):
        # Sydney moves to summer time (+11) at 02:00 local on Sun 4 Oct 2026, hours before the 07:00Z race
        it = sf("", now="2026-10-03T12:00:00Z", tz="Australia/Sydney")
        race = find(it, "Race  ·")
        self.assertEqual(race["title"], f"Race  ·  {local('2026-10-04', '07:00:00Z', 'Australia/Sydney')}")
        self.assertEqual(race["title"], "Race  ·  Sun 4 Oct 18:00")
        self.assertEqual(find(it, "Practice 1")["title"], "Practice 1  ·  Fri 2 Oct 14:30")  # still +10
        self.assertTrue(race["subtitle"].startswith("in 19 h ·"), race["subtitle"])

    def test_date_line_countdown_in_days(self):
        # date-only sessions count calendar days where the user is, even across the date line
        for tz, expected in (("Pacific/Kiritimati", "today"), ("Pacific/Pago_Pago", "tomorrow")):
            it = sf("", now="2021-07-15T12:00:00Z", tz=tz)
            self.assertTrue(it[1]["subtitle"].startswith(expected), (tz, it[1]["subtitle"]))

    def test_month_first_date_format(self):
        it = sf("", date_format="mdy")
        self.assertEqual(it[1]["title"], "Practice 1  ·  Fri Oct 2 05:30")
        it = sf("", now="2025-12-20T12:00:00Z", date_format="mdy")
        self.assertEqual(it[1]["title"], "Practice 1  ·  Fri Mar 6, 2026 01:30")


class FinalReviewTests(Base):
    """Cross-workflow bug classes: prototype keys, display strings, corrupt caches, past-season TTL, test mode."""

    def test_prototype_keys_in_queries_and_api_data(self):
        for q in ("__proto__", "toString", "hasOwnProperty", "results __proto__"):
            self.assertTrue(sf(q))  # no crash, valid JSON
        self.assertEqual(sf("constructor")[0]["title"], "2026 Constructors’ Championship")  # a real alias
        drv, con, races = fixture("2026/driverstandings"), fixture("2026/constructorstandings"), fixture("2026/races")
        drv["MRData"]["StandingsTable"]["StandingsLists"][0]["DriverStandings"][0]["Constructors"][0]["constructorId"] = "constructor"
        con["MRData"]["StandingsTable"]["StandingsLists"][0]["ConstructorStandings"][0]["Constructor"]["constructorId"] = "constructor"
        drv["MRData"]["StandingsTable"]["StandingsLists"][0]["DriverStandings"][0]["Driver"]["nationality"] = "__proto__"
        races["MRData"]["RaceTable"]["Races"][15]["Circuit"]["circuitId"] = "constructor"
        Mock.overrides.update({"2026/driverstandings": drv, "2026/constructorstandings": con, "2026/races": races})
        self.assertNotEqual(sf("teams")[0]["icon"]["path"], "icons/error.png")
        self.assertTrue(sf("drivers")[1]["title"].startswith("1. "))
        head = sf("")[0]
        self.assertNotIn("function", head["arg"])
        self.assertTrue(head["arg"].startswith("open:https://en.wikipedia.org/"))

    def test_titles_drop_bidi_control_and_lone_surrogates(self):
        drv = fixture("2026/driverstandings")
        d = drv["MRData"]["StandingsTable"]["StandingsLists"][0]["DriverStandings"][0]["Driver"]
        d["givenName"] = "Evil\u202e\u2066Name\x07\x85"
        d["familyName"] = "Half\ud83d"
        Mock.overrides["2026/driverstandings"] = drv
        cache = new_cache()
        raw = run_js(["race", "drivers"], cache, "2026-09-26T15:00:00Z")
        self.assertNotRegex(raw, r"\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])")  # no unpaired surrogate escapes
        it = json.loads(raw)["items"]
        for i in it:
            for field in (i["title"], i["subtitle"]):
                self.assertFalse(re.search("[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]", field), field)
        self.assertEqual(it[1]["title"], "1. 🇮🇹 Evil  Name   Half\ufffd  #12")
        # the query is echoed in "no match" titles
        t = sf("drivers \u202exyz")[1]["title"]
        self.assertNotIn("\u202e", t)

    def test_corrupt_cache_values_are_refetched(self):
        for bad in ("[]", "null", "42", '"x"'):
            cache = new_cache()
            os.makedirs(os.path.join(cache, "api"))
            with open(cache_file(cache, "2026/races"), "w") as fh:
                fh.write(bad)
            n = len(Mock.hits)
            self.assertEqual(sf("", cache=cache)[0]["title"], "🇲🇾 Bahrain Grand Prix in Malaysia", bad)
            self.assertEqual(len(Mock.hits), n + 1)

    def test_past_season_cached_mid_season_is_not_kept_for_30_days(self):
        # 2026 standings cached in September must not stand in for the final standings in January 2027
        cache = new_cache()
        sf("2026 drivers", cache=cache)
        f = cache_file(cache, "2026/driverstandings")
        age(f, 30 * 60)
        n = Mock.hits.count("2026/driverstandings")
        sf("2026 drivers", cache=cache, now="2027-01-10T12:00:00Z", F1_SYNC="1")
        self.assertEqual(Mock.hits.count("2026/driverstandings"), n)  # still fresh for an hour
        age(f, 2 * 3600)
        sf("2026 drivers", cache=cache, now="2027-01-10T12:00:00Z", F1_SYNC="1")
        self.assertEqual(Mock.hits.count("2026/driverstandings"), n + 1)
        # data fetched after the season ended keeps the long TTL
        age(f, 2 * 3600)
        n = len(Mock.hits)
        sf("2025 drivers", cache=cache)
        age(cache_file(cache, "2025/driverstandings"), 5 * 86400)
        n = len(Mock.hits)
        sf("2025 drivers", cache=cache, F1_SYNC="1")
        self.assertEqual(len(Mock.hits), n)

    def test_copied_tables_use_singular_points(self):
        head = sf("drivers")[0]
        self.assertIn("Yuki Tsunoda (RB F1 Team) 1 pt\n", head["arg"])
        self.assertNotIn(" 1 pts", head["arg"])

    def test_test_mode_never_uses_the_real_api(self):
        e = {k: v for k, v in os.environ.items() if k not in ("F1_API_BASE", "F1_TEST_NO_OPEN", "F1_SYNC")}
        e.update(alfred_workflow_cache=new_cache(), F1_NOW="2026-09-26T15:00:00Z", TZ="Europe/London")
        out = subprocess.run(["osascript", "-l", "JavaScript", "./f1.js", "race", "drivers"], cwd=SRC, env=e,
                             capture_output=True, text=True, timeout=60)
        self.assertIn("Test mode: F1_API_BASE is not set", out.stdout)


def alfred_env(cache, **extra):
    """Alfred's real environment: no LANG/LC_*, no Homebrew, config values as Alfred passes them."""
    e = {"HOME": os.environ.get("HOME", "/tmp"), "USER": os.environ.get("USER", ""), "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
         "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "alfred_workflow_cache": cache,
         "alfred_workflow_data": os.path.join(cache, "Workflow Data", "io.github.x-o-r-r-o.f1"),
         "alfred_workflow_bundleid": "io.github.x-o-r-r-o.f1", "alfred_workflow_name": "Formula 1", "alfred_version": "5.6",
         "alfred_debug": "0", "keyword_race": "race", "race_page": "f1", "time_format": "system", "date_format": "system",
         "calendar_alert": "15", "F1_API_BASE": BASE, "F1_TEST_NO_OPEN": "1", "F1_NOW": "2026-09-26T15:00:00Z", "TZ": "Europe/London"}
    e.update(extra)
    return e


def run_alfred(args, cache=None, **extra):
    cache = cache or os.path.join(new_cache(), "Caches", "com.runningwithcrayons.Alfred", "Workflow Data", "io.github.x-o-r-r-o.f1")
    out = subprocess.run(["/bin/bash", "-c", 'osascript -l JavaScript ./f1.js "$@"', "_", *args], cwd=SRC,
                         env=alfred_env(cache, **extra), capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return out.stdout


class Round4Tests(Base):
    def test_same_as_macos_formats_without_lang(self):
        # Alfred runs scripts without LANG: the region settings must still decide 12/24 h and day/month order
        cases = {"en_US": "Fri Oct 2 5:30 AM", "en_GB": "Fri 2 Oct 05:30", "de_DE": "Fri 2 Oct 05:30",
                 "zh_TW": "Fri Oct 2 5:30 AM",   # 12-hour with a "B" day period, no "a" in the pattern
                 "hi_IN": "Fri 2 Oct 5:30 AM", "ur_PK": "Fri 2 Oct 5:30 AM",
                 "fa_IR": "Fri 2 Oct 05:30",      # stand-alone month "LLL" after the day
                 "fr_CA": "Fri 2 Oct 05:30", "ja_JP": "Fri Oct 2 05:30"}
        for loc, when in cases.items():
            items = json.loads(run_alfred(["race", ""], F1_LOCALE=loc))["items"]
            self.assertEqual(items[1]["title"], "Practice 1  ·  " + when, loc)
        # without an override the user's own region is used, and the output is still valid
        items = json.loads(run_alfred(["race", ""]))["items"]
        self.assertRegex(items[1]["title"], r"^Practice 1  ·  Fri (2 Oct|Oct 2) (05:30|5:30 AM)$")

    def test_actions_print_nothing_on_success(self):
        cache = new_cache()
        sf("", cache=cache)
        self.assertEqual(run_alfred(["act", "open:https://www.formula1.com/"], cache=cache), "")
        self.assertEqual(run_alfred(["act", "ics:2026:16:all"], cache=cache), "")
        self.assertEqual(run_alfred(["act", "copy:x"], cache=cache), "Copied to the clipboard\n")

    def test_keyword_with_spaces_or_empty(self):
        cache = new_cache()
        for value, shown in (("  gp ", "gp"), ("", "race"), ("Rennen", "Rennen")):
            items = json.loads(run_alfred(["race", ""], cache=cache, keyword_race=value))["items"]
            self.assertTrue(find(items, "Driver Standings")["subtitle"].endswith(f" · {shown} drivers"), value)


class PlistTests(unittest.TestCase):
    def test_build_and_plist(self):
        subprocess.run([sys.executable, "tools/build.py"], cwd=ROOT, check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            p = plistlib.load(f)
        uids = [o["uid"] for o in p["objects"]]
        self.assertEqual(len(uids), len(set(uids)))
        for src, conns in p["connections"].items():
            self.assertIn(src, uids)
            for c in conns:
                self.assertIn(c["destinationuid"], uids)
        for o in p["objects"]:
            kw = o["config"].get("keyword")
            if kw:
                self.assertRegex(kw, r"^\{var:keyword_\w+\}$")
        self.assertEqual(p["bundleid"], "io.github.x-o-r-r-o.f1")
        self.assertTrue(p["readme"].startswith("## Usage"))
        out = subprocess.run(["sips", "-g", "pixelWidth", os.path.join(SRC, "icon.png")], capture_output=True, text=True).stdout
        self.assertGreaterEqual(int(out.split()[-1]), 256)

    def test_no_runtime_dependencies(self):
        with open(os.path.join(SRC, "f1.js")) as fh:
            js = fh.read()
        for bad in ("python", "node ", "ruby", "brew "):
            self.assertNotIn(bad, js.lower())
        self.assertNotIn("api.openf1", js)


if __name__ == "__main__":
    unittest.main(verbosity=1)
