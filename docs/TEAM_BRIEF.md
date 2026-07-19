# TEAM BRIEF — Project "DopaMine" (Anki 魔改造)

## Mission
Wrap the existing **Anki** spaced-repetition ecosystem in a **dopamine-driven, brainrot-style
interface** ("ドパガキ向け") so that real, evidence-based learning (FSRS scheduling) happens
*inside* an addictive, TikTok/gacha-flavored engagement loop.

The learning engine must stay legit (real SRS). The *skin* and *reward loop* are engineered
for maximum voluntary engagement.

## Non-negotiable principles
1. **Wrap, don't replace.** Users keep their existing Anki decks/collection. We sit on top of
   the real Anki scheduler (FSRS). Cards, review logs, and scheduling remain Anki-compatible.
2. **Dopamine is the UI, SRS is the engine.** Every review is a real SRS review under the hood;
   the animations/rewards are cosmetic overlays that never corrupt scheduling correctness.
3. **Ship a working MVP** in this repo — runnable locally end to end.
4. **Ethical guardrails present but toggleable** (the brief is intentionally "addictive" but we
   document dark-pattern risks and expose healthy-use limits).

## Team & channels
- **Claude (orchestrator)** — integration, synthesis, final assembly.
- **Research: addiction UX** — evidence-based catalog of engagement mechanics → `research/addiction-ux.md`
- **Research: Anki ecosystem** — how to wrap Anki → `research/anki-ecosystem.md`
- **Codex (gpt-5.6-sol)** — co-architect + subsystem implementer. Driven via `orchestration/ask_codex.sh`.
- **Impl: backend** — FastAPI Anki-wrapper + gamification event engine → `backend/`
- **Impl: frontend** — vertical-swipe dopamine feed → `frontend/`

## Target stack (proposed, confirm in ARCHITECTURE.md)
- Backend: Python FastAPI over the `anki` library (real collection + FSRS) with an AnkiConnect
  fallback adapter. Exposes: get next card, answer card (grade), gamification state.
- Frontend: single-page web app, mobile-first vertical swipe feed, variable-reward reveal,
  streak/XP/combo HUD, sound + haptic hooks. No heavy framework required for MVP.
- Gamification event engine: maps SRS outcomes → reward events (XP, combos, loot, streaks)
  with a variable-ratio reinforcement schedule.

## Definition of done for MVP
- Import/open an Anki collection (or seed a demo deck).
- Serve a card, accept a grade (Again/Hard/Good/Easy), persist via real FSRS.
- Frontend feed shows cards, plays reward loop, tracks streak/XP/combo, survives reload.
- One-command run instructions in README.
