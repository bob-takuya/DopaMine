You are Codex doing a final CORRECTNESS review of the DopaMine repo you co-designed. Read docs/ARCHITECTURE.md
as the spec of record. Focus ONLY on real, high-confidence defects (not style). Review these areas:

1. Reward engine (backend/app/game/rewards.py) vs ARCHITECTURE §4: XP formula, combo multiplier cap,
   Again-resets-combo, level formula, streak (same-day/gap/freeze), loot probabilities & highest-tier-first
   single roll, pity at 20th/100th with reset semantics, near-miss suppression in no_dark_pattern_mode,
   and event ordering. Flag any deviation.
2. Coordinator (backend/app/services/review.py): idempotency (replay identical, 409 on reuse-with-different-
   card/rating), HMAC rng_seed derivation, pending→complete recovery not double-answering, session-cap 429.
3. Engine correctness: anki_lib.py rating mapping (Anki CardAnswer.Rating is 0-indexed 0..3; our Rating is 1..4 —
   confirm the mapping is correct and not off-by-one) and fsrs_sqlite.py due/next-card semantics.
4. Contract drift: does frontend/src/types.ts match backend/app/schemas.py response shapes (§5)? Check
   /api/answer response {review_id, srs, rewards[], state} and /api/state {state, guardrails, srs} field names.

Output a concise numbered list of any CONFIRMED bugs with file:line and a one-line fix each. If a section is
correct, say "OK" for it. Do not modify files (read-only). Keep it short and high-signal.
