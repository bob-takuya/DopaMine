You are Codex, implementing the REWARD choreography for DopaMine's "Quiet Luxury / Dark" redesign (wave 2).
Read docs/ANIMATION_SPEC.md (§2 motion language, §3 the reward moments, §5 guardrails) and frontend/src/motion.ts
(the shared helpers you MUST use: reduceMotion, SPRING, SPRING_SOFT, EASE_OUT, animate, enter, exit, press, countUp,
bloom, viewTransition, and the #fx-layer). Vanilla TS, mobile, cards in Shadow DOM, strict CSP, no network.

REMINDER: `motion` is already installed. NEVER run npm install (sandbox has no network). You also cannot bind ports,
so DON'T run playwright — just run `npm run build` to verify types; Claude will run the E2E + visual check.

Refactor TWO files to the refined, NON-gaudy choreography. Keep the server-driven reward event order and payloads
EXACTLY (xp_awarded → combo_changed → optional streak_changed → one of loot_dropped/no_drop/near_miss); render what
the server sends, never reroll. Everything transform/opacity/filter only, cancel-safe, reduced-motion aware.

1. frontend/src/components/reward-overlay.ts — replace the current slot-machine feel with:
   - **XP**: number springs in and COUNTS UP via motion.ts countUp(); ONE soft radial bloom() behind it
     (accent), radius scaled ±20% by amount. No number-size flashing.
   - **Combo**: refined accent chip; on increase scale 1→1.06→1 (SPRING) + accent brightens; combo ≥10 warms the
     accent-line ~10% toward gold. On Again reset: calm deflate (scale 1→.94→1 + opacity dip), NO shake.
   - **Streak**: one satisfying pulse + faint bloom on increment (the persistent breathing lives in the HUD).
   - **Loot**: material reveal — token fades+springs in (SPRING_SOFT), surface carries the rarity TEMPERATURE
     (--rar-common/rare/epic/legendary) + ONE slow diagonal shimmer sweep (~700ms). Common = quick, no shimmer.
     **Legendary = the beat**: dim the rest of the overlay to ~60% for ~700ms (spotlight), token settles with a slow
     gold bloom() + one low chime (effects.ts), then ease back. NO confetti, NO spin, NO flashing.
   - **no_drop**: quiet, immediate, minimal.
   - **near_miss** (ethics): ONE faint glimmer then calmly resolves to "no drop"; keep payload truth:"no_drop"
     visible. If guardrail no_dark_pattern_mode is on, SKIP the glimmer entirely (plain no_drop). (The overlay is
     told the config via its existing inputs / the state; preserve however it currently learns no_dark_pattern_mode.)
   - Overlay stays non-blocking, total ≤ ~1.4s (legendary ≤ ~2s). Use the #fx-layer for global blooms/dim so shadow
     DOM doesn't clip them.
2. frontend/src/effects.ts — refine, don't remove: sparse canvas "embers" (few, soft, additive blend, short life;
   ≤~24 normal, ≤~60 legendary), magnitude-scaled, reduced-motion => none. Retune the Web Audio cues to soft, low,
   short (no arcade blips): a gentle tick on grade, a warm low chime for legendary/level-up, a soft rise for combo.
   Keep haptics opt-in + Android-only (navigator.vibrate no-op on iOS). Expose a small typed API the overlay calls.

Match the existing exported function/class names and how the overlay is invoked from feed/main (grep first) so the
callers keep working. VERIFY with `cd frontend && npm run build` (strict tsc) — fix until clean. Report what changed
per moment and the build result. Only touch reward-overlay.ts and effects.ts.
