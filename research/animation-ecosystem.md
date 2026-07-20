# Web Animation & "Game Juice" Ecosystem for DopaMine (2025–2026)

Research target: **DopaMine** — mobile-first, vanilla TypeScript + Vite SPA (no framework),
cards rendered inside **Shadow DOM**, strict **CSP** (no remote CDN, inline assets only), must
respect `prefers-reduced-motion` and run smoothly on phones. Current juice layer is hand-rolled
Web Audio + canvas particle burst + CSS (`frontend/src/effects.ts`, `frontend/src/styles.css`).

This report verifies library names / APIs / versions as of mid-2026 and ends with a decisive
**RECOMMENDED STACK** plus a per-moment mapping.

---

## 1. Executive summary (12 lines)

1. Keep the existing hand-rolled Web Audio + canvas particle engine — it is already the cheapest, most CSP-safe, Shadow-DOM-agnostic reward layer you can ship.
2. Add **Motion mini** (`motion/mini`, ~2.3 kB gz, MIT) as the one JS animation dep: pure WAAPI, tree-shakeable, works on element refs inside Shadow DOM.
3. Lean on **native WAAPI** (`element.animate`) for 90% of micro-motion; use `linear()`-compiled springs for bouncy XP/loot reveals (Chrome 113+, Safari 17.2+, FF 112+).
4. Use **View Transitions API** for full-screen route changes (feed → deck → profile) only — Safari 18+/iOS 18+ ship it — NOT for the Shadow-DOM card face.
5. Do card swipe/enter/exit yourself with WAAPI transforms; View Transitions snapshot the top-level document and do not compose cleanly with Shadow-DOM `view-transition-name`.
6. **Skip GSAP** for now: superb, and its premium plugins (SplitText, MorphSVG, DrawSVG) went 100% free in April 2025 under Webflow — but ~23–27 kB core is a lot of budget for effects Motion mini + WAAPI already cover on mobile.
7. **Skip a Lottie/Rive runtime for v1.** Rive is the better tech (tiny `.riv`, interactive state machines) but ships a ~200 kB WASM blob and needs `wasm-unsafe-eval` in CSP; defer to a "mascot" milestone.
8. For loot-rarity reveals, canvas particles + a WAAPI scale/glow burst beat any library on bytes; reserve Rive only if you later want an interactive animated mascot.
9. **`canvas-confetti` (6 kB gz, MIT)** is a drop-in upgrade if you want richer bursts without writing more particle code; `tsParticles` (20–100 kB) is overkill.
10. Haptics: `navigator.vibrate` still does **not** work on iOS Safari/WebKit in 2026 (every iOS browser is WebKit) — keep it opt-in, Android-only, and always pair with audio + visual.
11. Apply game-feel principles explicitly: anticipation → squash & stretch → hit-stop (freeze 3–5 frames) → screen shake, scaled by reward magnitude, all gated by reduced-motion.
12. Total added JS budget for the recommended stack: **~2.3 kB gz** (Motion mini) + optional 6 kB (canvas-confetti). Everything else is native platform or code you already own.

---

## 2. Comparison table — JS animation libraries

| Library | Version (2026) | Min gz size | License | Vanilla-TS | Shadow DOM | Mobile perf | Maintenance | Verdict for DopaMine |
|---|---|---|---|---|---|---|---|---|
| **Motion mini** (`motion/mini`) | motion 12.x | **~2.3 kB** | MIT | First-class (TS, tree-shakeable) | ✅ operates on element refs, no global DOM | Excellent — pure WAAPI, GPU-composited | Active (motion.dev, ex-Motion One) | **Adopt** — the sweet spot |
| **Motion hybrid** (`motion`) | 12.x | ~18 kB | MIT | Same | ✅ | Great; JS-driven `transform` independent axes, timelines | Active | Optional if you need timelines/independent transforms |
| **GSAP 3 core** | 3.13.x | ~23–27 kB | **Now free** (Webflow, Apr 2025), incl. SplitText/MorphSVG/DrawSVG/ScrollTrigger | Excellent, framework-agnostic | ✅ | Great but heavier runtime | Very active | **Defer** — power you don't need yet |
| **anime.js** | v4.5.0 | ~10–12 kB (submodule exports) | MIT | Excellent, TS built-in | ✅ | Good | Active | Fine middle option; still bigger than Motion mini |
| **Popmotion / spring physics** | (folded into Motion) | — | MIT | — | — | — | Superseded by Motion springs | Use Motion/WAAPI springs instead |

Notes:
- Motion's **mini `animate`** is WAAPI-only (hardware-accelerated, tiny); the **hybrid `animate`** (~18 kB)
  adds JS-driven independent transforms and timeline sequencing. Import mini via `import { animate } from "motion/mini"`.
- GSAP's plugin liberation is real and significant (SplitText rewritten −50% size, added a11y), but it buys
  text-splitting and SVG morphing you have no v1 use for. Revisit if you build elaborate typographic XP reveals.
- All four are Shadow-DOM-safe because they animate element references you pass in — none rely on
  `document.querySelector` reaching across the shadow boundary. Just query inside your `shadowRoot`.

## 3. Comparison table — native platform APIs (zero-dependency)

| API | Support (mid-2026) | Shadow DOM | Use for | Caveat |
|---|---|---|---|---|
| **WAAPI** `element.animate()` | Universal | ✅ (per-element) | XP counters, combo pulses, squash/stretch, card transforms | Native easings only unless you use `linear()` |
| **`linear()` easing** (springs) | Chrome 113+, FF 112+, Safari 17.2+ | ✅ | Bouncy loot/level-up reveals via compiled spring | Generate the `linear(...)` string (Motion/spring-easing can precompute) |
| **WAAPI `composite: "add"`** | Chrome/FF/Safari | ✅ | Layer screen-shake on top of an existing transform without clobbering | Additive semantics; test stacking |
| **View Transitions (same-document)** | Chrome 111+, Safari **18+ (iOS 18+)**, FF 144+ | ⚠️ **problematic** | Full-screen route/screen swaps only | Snapshots top-level doc; `view-transition-name` inside Shadow DOM is unresolved spec territory — do not use for card face |
| **`@property`** (animatable custom props) | Broad (Chrome/Safari/FF) | ✅ | Animate gradient stops, glow intensity, progress rings | Register `syntax`/`initial-value` |
| **`@starting-style`** | Chrome 117+, Safari 17.5+, FF 129+ | ✅ | Enter animations for popovers/toasts (loot card mount) | Newer FF/Safari only |
| **Scroll-driven** `animation-timeline` | Chrome solid; Safari/FF **partial/behind** in 2025–26 | ✅ | Feed-scroll parallax (progressive enhancement) | Not baseline — feature-detect, degrade gracefully |
| **`offset-path` / motion path** | Broad | ✅ | Coins/gems flying to an HUD counter (Vampire-Survivors feel) | Cheap and effective |

**Key ruling for DopaMine:** View Transitions are excellent for *screen-level* navigation but are a
top-`document` mechanism. Because your card renders inside a Shadow DOM and the API snapshots the host
document's viewport (and Shadow-DOM naming is unsettled), keep card swipe/enter/exit on hand-rolled WAAPI
transforms and reserve View Transitions for route changes at the light-DOM app shell.

## 4. Comparison table — vector/rig animation (Rive vs Lottie)

| | **Rive** (`@rive-app/canvas` / `canvas-lite` / `webgl2`) | **Lottie** (`lottie-web` / `dotLottie`) |
|---|---|---|
| Runtime size | **~200 kB gz** (WASM); `canvas-lite` smaller (drops native text) | `lottie-web` ~60 kB gz; `dotLottie` ~50 kB |
| Asset file size | Tiny `.riv` binary (often 10–15× smaller than equivalent Lottie JSON) | Large JSON (`.lottie`/dotLottie zips it) |
| Interactivity | **State machines** (inputs, triggers) — true for reward reveals reacting to rarity | Historically playback-only; **dotLottie state machines** added late 2025 |
| CSP / self-host | Needs **`wasm-unsafe-eval`**; self-host `rive.wasm` and call `RuntimeLoader.setWasmFallbackUrl(null)` to kill the **CDN fallback** (or pass the WASM as an ArrayBuffer to inline it) | Pure JS; no WASM; CSP-friendly (no `unsafe-eval`) |
| Shadow DOM | ✅ renders into a `<canvas>` you place anywhere, incl. shadowRoot | ✅ (SVG/canvas renderer into your element) |
| Best at | Interactive animated mascot / loot chest that morphs by rarity | Designer-authored one-shot flourishes |

**Ruling:** For a *reward mascot or a loot chest that opens differently per rarity*, **Rive is the right
tool** — but its 200 kB WASM + `wasm-unsafe-eval` requirement clash with "lightweight + strict CSP" for v1.
**Defer both.** If/when you add a mascot, prefer Rive with self-hosted, inlined WASM (`setWasmFallbackUrl`
returning an ArrayBuffer) so nothing hits a CDN, and add `wasm-unsafe-eval` to `script-src`.

## 5. Comparison table — particles / juice

| Option | Size | License | Mobile | Notes |
|---|---|---|---|---|
| **Hand-rolled canvas** (current `effects.ts`) | 0 (yours) | — | Best — one canvas, `rAF`, auto-cleanup, DPR-aware | Already grade- and tier-scaled; keep it |
| **canvas-confetti** | **~6 kB gz** | MIT | Excellent — single canvas + `rAF`, renders only live particles, self-cleans | Drop-in richer bursts (shapes, origins) if you want more without more code |
| **tsParticles** (slim/full) | ~20 / ~100 kB | MIT | Heavier; GPU-hungry with physics | Overkill for one-shot reward bursts |

**Game-feel principles to apply (Disney 12 + game "juice"):**
- **Anticipation** — a tiny pre-dip/wind-up before the XP number pops (squat-before-jump).
- **Squash & stretch** — flatten on impact, stretch on rebound → reads as weight/energy on the reward chip.
- **Hit-stop / hitlag** — freeze the frame ~3–5 frames on a big reward before the burst; the micro-pause
  makes the hit register. Scale freeze length with reward magnitude.
- **Screen shake** — small translate jitter (WAAPI `composite:"add"`) scaled by rarity; keep subtle,
  over-juicing harms feel.
- **Easing / overshoot** — spring/back easing on reveals; linear feels dead.
- **Reward echoes the magnitude** — common = quiet blip + few particles; legendary = anticipation +
  hit-stop + shake + dense gold burst + rising arpeggio. Juice is polish on top of a system that already
  works — never load-bearing.

## 6. Haptics + sound (mid-2026 status)

- **`navigator.vibrate`**: Chrome/Edge/Opera/Samsung/Android ✅. **iOS Safari / all iOS browsers: ✗** —
  WebKit has never shipped the Vibration API, and every iOS browser is WebKit, so iPhone/iPad get nothing.
  (It's in the Interop 2025 focus list; unverified anecdotes of it "starting to work" exist — treat as
  unsupported and **test on device**.) iOS 18 added *non-standard* haptics only for native `<input switch>`.
- **Best practice**: keep haptics opt-in (you already gate on `haptics_enabled`), short (50–200 ms),
  never the sole feedback, and always paired with audio + visual. Your current `GRADE_HAPTIC` / `lootHaptic`
  patterns are well-formed.
- **Audio pairing**: your Web Audio chimes (rising pitch by combo depth, per-tier arpeggios) are exactly the
  multi-sensory model recommended. Fire sound + micro-animation + (Android) vibration on the *same frame* as
  the visual reveal so the brain fuses them. Respect mute and `prefers-reduced-motion` (already done).

---

## 7. RECOMMENDED STACK for DopaMine

**Adopt a "native-first + one tiny dep" stack. Do not add GSAP, Rive, Lottie, or tsParticles for v1.**

| Layer | Choice | Why |
|---|---|---|
| Micro-motion engine | **Native WAAPI** (`element.animate`) + **Motion mini** (~2.3 kB) for ergonomic spring/stagger helpers | Zero/near-zero bytes, GPU-composited, Shadow-DOM-safe, MIT |
| Bouncy reveals | **`linear()` springs** (via Motion mini / precomputed strings) | Native, cross-browser since Safari 17.2 |
| Screen-level transitions | **View Transitions API** at the light-DOM app shell only | iOS 18+ ships it; free native page transitions |
| Card swipe/enter/exit | **Hand-rolled WAAPI transforms** inside the shadowRoot | View Transitions don't compose with Shadow-DOM naming |
| Reward particles | **Keep current canvas engine**; optionally swap to **canvas-confetti** (6 kB) for richer bursts | Cheapest possible; already tier-scaled |
| Progress/glow/gradients | **`@property` + CSS** animated custom props | Declarative, cheap, reduced-motion friendly |
| Sound | **Keep Web Audio** (yours) | CSP-safe, no assets, already combo/tier-aware |
| Haptics | **Keep opt-in `navigator.vibrate`** (Android only in practice) | iOS unsupported; never sole feedback |
| Mascot/loot rig (later) | **Rive**, self-hosted + inlined WASM, `wasm-unsafe-eval` in CSP | Only when an interactive mascot earns its 200 kB |

**Rough bundle budget added:** ~2.3 kB gz (Motion mini) baseline; ~8 kB gz if you also take canvas-confetti.
Everything else is native platform or code you already own. This stays firmly within "lightweight."

### Per-moment mapping

| Moment | Technique |
|---|---|
| **Variable-magnitude XP reveal** | WAAPI count-up on a registered `@property <number>`; magnitude drives anticipation dip → spring overshoot (`linear()`), particle count, and hit-stop length. |
| **Combo escalation** | WAAPI pulse (scale 1→1.15→1) per hit with `composite:"add"` so pulses stack; rising Web Audio pitch (already implemented) climbing with combo depth. |
| **Streak flame** | CSS `@property`-animated gradient + subtle looping flicker; scale flame size to streak length; pause under reduced-motion. |
| **Gacha loot-rarity reveal (common→legendary)** | Shared reveal timeline: anticipation → card mount via `@starting-style` → spring scale-in → canvas/confetti burst colored by tier → per-tier arpeggio. Legendary adds hit-stop + screen shake + dense gold burst. (Rive chest = later milestone.) |
| **Level-up** | Full-screen flourish: `offset-path` coins flying to HUD + radial glow via `@property` + ascending arpeggio sting (already have `levelUpChime`); optional screen shake. |
| **Card swipe / enter / exit** | Hand-rolled WAAPI transforms inside shadowRoot (translate/rotate on drag, spring settle on release). NOT View Transitions. |
| **Screen/route change** (feed↔deck↔profile) | View Transitions API at the app shell (light DOM), `prefers-reduced-motion` → instant. |
| **Ethics-gated near-miss tease** | Small WAAPI "almost" wobble only when the ethics gate allows; suppressed in `no_dark_pattern_mode`; never accompanied by celebratory sound/haptics. |

### Caveats — reduced motion, Shadow DOM, CSP

- **Reduced motion**: you already short-circuit sound and particles on `prefers-reduced-motion`. Extend the
  same gate to WAAPI reveals (swap springs for instant/opacity-only), and map View Transitions to no-op.
  Provide an in-app "reduce effects" toggle independent of the OS setting for the ethics story.
- **Shadow DOM**: query targets inside your `shadowRoot`; WAAPI/Motion animate element refs so they cross the
  boundary fine. **View Transitions do not** — they operate on the top-level document and `view-transition-name`
  inside shadow trees is unsettled, so keep card-level motion hand-rolled and use View Transitions only at the
  light-DOM shell. `@property` registered in the document is visible to shadow trees; register globally.
- **CSP (no remote CDN, inline assets)**: current stack (Web Audio, canvas, CSS, WAAPI, Motion mini) needs
  **no** `unsafe-eval` and **no** remote hosts — clean fit. If you later add **Rive**, you must (a) add
  `wasm-unsafe-eval` to `script-src`, and (b) self-host `rive.wasm` and call `RuntimeLoader.setWasmFallbackUrl`
  with the WASM as an ArrayBuffer (or `null`) to prevent the runtime's default **CDN fallback** from
  violating CSP. Bundle Motion mini through Vite (no CDN import).

---

## Sources

- Motion (motion.dev) — [animate() docs](https://motion.dev/docs/animate), [WAAPI improvements](https://motion.dev/docs/improvements-to-the-web-animations-api-dx), [npm `motion`](https://www.npmjs.com/package/motion), [Motion One → vanilla JS](https://forums.tumult.com/t/motion-dev-now-becomes-independent-and-uses-vanilla-javascript/24256)
- GSAP free / Webflow — [Webflow blog](https://webflow.com/blog/gsap-becomes-free), [CSS-Tricks](https://css-tricks.com/gsap-is-now-completely-free-even-for-commercial-use/), [Codrops free-plugin demos](https://tympanus.net/codrops/2025/05/14/from-splittext-to-morphsvg-5-creative-demos-using-free-gsap-plugins/), [Bundlephobia gsap](https://bundlephobia.com/package/gsap)
- anime.js v4 — [npm](https://www.npmjs.com/package/animejs), [Bundlephobia](https://bundlephobia.com/package/animejs), [docs install](https://animejs.com/documentation/getting-started/installation/)
- View Transitions — [Chrome 2025 update](https://developer.chrome.com/blog/view-transitions-in-2025), [caniuse](https://caniuse.com/view-transitions), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API), [misconceptions](https://developer.chrome.com/blog/view-transitions-misconceptions), [Shadow DOM naming issue #10303](https://github.com/w3c/csswg-drafts/issues/10303), [pseudo vs shadow DOM #7928](https://github.com/w3c/csswg-drafts/issues/7928)
- WAAPI / `linear()` springs — [Motion WAAPI guide](https://motion.dev/guides/waapi-improvements), [spring-easing](https://github.com/okikio/spring-easing), [Bram.us custom easing](https://www.bram.us/2024/01/12/waapi-custom-easing-function/), [CSS-Tricks additive](https://css-tricks.com/additive-animation-web-animations-api/)
- CSS `@property` / `@starting-style` / scroll-driven — [MDN scroll-driven](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Scroll-driven_animations), [caniuse animation-timeline](https://caniuse.com/mdn-css_properties_animation-timeline), [Bram.us starting-style + SDA](https://www.bram.us/2025/11/06/combining-scroll-driven-animations-with-starting-style/), [Smashing intro](https://www.smashingmagazine.com/2024/12/introduction-css-scroll-driven-animations/)
- Rive vs Lottie — [Rive blog](https://rive.app/blog/rive-as-a-lottie-alternative), [Canvas vs WebGL2](https://rive.app/docs/runtimes/web/canvas-vs-webgl), [Rive FAQ](https://rive.app/docs/runtimes/web/faq), [CSP unsafe-eval issue #131](https://github.com/rive-app/rive-wasm/issues/131), [WASM CDN fallback](https://community.rive.app/c/bug-reports/wasm-calls-cdn-as-a-fallback), [pkgpulse 2026 comparison](https://www.pkgpulse.com/guides/lottie-vs-rive-vs-css-animations-web-animation-formats-2026)
- Particles — [canvas-confetti npm](https://www.npmjs.com/package/canvas-confetti), [pkgpulse confetti vs tsParticles](https://www.pkgpulse.com/guides/canvas-confetti-vs-tsparticles-vs-party-js-celebration-2026), [tsParticles](https://particles.js.org/)
- Game juice — [Game feel on the web](https://valdemird.com/blog/game-feel-on-the-web/), [Disney 12 principles for games](https://gamejuice.co.uk/articles/disney-12-animation-principles-games), [GameAnalytics juice](https://www.gameanalytics.com/blog/squeezing-more-juice-out-of-your-game-design), [over-juicing critique](https://www.wayline.io/blog/the-juice-problem-how-exaggerated-feedback-is-harming-game-design)
- Haptics — [Vibration API interop #718](https://github.com/web-platform-tests/interop/issues/718), [LambdaTest support table](https://www.testmuai.com/learning-hub/vibration-api-browser-support/), [MDN compat iOS #29166](https://github.com/mdn/browser-compat-data/issues/29166), [Apple audio-haptic WWDC19](https://developer.apple.com/videos/play/wwdc2019/810/)
