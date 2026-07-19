# DopaMine MVP Architecture

## 1. Product concept

DopaMine opens directly into a mobile-first, vertical-swipe feed containing the next due card from a real FSRS scheduler. The user reveals the answer, then grades the card with Anki's four ratings: Again, Hard, Good, or Easy. That grade is committed to the SRS engine before any cosmetic reward is calculated. A short variable-reward reveal awards XP and may reveal loot, while the HUD updates the user's streak, combo, and level. The next due card is prefetched and becomes the next feed item, so the learning loop continues without a page transition.

## 2. System shape

```text
+----------------------------------+
| Browser: vertical-swipe SPA      |
| feed, reveal, grading, HUD, audio|
+----------------+-----------------+
                 | JSON/HTTP (/api)
                 v
+----------------------------------+
| FastAPI backend                  |
| routes + transaction coordinator |
+------------+-----------+---------+
             |           |
       SRS boundary       | pure reward resolution
             v           v
+------------------+  +-----------------------+
| AnkiEngine       |  | Gamification engine   |
|                  |  | resolve_reward(...)   |
| AnkiLibEngine OR |  +-----------+-----------+
| FsrsSqliteEngine |              |
+--------+---------+              v
         |                 +------------------+
         |                 | game.sqlite3     |
         v                 | player/rewards/  |
  collection.anki2 OR      | config/reviews   |
  srs.sqlite3              +------------------+
```

The backend selects an engine using `DOPAMINE_SRS_ENGINE=anki|fsrs` and exposes no implementation-specific objects. Default to `anki` if it imports and can open a collection; otherwise fail with an actionable startup message unless the operator explicitly selects `fsrs`. Both databases live under `DOPAMINE_DATA_DIR` (default `./data`). For the MVP, FastAPI is a single process with one application-level write lock; this avoids cross-database race conditions while keeping each answer idempotent.

## 3. SRS engine boundary

`backend/app/srs/base.py` defines the only interface routes may use. All timestamps are timezone-aware UTC `datetime`s; `deck` is the stable deck name, and IDs are opaque strings at the API boundary so Anki integer IDs and fallback UUIDs can coexist.

```python
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Mapping, Protocol, Sequence

Rating = Literal[1, 2, 3, 4]  # Again, Hard, Good, Easy

@dataclass(frozen=True)
class CardView:
    card_id: str
    note_id: str
    deck: str
    front_html: str
    back_html: str
    tags: tuple[str, ...]
    due_at: datetime | None

@dataclass(frozen=True)
class AnswerResult:
    card_id: str
    rating: Rating
    answered_at: datetime
    next_due_at: datetime
    interval_days: float

@dataclass(frozen=True)
class DeckInfo:
    name: str
    due_count: int
    total_count: int

@dataclass(frozen=True)
class SrsStats:
    due_now: int
    reviewed_today: int
    total_cards: int
    retention: float | None

class AnkiEngine(Protocol):
    def next_card(self, deck: str | None = None) -> CardView | None: ...
    def answer_card(self, card_id: str, rating: Rating) -> AnswerResult: ...
    def add_note(
        self,
        deck: str,
        fields: Mapping[str, str],
        tags: Sequence[str] = (),
        model: str = "Basic",
    ) -> Sequence[str]: ...  # created card IDs
    def deck_list(self) -> Sequence[DeckInfo]: ...
    def stats(self, deck: str | None = None) -> SrsStats: ...
```

Ratings map exactly to Anki: `1=Again`, `2=Hard`, `3=Good`, `4=Easy`. `next_card` returns the scheduler's next currently available card, not a random card; the UI may animate variety but may not reorder scheduler output. `answer_card` must reject a nonexistent or not-currently-answerable card and must perform one real scheduler review. The route layer serializes calls with a lock and provides request idempotency rather than weakening this rule.

`AnkiLibEngine` in `backend/app/srs/anki_lib.py` opens an Anki collection, enables FSRS in collection configuration, asks Anki's scheduler for a card, and delegates answering to the scheduler APIs. `FsrsSqliteEngine` in `backend/app/srs/fsrs_sqlite.py` uses `py-fsrs` and `srs.sqlite3`; it preserves the same semantics but is explicitly a local fallback, not an `.anki2` compatibility claim. It stores note fields as JSON, one FSRS state per card, and a complete review log so migration remains possible.

## 4. Gamification event engine

The domain function in `backend/app/game/rewards.py` has no database, clock, or global-random access:

```python
def resolve_reward(
    review_event: ReviewEvent,
    player_state: PlayerState,
) -> tuple[PlayerState, list[RewardEvent]]: ...
```

`ReviewEvent` contains `review_id`, `card_id`, `rating`, `answered_at`, `local_date` (`YYYY-MM-DD` in the configured timezone), and `rng_seed`. The returned state is a new value; persistence is the caller's responsibility. Seed a local `random.Random` from `rng_seed`, which the answer coordinator derives as `HMAC_SHA256(server_secret, review_id)`. This makes retries reproduce the same rewards without letting the client choose outcomes.

### Reward rules

- Base XP by rating is `{1: 4, 2: 8, 3: 10, 4: 12}`. The combo multiplier is `min(2.0, 1.0 + 0.10 * floor(combo_before / 5))`; awarded XP is `floor(base_xp * multiplier)`. Again resets combo to `0`; any other rating increments it by one. XP never affects SRS scheduling.
- Level is derived, not independently mutated: `level = floor(sqrt(total_xp / 100)) + 1`; progress spans `100 * (level-1)^2` through `100 * level^2 - 1`.
- A qualifying study day is a local calendar day with at least one committed review. First review sets streak to `1`; the same date leaves it unchanged; exactly one day after `last_active_date` increments it; a larger gap resets it to `1`. With `honest_streak_mode=false`, one owned streak-freeze is consumed instead of resetting after a gap; with it enabled, no freezes are used or awarded.
- Each committed review performs one variable-ratio loot roll. Base probabilities are Common `10%`, Rare `3%`, Epic `0.8%`, Legendary `0.2%`, and no drop `86%`; select at most one tier using one roll, highest tier first. Pity overrides the roll to Rare-or-better on the 20th consecutive no-Rare+ review and Legendary on the 100th consecutive no-Legendary review. A pity-forced Rare roll uses Rare `75%`, Epic `20%`, Legendary `5%`; Legendary pity is guaranteed Legendary. Counters reset on a drop at or above their tier and otherwise increment.
- Loot is cosmetic and represented by a stable item code selected uniformly from the configured tier pool. The MVP pools are `common: [spark, slime]`, `rare: [neon_cat, streak_freeze]`, `epic: [golden_brain, glitch_aura]`, and `legendary: [dopamine_crown]`. `streak_freeze` increments inventory by one only when honest-streak mode is off.
- A near-miss is presentation, never a second chance or a concealed probability change. On a no-drop result, use a second seeded roll with probability `min(0.25, 0.05 + 0.01 * rare_pity)` to emit `near_miss` with `teased_tier="rare"`; its payload must include `truth="no_drop"`, and no inventory changes. Disable this event in no-dark-pattern mode.

Reward events are emitted in order: `xp_awarded`, `combo_changed`, optional `streak_changed`, then exactly one of `loot_dropped`, `no_drop`, or `near_miss` (the near-miss replaces the plain no-drop presentation event). Every event has `event_id`, `review_id`, `type`, `created_at`, and a JSON payload. The UI must render the payload it receives and must not reroll.

### Player state schema

```json
{
  "player_id": "local",
  "total_xp": 340,
  "level": 2,
  "combo": 7,
  "streak_days": 4,
  "last_active_date": "2026-07-19",
  "rare_pity": 6,
  "legendary_pity": 42,
  "inventory": {"spark": 2, "streak_freeze": 1},
  "reviews_today": 18,
  "session_started_at": "2026-07-19T04:00:00Z",
  "version": 23
}
```

`level` and `reviews_today` are response projections; the stored canonical fields are defined below. `version` increments on every committed answer and supports client reconciliation.

## 5. REST API contract

All responses use JSON and all errors use `{"error":{"code":"...","message":"..."}}`. Client-generated UUID `review_id` makes `POST /api/answer` idempotent: replay returns the original response; reuse with a different card/rating returns `409`. Invalid ratings return `422`, stale/non-answerable cards return `409`, and no due card returns `200` with `card: null`.

### `GET /api/next-card?deck=Japanese`

Request body: none.

```json
{
  "card": {
    "card_id": "1700000000001",
    "note_id": "1700000000000",
    "deck": "Japanese",
    "front_html": "犬",
    "back_html": "dog",
    "tags": ["demo"],
    "due_at": "2026-07-19T04:05:00Z"
  },
  "server_time": "2026-07-19T04:05:02Z"
}
```

### `POST /api/answer`

```json
{
  "review_id": "4ee1c5fc-2bc1-4ce7-880d-32fbdad5fb10",
  "card_id": "1700000000001",
  "rating": 3
}
```

The SRS answer and game update execute under the write lock. Because two SQLite files cannot share a transaction, the coordinator first inserts a `pending` game review, commits the SRS answer, then finalizes rewards and marks it `complete`; recovery finalizes any pending review from its stored SRS result without answering twice.

```json
{
  "review_id": "4ee1c5fc-2bc1-4ce7-880d-32fbdad5fb10",
  "srs": {
    "card_id": "1700000000001",
    "rating": 3,
    "answered_at": "2026-07-19T04:05:10Z",
    "next_due_at": "2026-07-22T04:05:10Z",
    "interval_days": 3.0
  },
  "rewards": [
    {"event_id": "evt_01", "type": "xp_awarded", "payload": {"amount": 11, "multiplier": 1.1}},
    {"event_id": "evt_02", "type": "combo_changed", "payload": {"combo": 7}},
    {"event_id": "evt_03", "type": "loot_dropped", "payload": {"tier": "common", "item": "spark", "pity_forced": false}}
  ],
  "state": {"total_xp": 340, "level": 2, "combo": 7, "streak_days": 4, "rare_pity": 0, "legendary_pity": 43, "inventory": {"spark": 2}, "reviews_today": 18, "version": 23}
}
```

### `GET /api/state`

Request body: none. Returns `{"state": <player-state>, "guardrails": <effective-config>, "srs": <SrsStats>}`. The inventory is included; `session_started_at` and current session review count let the frontend enforce and explain caps.

### `GET /api/decks`

Request body: none.

```json
{"decks":[{"name":"Japanese","due_count":12,"total_count":100}]}
```

### `POST /api/seed-demo`

```json
{"deck":"DopaMine Demo","replace":false}
```

Creates the deck if needed and adds a fixed set of ten Basic notes, tagged `dopamine-demo`. It is idempotent by a stored seed version and never deletes existing user cards; `replace=true` only refreshes notes previously created by this seed operation. Response:

```json
{"deck":"DopaMine Demo","created":10,"existing":0,"card_ids":["demo-1","demo-2"]}
```

### Supporting endpoint

`PUT /api/config` accepts only guardrail fields, for example `{"session_length_cap_minutes":20,"honest_streak_mode":true,"no_dark_pattern_mode":true}`, validates them, persists them, and returns `{"config": <effective-config>}`. CORS is limited to the configured local frontend origin; production is out of MVP scope.

## 6. Frontend architecture

Use a Vite-built TypeScript SPA with no UI framework: `vite`, `typescript`, and browser APIs are enough. `frontend/src/api.ts` owns typed API calls; `store.ts` contains a small observable store; `feed.ts` manages card state; and components are plain custom elements or render functions. This keeps the dependency surface small while retaining compile-time API checks.

The feed keeps at most two slots: the active card and one prefetched card. A card starts in `question`; tap or upward swipe changes it to `answer`; grading is possible only from `answer`. After `POST /api/answer` succeeds, the reward overlay consumes server events in order, the answered card animates out, and the prefetched card becomes active. Input is locked while the answer request is pending, and a failed request leaves the same card visible with a retry action using the same `review_id`.

`RewardOverlay` is a non-blocking 700 ms sequence for XP/combo and a skippable maximum 1.5 s loot reveal. `Hud` renders streak, XP/level progress, combo, and the session-cap indicator from authoritative response state. CSS scroll snap plus Pointer Events handles vertical gestures; keyboard controls are Space to reveal and `1`-`4` to grade. Sound hooks use a lazily initialized Web Audio context and honor `prefers-reduced-motion`, a mute toggle, and no-dark-pattern mode; haptics call `navigator.vibrate()` only after user opt-in and when supported.

Offline-friendly does not mean offline scheduling in this MVP. Cache the app shell with `frontend/public/sw.js`, store the latest player state, config, decks, and ungraded active card in IndexedDB, and display them read-only when the backend is unreachable. Never queue a speculative grade: FSRS scheduling and reward resolution require the server. On reconnect, refetch `/api/state` and `/api/next-card`; server `version` wins over cached HUD state.

## 7. Data model

Gamification state lives in `game.sqlite3` with foreign keys enabled and migrations in `backend/app/db.py`.

```sql
CREATE TABLE player_state (
  player_id TEXT PRIMARY KEY,
  total_xp INTEGER NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
  combo INTEGER NOT NULL DEFAULT 0 CHECK (combo >= 0),
  streak_days INTEGER NOT NULL DEFAULT 0 CHECK (streak_days >= 0),
  last_active_date TEXT,
  rare_pity INTEGER NOT NULL DEFAULT 0,
  legendary_pity INTEGER NOT NULL DEFAULT 0,
  inventory_json TEXT NOT NULL DEFAULT '{}',
  session_started_at TEXT,
  session_review_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE reviews (
  review_id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  answered_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  rng_seed TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  srs_result_json TEXT,
  response_json TEXT
);

CREATE TABLE reward_events (
  event_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  event_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (review_id, event_index)
);

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE seed_runs (
  seed_name TEXT PRIMARY KEY,
  seed_version INTEGER NOT NULL,
  note_ids_json TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
```

Effective config defaults are:

```json
{
  "timezone": "Asia/Tokyo",
  "session_length_cap_minutes": 20,
  "honest_streak_mode": true,
  "no_dark_pattern_mode": false,
  "sound_enabled": true,
  "haptics_enabled": false
}
```

The fallback `srs.sqlite3` separately contains `notes`, `cards`, and `review_log`; only `FsrsSqliteEngine` knows that schema. The Anki implementation owns `collection.anki2` through Anki APIs and must not issue ad hoc SQL against it.

## 8. Implementation plan

Tasks are intentionally small and path-owned to minimize merge conflicts. **Codex** owns contracts, reward correctness, and the fallback that guarantees Python 3.14 progress. **Claude agents** own the version-sensitive Anki adapter, HTTP/UI assembly, and final integration.

### BACKEND tasks

1. **Codex:** Add domain dataclasses and the `AnkiEngine` protocol in `backend/app/srs/base.py`, plus contract tests in `backend/tests/test_srs_contract.py`.
2. **Codex:** Implement `FsrsSqliteEngine`, its schema, and demo-note support in `backend/app/srs/fsrs_sqlite.py`; test scheduling persistence in `backend/tests/test_fsrs_engine.py`.
3. **Claude Anki agent:** Implement the version-pinned `AnkiLibEngine` in `backend/app/srs/anki_lib.py` after the Python 3.14 install result is known; add `backend/tests/test_anki_engine.py` behind an optional dependency marker.
4. **Codex:** Implement immutable reward models and `resolve_reward` in `backend/app/game/rewards.py`; add boundary, pity, streak, and deterministic-retry tests in `backend/tests/test_rewards.py`.
5. **Claude backend agent:** Add gamification SQLite migrations/repository and pending-review recovery in `backend/app/db.py` and `backend/app/repository.py`.
6. **Claude backend agent:** Add the answer coordinator and idempotency flow in `backend/app/services/review.py`.
7. **Claude backend agent:** Implement the exact API schemas/routes in `backend/app/schemas.py` and `backend/app/main.py`, including engine selection, write lock, errors, and guardrails.
8. **Claude backend agent:** Add the ten-card fixed seed set in `backend/app/demo.py` and API integration tests in `backend/tests/test_api.py`.
9. **Claude integration agent:** Pin conditional dependencies in `backend/pyproject.toml`, add `.env.example`, and supply `scripts/dev.sh` for one-command local startup.

### FRONTEND tasks

1. **Claude frontend agent:** Scaffold minimal Vite TypeScript and shell/service worker in `frontend/package.json`, `frontend/index.html`, `frontend/src/main.ts`, and `frontend/public/sw.js`.
2. **Claude frontend agent:** Mirror API types and implement fetch/idempotent retry logic in `frontend/src/api.ts` and `frontend/src/types.ts`.
3. **Claude frontend agent:** Implement authoritative store plus IndexedDB read-only cache in `frontend/src/store.ts` and `frontend/src/cache.ts`.
4. **Claude frontend agent:** Build the two-slot swipe/reveal/grade state machine in `frontend/src/feed.ts` and `frontend/src/components/card-view.ts`.
5. **Claude frontend agent:** Build HUD and reward event renderer in `frontend/src/components/hud.ts` and `frontend/src/components/reward-overlay.ts`.
6. **Claude frontend agent:** Add responsive brainrot visual treatment, reduced-motion behavior, sound, and opt-in haptics in `frontend/src/styles.css` and `frontend/src/effects.ts`.
7. **Claude integration agent:** Add browser smoke tests for reveal, answer retry, overlay, reload, offline read-only mode, and cap modal in `frontend/tests/feed.spec.ts`.

## 9. Ethical guardrails

Guardrails are explicit configuration, returned by `/api/state`, editable through `PUT /api/config`, and visible in a settings sheet rather than hidden.

- `session_length_cap_minutes: integer | null` defaults to `20`. `backend/app/services/review.py` rejects new answers with `429 SESSION_CAP_REACHED` after elapsed wall time reaches the cap; `Hud` shows remaining time and `feed.ts` replaces the next card with a clear stop/extend screen. Extension requires an explicit user action and starts a new session; `null` disables the cap.
- `honest_streak_mode: boolean` defaults to `true`. `resolve_reward` disables freeze consumption and freeze drops when true, so the displayed streak is strictly consecutive study days. When false, any saved streak is labeled “freeze protected” in the HUD and event payload.
- `no_dark_pattern_mode: boolean` defaults to `false`. `resolve_reward` suppresses near-miss events; `RewardOverlay` shows exact drop probabilities and removes suspense delays; `feed.ts` disables infinite auto-advance after a configurable batch of ten reviews and shows a deliberate Continue button; `effects.ts` disables celebratory sound/haptics for no-drop results.

The settings sheet also exposes mute, haptics opt-in, and reduced motion. Reward rarity, pity counters, and probabilities are inspectable in-app. No reward mechanic changes card order, due dates, ratings, or FSRS parameters, and the server never fabricates streak activity.
