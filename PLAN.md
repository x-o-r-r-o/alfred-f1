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
- [x] Tests: real API fixtures, mock HTTP server (`F1_API_BASE`), injectable clock (`F1_NOW`), time zones and DST (`TZ`)

## Tech
- **Stack:** JXA (`src/f1.js`) + `/usr/bin/curl`; Jolpica (Ergast successor) API, `api.jolpi.ca/ergast/f1/…` (≤ 100 rows per page, 4 req/s burst and 500 req/h sustained: every response is cached). OpenF1 is not needed: Jolpica carries every session time.
- **Dependencies:** None.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel.

## Milestones
1. Script filter prototype for the main keyword
2. Actions + modifiers, Universal Actions / File Actions where relevant
3. Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `python3 tools/build.py --package` release, forum post, then Gallery submission when invited

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
