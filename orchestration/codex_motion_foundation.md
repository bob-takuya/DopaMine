You are Codex, building the MOTION FOUNDATION for DopaMine's "Quiet Luxury / Dark" redesign. Read
docs/ANIMATION_SPEC.md carefully — it is the contract (palette, one spring language, guardrails). Vanilla TS + Vite,
mobile-first, cards in Shadow DOM, strict CSP, this is the FOUNDATION only (components come next).

IMPORTANT: `motion` (v12.42.2, the Motion library) is ALREADY INSTALLED in frontend/node_modules and in
package.json dependencies. DO NOT run `npm install` (your sandbox has NO network and it will hang). The mini API is
importable as `import { animate } from "motion/mini"` and springs/utilities from `import { spring, ... } from "motion"`.
Use the venv/local toolchain only; never hit the network.

Build TWO files:

1. frontend/src/motion.ts — the shared motion module every component imports. Export:
   - `reduceMotion(): boolean` — live matchMedia('(prefers-reduced-motion: reduce)').matches.
   - `SPRING` = spring config {stiffness:220, damping:26}; `SPRING_SOFT` = {stiffness:180, damping:24};
     `EASE_OUT = "cubic-bezier(0.22,1,0.36,1)"`. (Import `spring` from "motion" if its generator is needed, else
     express springs via Motion mini's options; verify the actual v12 API by reading node_modules/motion types.)
   - `animate` — re-export from "motion/mini" so components import from one place.
   - `enter(el, opts?)`: translateY 12->0, scale .985->1, opacity 0->1, SPRING. Reduced-motion => opacity 120ms.
   - `exit(el): Promise<void>`: translateY -8px + fade, EASE_OUT 160ms.
   - `press(el)`: scale .96->1 SPRING (reduced-motion no-op).
   - `countUp(el, from, to, opts?)`: rAF ease-out count-up, tabular formatting via textContent; reduced-motion =>
     set final immediately; returns stop(). Cancel-safe.
   - `bloom(x, y, opts?)`: spawn ONE soft radial glow div (uses --accent-dim by default) into the #fx-layer, scale
     0.6->1.4, opacity 0->0.5->0 over ~520ms, then self-remove. opts.color/size/intensity. Reduced-motion no-op.
     THIS is the signature "one bloom" primitive.
   - `viewTransition(fn)`: wrap document.startViewTransition when available AND !reduceMotion(), else run fn directly.
   - Ensure a light-DOM `#fx-layer` fixed container (pointer-events:none, top z-index) exists (create lazily) that
     bloom()/global effects render into — this sits ABOVE the shadow-DOM card so global effects aren't clipped.
   All helpers: transform/opacity/filter only, cancel-safe, degrade under reduced motion. Strong TS types, no `any`.

2. frontend/src/styles.css — overhaul to the spec "Quiet Luxury / Dark":
   - FIRST grep the component .ts files for the CSS class names & custom-property names they use (do not rename what
     they query — only restyle). 
   - Replace/extend :root tokens with the spec palette: --bg #0B0D12, --bg-1 #10131A, --surface rgba(255,255,255,.04),
     --surface-2 .06, --hairline rgba(255,255,255,.08), --shadow 0 12px 40px -12px rgba(0,0,0,.6), --fg #ECEEF3,
     --fg-2 #9AA3B2, --fg-3 #5C6472, --accent #6FE0C6, --accent-dim rgba(111,224,198,.14), --accent-line
     rgba(111,224,198,.5), rarity temps --rar-common #AEB6C2/--rar-rare #6FE0C6/--rar-epic #B79CFF/--rar-legendary
     #E4C07A, radii --r-card 20px/--r-chip 12px/--r-pill 999px. If the current file uses different names (e.g.
     --neon-lime), ADD the new tokens AND alias the old names to the new values so nothing breaks.
   - Add `.glass` utility (surface fill + backdrop-filter blur(20px) + 1px --hairline border + --shadow + radius) and
     a persistent grain overlay (inline SVG feTurbulence data-URI, fixed, pointer-events:none, ~3% opacity).
   - Remove/neutralize the pachinko bits: delete @keyframes shake (or make it a 2px nudge) and remove its usages;
     remove neon-blink/rainbow/hard multi-color glows/saturated borders. Retune pop/floatUp/fadeIn/fadeOut to calm
     (small distances, soft opacity). Deep near-black surfaces, ONE aqua accent, hairlines, soft depth, restraint.
   - Add a `#fx-layer` rule (fixed, inset 0, pointer-events:none, z-index above app) and a `.bloom` base style for
     the bloom primitive (radial-gradient, mix-blend-mode:screen, will-change:transform,opacity).

VERIFY (no network needed): `cd frontend && npm run build` passes; `npx playwright test` — all 7 specs still pass
(this wave must not change component logic or class names). Report motion.ts exports, token changes, what gaudy
elements you removed, and the build/playwright result. Only touch frontend/src/motion.ts and frontend/src/styles.css.
