You are the CO-ARCHITECT (GPT-5.6 Codex "sol") on a team led by Claude. We are building "DopaMine":
an app that wraps the existing Anki spaced-repetition ecosystem in a dopamine-driven, TikTok/gacha/brainrot
style interface for Gen-Z ("ドパガキ"). Real FSRS scheduling under the hood; addictive engagement loop on top.

FIRST read docs/TEAM_BRIEF.md in this repo for full context and principles.

Your job: produce a crisp, buildable technical architecture we can implement THIS session as a
locally-runnable MVP. Assume: python 3.14 + node 22 available; Anki desktop NOT installed.
Engine plan (a parallel research agent is verifying): prefer the `anki` python lib for a real
collection + FSRS; fall back to `py-fsrs` + a small SQLite store if `anki` won't install on py3.14.
Design the backend so the SRS engine is behind an interface (AnkiEngine) with two implementations
(AnkiLibEngine, FsrsSqliteEngine) so we are not blocked on the install question.

Deliver docs/ARCHITECTURE.md covering, concretely:

1. **Product concept** in 5 sentences: the core loop a user experiences (open app → vertical swipe
   feed of cards → grade card → variable reward reveal → streak/XP/combo → next card).

2. **System diagram** (ASCII): frontend (vertical-swipe SPA) ⇄ FastAPI backend ⇄ SRS engine + gamification engine + SQLite for gamification state.

3. **SRS engine interface** (`AnkiEngine`): exact method signatures for
   `next_card(deck)`, `answer_card(card_id, rating)`, `add_note(...)`, `deck_list()`, `stats()`.
   Ratings map to Anki's 1=Again,2=Hard,3=Good,4=Easy.

4. **Gamification event engine**: a pure function `resolve_reward(review_event, player_state) -> reward_events[]`.
   Define the reward model: XP formula, combo multiplier, streak logic, a VARIABLE-RATIO loot/gacha
   roll with rarity tiers + a pity system, and "near-miss" reveal. Define player_state schema.

5. **REST API contract**: list endpoints with method, path, request JSON, response JSON. Must include
   GET /api/next-card, POST /api/answer, GET /api/state, GET /api/decks, POST /api/seed-demo.

6. **Frontend architecture**: how the vertical-swipe feed works, the reward-reveal overlay, the HUD
   (streak/XP/combo/level), sound+haptic hooks, and offline-friendly state. MVP with minimal deps.

7. **Data model**: player_state, reward_events, config (SQLite tables or JSON).

8. **Implementation plan**: an ordered task list split into BACKEND tasks and FRONTEND tasks, each
   small enough for one agent, with a clear file path per task. Mark which tasks Codex will own vs Claude's agents.

9. **Ethical guardrails**: a toggle set (session length cap, honest-streak mode, no-dark-pattern mode)
   and where they hook in.

Be decisive and specific — real signatures, real JSON, real formulas. Keep it implementable today.
Write the file to docs/ARCHITECTURE.md and end your final message with a 12-line executive summary.
