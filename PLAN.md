# Formula 1 — Plan

**Priority tier:** 3 · **Bundle ID:** `com.xorro.f1`

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-26):

| Raycast extension | Downloads |
|---|---|
| F1 Standings | 7,717 |
| **Total** | **7,717** |

**Alfred today:** Gallery has NHL/MLB/MLS/UEFA stats workflows (firefingers21) but no F1.

## Features (v1.0)
- [ ] `f1` next session with local time countdown
- [ ] `f1 drivers` / `f1 teams` standings
- [ ] `f1 results` last race classification

## Tech
- **Stack:** zsh + JXA; Jolpica (Ergast successor) API.
- **Dependencies:** None.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel (universal binaries for any Swift helpers).

## Milestones
1. Script filter prototype for the main keyword
2. Actions + modifiers, Universal Actions / File Actions where relevant
3. Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `build.sh` release, submit to Alfred Gallery + forum post
