# DopaMine

A personal experiment that wraps real Anki spaced-repetition scheduling (FSRS) in a TikTok/gacha-style swipe-and-reward interface — the rewards are cosmetic and never touch the schedule.

> 日本語要約: Anki の FSRS 復習をそのまま裏で動かしつつ、TikTok／ガチャ風の「報酬演出」を被せた個人用の学習ツール実験（MVP）。

## Status

**MVP — built over two days (2026-07-19/20), single-user, not in active development.** The core loop works locally; deployment paths and some features are untested outside the original machine.

| | |
|---|---|
| Works | Backend: FastAPI app with two SRS engines — `AnkiLibEngine` (drives the real `anki` Python library, V3 scheduler + FSRS) and `FsrsSqliteEngine` (standalone `fsrs` + SQLite). Backend test suite: **84 passed** (re-run 2026-09-28 on Python 3.12 with `anki` 26.9.3 / `fsrs` 6.3.2, from the repo root). |
| Works | Reward layer (`backend/app/game/rewards.py`): XP, combo, streak, loot roll with pity counters, near-miss flag; ethics toggles (`session_length_cap_minutes` → `429 SESSION_CAP_REACHED`, `honest_streak_mode`, `no_dark_pattern_mode` with a "Continue" gate every 10 reviews). Covered by unit tests. |
| Works | `.apkg` import (legacy and zstd `anki21b` packages, media + CSS), media serving, template rendering — covered by backend tests with fixture decks. |
| Works | Frontend (Vite + TypeScript) strict build (`npm run build`) succeeds; in-browser mock mode (`?mock=1`) needs no backend. |
| Partial | AnkiWeb sync endpoints exist (Anki engine only) but are tested against fakes; not verified here against a live AnkiWeb account. |
| Partial | Playwright E2E specs (6 specs in `frontend/e2e/`). Paths are now resolved relative to the repo, but the suite has not been re-run since then. |
| Partial | Deployment configs (`Dockerfile`, `fly.toml`, `railway.json`, GitHub Pages workflow) are included but were not verified for this README. |
| Known issues | `scripts/dev.sh` / `serve.sh` expect a virtualenv at `.venv/` in the repo root (not committed). Backend tests resolve fixture paths relative to the working directory — run them from the repo root. `frontend/dist/` is committed. |

**Development note:** the repository states it was built by a mixed Codex + Claude agent team orchestrated by Claude. The agent prompts, notes and logs are kept in `orchestration/` for transparency.

## Background

A personal learning-tool experiment: can the "variable reward" mechanics of short-video feeds and gacha games make daily flashcard review more engaging *without* corrupting the learning algorithm? The design rule is that the SRS engine is the source of truth; the dopamine layer only decorates it. Background notes are in `research/` (`addiction-ux.md`, `anki-ecosystem.md`, `animation-ecosystem.md`).

## How it works

- **Wrap Anki, don't replace it.** The SRS engine sits behind one interface (`backend/app/srs/base.py`). Ratings map exactly to Anki (`1=Again, 2=Hard, 3=Good, 4=Easy`). No reward mechanic changes card order, due dates, ratings, or FSRS parameters.
- **Reward layer.** Variable-magnitude XP reveal, grade-scaled particles/audio (opt-in haptics), in-session combo (resets the combo only, never the schedule), daily streak, XP levels, a variable-ratio loot roll with rarity tiers and a pity system, and a near-miss reveal that is always labeled honestly (`truth: "no_drop"`). Rewards are seeded per review via HMAC, so they are deterministic and idempotent.
- **Ethics guardrails** are transparent and toggleable (`docs/ARCHITECTURE.md` §9); drop odds and pity counters are inspectable in-app.
- **Display prefs** (device-local): card font size and an optional per-card timer.

```
Browser SPA (vertical swipe feed, reward overlay, HUD, audio/haptics/particles)
      │  JSON/HTTP /api  (client-UUID review_id → idempotent answers)
      ▼
FastAPI ──► answer coordinator (write-lock, HMAC-seeded rewards, pending→complete recovery)
      ├──► AnkiEngine: AnkiLibEngine (anki + FSRS) | FsrsSqliteEngine (fsrs + sqlite)
      └──► resolve_reward() (pure, deterministic) ──► game.sqlite3 (player/rewards/config)
```

Endpoints: `GET /api/health` · `GET /api/next-card` · `POST /api/answer` · `GET /api/state` · `GET /api/decks` · `POST /api/seed-demo` · `POST /api/import` · `GET /api/media/{name}` · `PUT /api/config` · `POST /api/sync/login` · `POST /api/sync` · `POST /api/sync/full` · `GET /api/sync/status` · `POST /api/sync/logout`.

Full contract, reward formulas and data model: `docs/ARCHITECTURE.md`. Import/E2E design: `docs/IMPORT_AND_E2E.md`. Engine API notes: `backend/ENGINE_NOTES.md`.

## Usage

Requirements: Python ≥ 3.12, Node 22.

**Backend**
```bash
python -m venv .venv && . .venv/bin/activate
pip install -e "backend[dev]"
cp backend/.env.example backend/.env      # set DOPAMINE_SERVER_SECRET to a real value
./scripts/dev.sh                          # uvicorn on :8000, FSRS engine by default
# real Anki collection instead:
# DOPAMINE_SRS_ENGINE=anki DOPAMINE_ANKI_COLLECTION=path/to/collection.anki2 ./scripts/dev.sh
```

**Frontend**
```bash
cd frontend && npm install
npm run dev          # http://localhost:5173 (proxies /api → :8000)
```
Open the page, tap **Seed demo deck**, and swipe. `http://localhost:5173/?mock=1` runs the UI with no backend.

**Phone on the same Wi-Fi:** `./scripts/serve.sh` builds the SPA and serves API + UI from one server on `0.0.0.0:8000`. Over plain HTTP the offline service worker does not register (secure context only); the app still works.

**Static demo (GitHub Pages):** `.github/workflows/pages.yml` builds `npm run build:demo`, which forces mock mode — swipe/grade/reward is playable but faked in the browser (no real FSRS, import, media or sync). Local build: `cd frontend && DOPAMINE_BASE=/DopaMine/ npm run build:demo`.

**Hosted:** see `docs/DEPLOY.md` (Docker image; Fly.io / Railway options). Unverified.

**Tests**
```bash
python -m pytest backend/tests/ -q    # run from the repo root
cd frontend && npm run build          # strict TS build
# npm run e2e   (needs the backend venv at .venv/; not re-run recently, see Status)
```

## Repo layout
```
backend/app/srs/     base.py (engine protocol) · anki_lib.py · fsrs_sqlite.py
backend/app/game/    rewards.py (pure deterministic reward engine)
backend/app/         main.py · services/review.py · repository.py · db.py · demo.py · schemas.py
backend/tests/       pytest suite + .apkg fixtures
frontend/src/        feed.ts · components/{card-view,hud,reward-overlay}.ts · effects.ts · motion.ts · mock.ts
docs/                architecture, import/E2E contract, deploy, animation spec, team brief
research/            background research notes
orchestration/       agent prompts, notes and logs from the build
```

## Related

- [Anki](https://apps.ankiweb.net/) and its Python library (`anki`)
- [FSRS](https://github.com/open-spaced-repetition) / `fsrs` Python package

## License

AGPL-3.0 — see [LICENSE](LICENSE). The primary engine links the `anki` library, which is itself AGPL-3.0, so this project uses the same license.
