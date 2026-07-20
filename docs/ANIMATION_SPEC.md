# DopaMine — Motion & Visual Spec: "Quiet Luxury / Dark"

Design north star: **rich but never gaudy.** We remove the pachinko/casino feel (neon overload,
screen shake, confetti spam, rainbow blink) and replace it with a single, cohesive, premium motion
language. Reward comes from *timing, restraint, and one satisfying bloom* — not spectacle.

Reference feel: Linear / Arc / Apple. Calm surfaces, one accent, spring motion, moments that breathe.

---

## 1. Design tokens (CSS custom properties → `:root`)

```
/* Surface & depth */
--bg:            #0B0D12;   /* near-black base */
--bg-1:          #10131A;   /* raised panel */
--surface:       rgba(255,255,255,0.04);   /* glass fill */
--surface-2:     rgba(255,255,255,0.06);
--hairline:      rgba(255,255,255,0.08);   /* 1px borders */
--shadow:        0 12px 40px -12px rgba(0,0,0,0.6);  /* soft, large-blur */
--grain:         3% opacity SVG/GPU noise overlay (fixed, pointer-events:none)

/* Text */
--fg:            #ECEEF3;   /* primary */
--fg-2:          #9AA3B2;   /* secondary */
--fg-3:          #5C6472;   /* tertiary / labels */

/* Accent — ONE system accent. Low-saturation aqua-teal. */
--accent:        #6FE0C6;
--accent-dim:    rgba(111,224,198,0.14);   /* glow fills */
--accent-line:   rgba(111,224,198,0.5);

/* Rarity = MATERIAL temperature, not decoration. Used only on loot/level moments. */
--rar-common:    #AEB6C2;  /* cool silver */
--rar-rare:      #6FE0C6;  /* aqua (== accent) */
--rar-epic:      #B79CFF;  /* muted violet */
--rar-legendary: #E4C07A;  /* warm gold — the ONLY warm color, reserved for the big beat */

/* Radius / type */
--r-card: 20px;  --r-chip: 12px;  --r-pill: 999px;
font: system-ui stack; tabular-nums on all numeric counters; weights 400/500/600 only.
```

Rules: max ONE accent on screen at rest. Warm gold appears ONLY at rare/legendary moments. No pure
white fills, no saturated neon, no more than 2 shadow layers. Glass = `backdrop-filter: blur(20px)`
over `--surface` with a `--hairline` border. Add a persistent, near-invisible grain layer for depth.

## 2. Motion language (ONE spring family — everything uses it)

```
--spring:       gentle overshoot, settle. ~1 small overshoot. WAAPI linear() spring or Motion mini
                spring({stiffness:220, damping:26}). Visual duration ~220–280ms.
--spring-soft:  larger elements. spring({stiffness:180, damping:24}). ~300–360ms.
--ease-out:     cubic-bezier(0.22,1,0.36,1)  (exits, dismissals) 160–200ms
--ease-in:      cubic-bezier(0.4,0,1,1)       (rare)
Durations: micro 140 · standard 220 · reveal 340 · legendary beat 700
Stagger: 48ms between sequential elements.
```
Only `transform` + `opacity` + `filter`(sparingly) animate. Never animate layout (width/top/left).
Compose reveals as: **anticipation (tiny) → spring settle → single bloom that fades.** No shake,
no loop-blink, no spin.

## 3. Per-moment choreography

| Moment | Treatment (quiet-luxury) |
|---|---|
| **Screen change** (deck picker ⇄ feed ⇄ sync sheet) | View Transitions API (top-level document): 180ms cross-fade + 6px rise. Reduced-motion → instant. |
| **Card enter** | translateY 12→0, scale 0.985→1, opacity 0→1, `--spring`. Prefetched card sits 1 layer back, dimmed 8%. |
| **Card exit** (after grade) | translateY -8px + fade, `--ease-out` 160ms. No swipe fling. |
| **Reveal answer** | back content: opacity + 8px rise `--spring`; hairline divider draws (scaleX 0→1, 200ms). |
| **Grade press** | button scale 0.96→1 `--spring`; faint `--accent-dim` ripple from touch point (single, fades). |
| **XP reveal** | number springs in, **counts up** via rAF (ease-out, tabular-nums); one soft radial `--accent-dim` glow blooms behind it (scale 0.6→1.4, opacity 0→0.5→0, 520ms). Magnitude scales glow radius **subtly** (±20%), never size of the number. |
| **Combo** | refined accent chip; on increase, scale 1→1.06→1 `--spring` + accent brightens; at high combo (≥10) the accent-line warms ~10% toward gold. On **Again reset**: chip calmly deflates (scale 1→0.94→1, opacity dip) — NO shake, honest and quiet. |
| **Streak** | a single soft mark that slow-breathes (scale 1↔1.04, 3s, `--accent`); on increment one satisfying pulse + faint bloom. |
| **Loot reveal** | token fades+springs in (`--spring-soft`); its surface carries the rarity **temperature** + one slow shimmer sweep (diagonal highlight passes once, 700ms). Common = quick & quiet (~500ms, no shimmer). Rare/Epic = shimmer + soft rarity glow. **Legendary = the beat**: everything else dims to 60% for ~700ms (spotlight), token settles with a slow gold bloom + one low chime; then everything eases back. NO confetti, NO spin, NO flashing. |
| **Level-up** | XP ring completes with `--spring`; one ring-flash bloom; level number flips up (rotateX/translateY spring). Quiet. |
| **Near-miss** (ethics-gated) | honest + subtle: loot slot gives ONE faint glimmer, then calmly resolves to "no drop"; payload `truth:"no_drop"` stays shown. In `no_dark_pattern_mode`: remove the glimmer entirely — plain, immediate. Never a slot-machine "almost!". |
| **Sync 完了 screen** | checkmark draws (stroke-dashoffset, 300ms `--spring`) + soft accent glow; summary fades up staggered. |

Reward event order is unchanged (server-driven): xp_awarded → combo_changed → [streak_changed] →
one of loot_dropped / no_drop / near_miss. Overlay stays non-blocking; total ≤ ~1.4s (legendary ≤ ~2s).

## 4. Tech mapping (from research/animation-ecosystem.md)

- **Motion mini** (`motion` → `import { animate, spring } from "motion/mini"` / `"motion"`, ~2.3kb gz, MIT):
  the single JS dep. Springs on real element refs → works inside Shadow DOM.
- **Native WAAPI** (`el.animate`) for simple keyframes; `linear()` springs where the lib isn't needed.
- **View Transitions API** for top-level screen changes ONLY (not shadow-DOM card faces).
- **Canvas** glow/particle layer: refined — few, soft, additive, short-lived (sparse "embers", not confetti).
- **@property** for animatable gradient stops / counter props where it reads cleaner.
- Keep existing Web Audio; retune to soft, low, short cues (no arcade blips). Haptics stay opt-in, Android-only.

## 5. Guardrails (non-negotiable)

- **prefers-reduced-motion**: springs → 120ms fades or instant; NO particles, NO shimmer, NO count-up
  (show final value), NO screen dim. Everything still fully usable and calm.
- **Shadow DOM**: animate card-face elements via refs (Motion mini/WAAPI). Global blooms/particles live in a
  light-DOM overlay layer stacked above the card. Never inject remote styles.
- **CSP / self-contained**: `motion` bundled by Vite (no CDN). Grain = inline SVG/canvas. No remote fonts.
- **Perf**: transform/opacity/filter only; one shared rAF loop for canvas; cap concurrent tweens; particle
  count small (≤ ~24 common, ≤ ~60 legendary). Target 60fps on a mid phone.
- **Consistency = taste**: one accent at rest, one spring family, generous stagger, let moments breathe.
  When in doubt, do LESS.
