You are Codex on the DopaMine team. We are implementing the architecture you wrote in docs/ARCHITECTURE.md. Read it first (sections 3, 4, 7 especially). Also read docs/TEAM_BRIEF.md.

Implement ONLY these two dependency-free backend pieces now (no external packages beyond stdlib + pytest):

TASK A — SRS engine boundary
- Create backend/app/__init__.py, backend/app/srs/__init__.py
- Create backend/app/srs/base.py EXACTLY per Architecture §3: Rating, CardView, AnswerResult, DeckInfo, SrsStats dataclasses (frozen) and the AnkiEngine Protocol with the five methods.
- Create backend/tests/__init__.py and backend/tests/test_srs_contract.py: a tiny in-memory fake engine implementing AnkiEngine to prove the Protocol is satisfiable, plus tests asserting method signatures/return types and that ratings 1..4 are accepted and 0/5 raise or are typed out.

TASK B — Gamification reward engine (pure, deterministic)
- Create backend/app/game/__init__.py and backend/app/game/rewards.py implementing EXACTLY the reward rules in Architecture §4:
  * ReviewEvent dataclass (review_id, card_id, rating, answered_at, local_date, rng_seed) and PlayerState dataclass matching §4/§7 canonical stored fields (total_xp, combo, streak_days, last_active_date, rare_pity, legendary_pity, inventory dict, session_started_at, session_review_count, version) plus derived level via a helper.
  * RewardEvent dataclass (event_id, review_id, type, created_at, payload) — event_id/created_at may be filled by caller; the pure function should produce type+payload+event_index ordering deterministically.
  * resolve_reward(review_event, player_state) -> (new_player_state, list[RewardEvent]) — pure, seeds random.Random(int.from_bytes(sha of rng_seed)) — derive a deterministic int seed from rng_seed string (do NOT read wall clock or global random).
  * Implement: base XP {1:4,2:8,3:10,4:12}; combo multiplier min(2.0, 1+0.10*floor(combo_before/5)); floor(base*mult); Again resets combo to 0 else +1. Level = floor(sqrt(total_xp/100))+1.
  * Streak logic per §4 with honest_streak_mode flag (pass config into resolve_reward via a small RewardConfig arg: honest_streak_mode, no_dark_pattern_mode). Freeze consumption only when honest_streak_mode is False.
  * Loot roll: Common 10%, Rare 3%, Epic 0.8%, Legendary 0.2%, no-drop 86%, highest tier first with ONE roll; pity: 20th consecutive no-Rare+ forces Rare-or-better (Rare75/Epic20/Leg5), 100th consecutive no-Legendary forces Legendary; counters reset on drop at/above tier else increment. Item pools per §4. streak_freeze added to inventory only when honest_streak_mode is False.
  * Near-miss: on no-drop, second seeded roll prob min(0.25, 0.05+0.01*rare_pity) emits near_miss (payload truth="no_drop", teased_tier="rare"), suppressed in no_dark_pattern_mode.
  * Event ordering: xp_awarded, combo_changed, optional streak_changed, then exactly one of loot_dropped | no_drop | near_miss.
- Create backend/tests/test_rewards.py with: determinism (same rng_seed => identical result), combo growth+reset, level formula boundaries, streak increment/same-day/gap-reset and freeze consumption, pity forcing at the 20th/100th, no-dark-pattern suppresses near-miss, and XP math.

Constraints: Python 3.14, stdlib only + pytest. Make it importable and run `python3 -m pytest backend/tests/test_srs_contract.py backend/tests/test_rewards.py -q` — create backend/pyproject.toml or conftest as needed so imports resolve (add backend to sys.path via a tests/conftest.py). Actually run the tests and fix until green. Report the final pytest output in your last message.
