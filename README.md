# 🧠⚡ DopaMine — Anki 魔改造 (dopamine-brainrot wrapper for spaced repetition)

DopaMine wraps the **real Anki spaced-repetition ecosystem** in a TikTok/gacha-style dopamine
interface for the ドパガキ generation. You swipe through a vertical feed of flashcards; every grade
is a **real FSRS review** under the hood, then a variable-magnitude reward reveal (XP, combos,
streaks, cosmetic loot) fires on top. **The learning engine is never corrupted — dopamine is purely
cosmetic.**

Built by a mixed **Codex (GPT-5.6 "sol") + Claude** engineering team, orchestrated by Claude.

---

## What makes it "wrap Anki, not replace it"
- The SRS engine sits behind one interface (`AnkiEngine`) with **two real implementations**:
  - **`AnkiLibEngine`** (primary) — drives the actual `anki==26.5` library: your real
    `collection.anki2`, the real V3 scheduler, real FSRS. No Anki desktop required.
  - **`FsrsSqliteEngine`** (fallback) — standalone `fsrs==6.3.1` + SQLite, self-contained.
- Ratings map exactly to Anki: `1=Again, 2=Hard, 3=Good, 4=Easy`.
- No reward mechanic ever changes card order, due dates, ratings, or FSRS parameters.

## The dopamine layer (evidence-based, see `research/addiction-ux.md`)
Variable-magnitude XP reveal (dopamine = prediction error), grade-scaled particles + rising-pitch
audio + opt-in haptics, in-session **combo multiplier** (resets the combo only — never the schedule),
daily **streak** with an **honest streak-freeze**, XP leveling, a **variable-ratio loot roll** with
rarity tiers + a **pity system**, and an ethics-gated **near-miss** reveal (always honestly labeled
`truth:"no_drop"`, never a phantom item).

## Ethics guardrails (transparent + toggleable — `docs/ARCHITECTURE.md §9`)
- `session_length_cap_minutes` (default 20) → `429 SESSION_CAP_REACHED`
- `honest_streak_mode` (default on) → strictly consecutive days, no freeze magic
- `no_dark_pattern_mode` → suppresses near-miss, discloses exact drop odds, adds a deliberate
  "Continue" gate every 10 reviews. All odds + pity counters are inspectable in-app.

---

## Run it (two terminals)

**1. Backend** (Python 3.14; a venv with `anki`, `fsrs`, `fastapi` is at `.venv/`):
```bash
cd anki-addiction
./scripts/dev.sh                       # uvicorn on http://localhost:8000  (fsrs engine by default)
# or point at a real Anki collection:
# DOPAMINE_SRS_ENGINE=anki DOPAMINE_ANKI_COLLECTION=/path/to/collection.anki2 ./scripts/dev.sh
```

**2. Frontend** (Node 22):
```bash
cd anki-addiction/frontend
npm install
npm run dev                            # http://localhost:5173  (proxies /api → :8000)
```
Open http://localhost:5173, tap **Seed demo deck**, and start swiping.
Demo the UI standalone with no backend at all: http://localhost:5173/?mock=1

## Test it
```bash
./.venv/bin/python -m pytest backend/tests/ -q        # 46 passing (both engines + API + rewards)
cd frontend && npm run build                          # clean strict-TS build
```

---

## Architecture at a glance
```
Browser SPA (vertical swipe feed, reward overlay, HUD, audio/haptics/particles)
      │  JSON/HTTP /api  (client-UUID review_id → idempotent answers)
      ▼
FastAPI  ──►  answer coordinator (write-lock, HMAC-seeded rewards, pending→complete recovery)
      ├──►  AnkiEngine:  AnkiLibEngine (real anki 26.5 + FSRS)  |  FsrsSqliteEngine (fsrs + sqlite)
      └──►  resolve_reward()  (pure, deterministic)  ──►  game.sqlite3 (player/rewards/config)
```
Full contract, reward formulas, and data model: **`docs/ARCHITECTURE.md`**.
Team brief: `docs/TEAM_BRIEF.md`. Verified engine APIs: `backend/ENGINE_NOTES.md`.

## Endpoints
`GET /api/health` · `GET /api/next-card` · `POST /api/answer` · `GET /api/state` ·
`GET /api/decks` · `POST /api/seed-demo` · `PUT /api/config`

## Licensing note
The primary engine links the `anki` library, which is **AGPL-3.0**; this wrapper is subject to
those terms when the Anki engine is used. The `fsrs` fallback path avoids that dependency.

## Repo layout
```
backend/app/srs/     base.py (AnkiEngine protocol) · anki_lib.py · fsrs_sqlite.py
backend/app/game/    rewards.py  (pure deterministic reward engine)
backend/app/         main.py · services/review.py · repository.py · db.py · demo.py · schemas.py
frontend/src/        feed.ts · components/{card-view,hud,reward-overlay}.ts · effects.ts · mock.ts
docs/ · research/ · orchestration/   (team brief, architecture, research, codex transcripts)
```
