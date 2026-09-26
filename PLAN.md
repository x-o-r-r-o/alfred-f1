# Formula 1 — Plan

**Priority tier:** 3 · **Bundle ID:** `io.github.x-o-r-r-o.f1` · **Keywords:** `race`

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-26):

| Raycast extension | Downloads |
|---|---|
| F1 Standings | 7,717 |
| **Total** | **7,717** |

**Alfred today:** Gallery has NHL/MLB/MLS/UEFA stats workflows (firefingers21) but no F1.

## Features (v1.0)
- [x] `race` next race weekend: every session (FP1–3, Sprint Qualifying/Shootout, Sprint, Qualifying, Race) in local time with a countdown, live/finished markers, TBC for unconfirmed times
- [x] ↩ race page (formula1.com or Wikipedia), ⌥↩ the other one, ⌘↩ add the session or the whole weekend to Calendar (.ics in the cache, with an optional alert)
- [x] Hotkey trigger for the next race weekend
- [x] `race drivers` / `race teams` standings: flags, team colour swatches, gap to the leader, mid-season team changes, filter
- [x] `race results` / `race quali` / `race sprint` [round | race name]: classification, fastest lap, grid gains, Q1–Q3 gaps; Tab to switch session or round
- [x] `race schedule`: past (with winners) / next / upcoming markers, sprint weekends, filter
- [x] `race <year> …` past seasons back to 1950; season menu with the champion
- [x] Cache: schedule 1 day, standings 1 h, results 10 min around a race weekend (6 h otherwise), past seasons 30 days; background refresh; stale data with an offline notice
- [x] Off-season, season boundary, cancelled races, pending results, pre-season standings fallback
- [x] Background refresh: one refresher per cache entry (atomic mkdir lock, 90 s expiry, 60 s deadline), survives Alfred killing the Script Filter; cache pruned daily (60 days, ≤ 300 responses, .ics after a day)
- [x] Date format setting (day or month first, default follows macOS)
- [x] v1.1: add the rest of the season to Calendar (`race schedule`, first row); places and points gained in the last round in the standings; points still available, "out of the title fight" and "has won the title" (2025+ points rules)
- [x] Tests: real API fixtures, mock HTTP server (`F1_API_BASE`), injectable clock (`F1_NOW`), time zones and DST (`TZ`)

## Tech
- **Stack:** JXA (`src/f1.js`) + `/usr/bin/curl`; Jolpica (Ergast successor) API, `api.jolpi.ca/ergast/f1/…` (≤ 100 rows per page, 4 req/s burst and 500 req/h sustained: every response is cached, and a request log shared by all processes caps the workflow at 2 requests per 1.25 s and 400 req/h, pausing for a minute after any HTTP 429). OpenF1 is not needed: Jolpica carries every session time.
- **Dependencies:** None.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel.

## Milestones
1. Script filter prototype for the main keyword
2. Actions + modifiers, Universal Actions / File Actions where relevant
3. Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `python3 tools/build.py --package` release, forum post, then Gallery submission when invited

## Known limitations
- Session times and results come from Jolpica, which updates results a few hours after a session; live timing is out of scope.
- formula1.com race pages use a slug table (2018 onwards); a new circuit without a slug falls back to Wikipedia.
- Session durations (for "live" markers and calendar events) are nominal: FP 60 min, sprint qualifying 45 min, qualifying 60 min, race 120 min (a race stays "next" for 3 h after the start).
- Title-fight maths uses the points system from 2025 on (no fastest-lap point) and is shown only for 2025 and later; it counts a sprint weekend's sprint as still to come even if its points are already in the standings, so it can only overstate what's left, never eliminate someone too early.
- On a completely empty cache, the first `race drivers` makes three requests (standings, schedule, previous round), so the rate limiter spaces them and it takes about 1.3 s once.
- The rate-limiter mutex takes over a lock older than 1 s (it is held for milliseconds; Alfred can kill a run mid-way, since the Script Filter terminates the previous run on each keystroke); two processes that find the same stale lock at the same instant could both pass once (harmless: at most one extra request).

## Verify in real Alfred
- [ ] Hotkey opens the next race weekend; Tab autocompletion on menu, switch and schedule rows.
- [ ] Background refresh survives the next keystroke (rerun 0.5 s) and the stale-data notice disappears afterwards.
- [ ] ⌘↩ opens the .ics in Calendar with the alert from the Workflow’s Configuration; ⌘C and ⌘L on sessions.
- [ ] Flags and team colour icons render; "Same as macOS" time/date formats follow the region settings.
- [ ] The notification after ⌘↩ on a standings/results row says "Copied to the clipboard", and no blank notification appears after ↩ opens a page or ⌘↩ adds to Calendar.
- [ ] `race schedule` first row imports the rest of the season into Calendar (one import dialog).

## Ideas for v1.1
Ranked by value for effort (round-4 audit, 2026-09-27; sources: raycast/extensions issues and CHANGELOG of F1 Standings, Alfred Gallery).
1. Driver season view: ⌥↩ on a driver lists their results this season (`<year>/drivers/<id>/results`, one cached request).
2. Filter a classification by driver or team (`race results monaco hamilton`): today a second word must match a race.
3. Teammate head-to-head (qualifying and race) on team standings rows.
4. Previous winners at the next race's circuit (`circuits/<id>/results/1`) on the next-race header.
5. Pit stops and fastest laps for a race (Jolpica `pitstops`/`laps`), as an extra Tab row on results.
6. Fetch the previous round's standings in the background on a cold cache (saves the one-off ~1.3 s wait).
7. Live session data during a weekend (OpenF1): out of scope today, the most requested thing in F1 apps generally.
8. Add to a chosen calendar without Calendar's import dialog (needs Automation permission for Calendar; the .ics route avoids that on purpose).

## Release checklist (Alfred forum + Gallery)
Sources: alfred.app/submit, alfred.app/submit/styleguide, alfred.app/submit/screenshots, alfredforum.com topics 23976 and 23388.

- [x] README starts with `## Usage`; each paragraph ends "via the `kw` keyword" / "via the Universal Action"
- [ ] A clean screenshot (window only, transparent background, real-looking data, no other workflows) after each paragraph, stored in `images/`
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.`; Quick Look written as <kbd>⌘</kbd><kbd>Y</kbd>
- [x] `## Setup` only for genuine manual steps (no app installs or API keys; the Gallery lists those)
- [x] Every keyword is ≥ 3 characters and configurable via `{var:keyword_*}`
- [x] Settings in Workflow Configuration; the info.plist `readme` (About This Workflow) matches README.md
- [x] Main icon ≥ 256×256 px
- [x] No self-updater; never download or install software (no pip/brew/curl of binaries); dependencies declared for Alfred to handle
- [x] Any compiled binary is Developer ID signed + notarised; never strip quarantine
- [x] No hard-coded paths; `prefs.plist` is git-ignored; secrets stay in Keychain
- [x] AI assistance disclosed in the README (forum post still to write)
- [ ] Version bumped in `workflow.json`; `python3 tools/build.py --package`; GitHub release with the `.alfredworkflow` attached
- [ ] Forum post in "Share your Workflows" with a screenshot, keywords, and the GitHub link
