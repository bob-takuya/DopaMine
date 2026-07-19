# Addiction / Engagement UX Research — DopaMine (Anki 魔改造)

> Evidence-informed catalog of engagement mechanics for wrapping Anki's real FSRS scheduler
> in a dopamine-driven, TikTok/gacha-flavored feed for Gen-Z ("ドパガキ向け").
>
> **How to read this doc:** Part 1 is the behavioral-science foundation (why things work).
> Part 2 is a spec table mapping each mechanic onto a *flashcard review* (grade Again/Hard/Good/Easy → reward),
> with a dark-pattern risk rating. Part 3 is the ethics/guardrails section. Part 4 is the ranked
> **TOP 12 to build first**.
>
> **Core design axiom for this project:** *Dopamine is the UI; SRS is the engine.* Every reward is a cosmetic
> overlay on a real, correctness-preserving FSRS review. We never distort the schedule to manufacture a reward.

---

## Part 1 — Behavioral-science foundations

### 1.1 Operant conditioning & the variable-ratio (VR) schedule (Skinner / Ferster)
B.F. Skinner's operant conditioning showed that *how* reinforcement is scheduled matters more than the reward
itself. In the classic setup, rats/pigeons pressed a lever that sometimes gave a small pellet, sometimes a large
one, sometimes nothing. The **variable-ratio schedule** — reward after an *unpredictable* number of responses —
produces the **highest response rate and the greatest resistance to extinction** of any schedule (Ferster &
Skinner, 1957). This is the single most important principle for this project: it is the engine behind slot
machines, social feeds, and every sticky habit.
- Sources: [Appcues — Variable rewards](https://www.appcues.com/blog/variable-rewards) · [Lumen — Reinforcement schedules](https://courses.lumenlearning.com/waymaker-psychology/chapter/reading-reinforcement-schedules/) · [Design Bootcamp — Skinner box in product design](https://medium.com/design-bootcamp/product-design-and-psychology-the-mechanism-of-skinner-box-techniques-in-video-game-design-5b7315e2d7b4)

### 1.2 Dopamine = reward-prediction error, not pleasure (Schultz)
Wolfram Schultz's single-neuron recordings (early 1990s, Fribourg) showed midbrain dopamine neurons fire in
proportion to **prediction error** — the *gap* between expected and received reward — not to the reward itself.
Fully predicted rewards produce *no* dopamine spike; **surprising** rewards produce a large one; worse-than-
expected outcomes *depress* firing. Critically, **delay-period dopamine activity tracks reward *uncertainty***:
maximal uncertainty (≈50/50) sustains the highest anticipatory dopamine. Design implication: **make reward
magnitude and timing unpredictable**, and amplify the *anticipation* window (the reveal), because dopamine peaks
*before* the outcome, not after.
- Sources: [Schultz — Dopamine reward prediction error coding (Dialogues Clin Neurosci 2016)](https://www.tandfonline.com/doi/full/10.31887/DCNS.2016.18.1/wschultz) · [Neurosity — Reward prediction error](https://neurosity.co/guides/reward-prediction-error-dopamine) · [PMC — delay-period activity = reward uncertainty](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1182345/)

### 1.3 The Hooked model (Nir Eyal): Trigger → Action → Variable Reward → Investment
A four-phase loop for building habit-forming products (Eyal, *Hooked*, 2014):
1. **Trigger** — external (notification, app icon) at first; over repetitions it becomes *internal* (an emotion,
   e.g. boredom or anxiety, cues the behavior automatically).
2. **Action** — the simplest possible behavior done in anticipation of reward (must be low-friction; see Fogg).
3. **Variable Reward** — unpredictable payoff (Eyal's three flavors: rewards of the **tribe** = social validation;
   the **hunt** = resources/information; the **self** = mastery/completion). Uncertainty drives the dopamine.
4. **Investment** — user puts in time/data/effort/social capital, which (a) loads the *next* trigger and
   (b) increases switching cost and perceived value (see IKEA/endowment effects).
Each loop deepens the habit. For us: streak, XP history, decks, and customized avatars are the *investment* that
makes users return.
- Sources: [Nir & Far — How to manufacture desire](https://www.nirandfar.com/how-to-manufacture-desire/) · [Amplitude — The Hook Model](https://amplitude.com/blog/the-hook-model) · [ProductPlan — Hook Model](https://www.productplan.com/glossary/hook-model)

### 1.4 Fogg Behavior Model: B = MAP (Motivation × Ability × Prompt)
BJ Fogg (Stanford Behavior Design Lab): a behavior fires only when **Motivation, Ability, and a Prompt** converge
in the same moment. Key insight: **Ability is usually the bottleneck, not motivation** — when the action is made
trivially easy, even weak prompts succeed. Prompt types: **facilitator** (high motivation/low ability),
**spark** (high ability/low motivation), **signal** (both already high). For us: reduce friction to a *single
swipe/tap per card*, and time prompts to the user's revealed habit window.
- Sources: [Northbeam — Fogg Behavior Model](https://www.northbeam.io/blog/fogg-behavior-model-motivation-ability-and-prompts) · [UI-Patterns — making Fogg actionable](https://ui-patterns.com/blog/making-the-fogg-behavior-model-actionable)

### 1.5 Progress & loss psychology
- **Goal-gradient effect** — effort accelerates as a goal nears (Hull; Kivetz et al. coffee-card study: purchases
  speed up closer to the free drink). → Show "3 cards to next reward" and speed up feedback near milestones.
- **Endowed-progress effect** — give artificial early progress (a card stamped "2/10" already advanced) and people
  are far more likely to finish. → Never start a progress bar at literal zero.
- **Loss aversion** (Kahneman & Tversky) — a loss hurts ~2× more than the equivalent gain feels good. This is the
  engine of **streaks**: once you *have* a streak, not-breaking-it is a loss you'll act to avoid.
- **Zeigarnik effect** — incomplete tasks occupy the mind more than completed ones (waiters remember unpaid orders).
  → "You have 4 cards left today" and a partially-filled ring create productive tension.
  - Sources: [Coglode — Goal Gradient](https://www.coglode.com/research/goal-gradient-effect) · [Learning Loop — Goal Gradient](https://learningloop.io/plays/psychology/goal-gradient-effect) · [ResearchGate — Endowed Progress Effect (Nunes & Drèze)](https://www.researchgate.net/publication/23547282_The_Endowed_Progress_Effect_How_Artificial_Advancement_Increases_Effort) · [Medium — Endowed progress in UX](https://medium.com/@davidteodorescu/design-perfect-ux-tasks-the-endowed-progress-effect-7461ca20076c)

---

## Part 2 — Mechanic spec table (mechanic → SRS-grade mapping → dark-pattern risk)

Grade legend: **Again** (fail/lapse), **Hard**, **Good**, **Easy** (the four Anki/FSRS answer buttons).
"XP" = experience points; a soft, cosmetic currency that never touches scheduling.

| # | Mechanic | Psych principle | Real-world example | Map onto a flashcard review (Again/Hard/Good/Easy → reward) | Dark-pattern risk |
|---|----------|-----------------|--------------------|------------------------------------------------------------|-------------------|
| 1 | **Variable-magnitude XP reveal** | VR schedule + reward-prediction error (Schultz) | Slot machine payout; TikTok "next video might be great" | Base XP scaled by grade (Again 1 / Hard 3 / Good 6 / Easy 10) but multiplied by an **unpredictable** 1×–5× reveal that lands *after* an anticipation animation. The card is graded honestly by FSRS first; the *bonus* is random. | **Med** (uncertainty is the point; keep magnitudes honest, no fake losses) |
| 2 | **Combo / streak multiplier (in-session)** | Goal-gradient + operant chaining; "juice" | Candy Crush cascades; fighting-game combo counter | Consecutive **Good/Easy** answers build a combo (×2, ×3, …) that boosts XP; an **Again** resets the *combo* (not the day-streak, not the schedule). Escalating sound pitch + particle intensity per combo tier. | **Low–Med** (an *Again* is a real learning signal; make the reset gentle, never punitive to the SRS record) |
| 3 | **Daily streak (day counter)** | Loss aversion + Zeigarnik + endowed progress | Duolingo/Snapchat/Wordle streaks | +1 for any day you clear your **due** cards. Big flame animation; streak shown on the HUD and app icon/widget. | **Med–High** (streaks reliably cause anxiety/guilt; mitigate with freeze + honest streak, below) |
| 4 | **Streak freeze / repair** | Loss-aversion relief; endowment; churn guard | Duolingo streak freeze (cut churn ~21% for at-risk users; +48% avg streak length) | Earn/stockpile "freezes" that auto-protect the streak on a missed day. Optionally repayable by doing 2× cards the next day (an *honest* freeze — you still do the work). | **Low** (this is the *humane* counter-mechanic; strongly recommended) |
| 5 | **Progress ring / daily goal** | Goal-gradient + Zeigarnik + completion (reward-of-self) | Apple Watch rings; Duolingo daily goal | A ring fills as due cards are answered; **never starts at 0** (endowed progress — pre-fill ~10%). Satisfying "ring closes" moment with haptic + confetti at 100%. | **Low** |
| 6 | **Loot / gacha reward chest** | VR schedule; rarity tiers; hunt reward | Genshin/gacha pulls; Candy Crush chests | Completing a session or goal yields a chest with tiered cosmetics (common→legendary drop rates shown). Cosmetics only — **never** power over scheduling. Publish odds. | **High** (gacha is regulated as gambling in BE/NL; keep it **free-only**, no paid pulls, odds disclosed) |
| 7 | **Near-miss reveal** | Near-miss effect (dopaminergic, ~win-like) | Slot reels; gacha "4★ flips to 3★" tease | On a chest/roll, occasionally animate *almost* hitting a legendary before settling. **Use sparingly and honestly** — do not fabricate near-misses to bait more pulls. | **High** (this is a manipulative gambling pattern; consider omitting, or gate behind ethics toggle) |
| 8 | **Infinite vertical swipe feed** | Removes stopping cues; frictionless action (Fogg ability) | TikTok "For You" infinite scroll/autoplay | Cards presented as a full-screen vertical feed; answer = swipe/tap; next card auto-advances. One card = one decision, minimal friction. | **Med** (autoplay/no-stop-cue is flagged by EU regulators; add a *natural stopping point* at "due cards done") |
| 9 | **"For You" card ordering skin** | Personalization; variable interest | TikTok algorithmic feed | *Cosmetic* reordering **within FSRS-allowed tolerance only** (e.g., interleave a nearly-due easy card for a quick win). **Must not** violate FSRS due-order correctness. Prefer: never resort in a way that harms scheduling. | **Med** (keep the engine authoritative; ordering tweaks are for *feel*, capped by the scheduler) |
| 10 | **Level-up / XP leveling** | Mastery (reward-of-self); endowed progress | Duolingo XP; RPG leveling | Cumulative XP → levels with a punchy level-up moment (screen flash, fanfare, new title/badge). Levels are cosmetic status, decoupled from difficulty. | **Low** |
| 11 | **Leagues / leaderboards** | Social comparison; tribe reward; competition | Duolingo leagues (XP leaderboards → +40% lessons/wk) | Weekly XP league with promotion/demotion among a cohort. Opt-in; anonymizable. | **Med–High** (social comparison harms some users; make opt-in, offer solo mode) |
| 12 | **Friend streaks / social streaks** | Tribe reward + loss aversion + FOMO | Snapchat streaks; Duolingo friend streaks | Two users keep a shared review streak; both must review daily. | **High** (Snapchat-style friend streaks drive documented adolescent anxiety/FOMO; opt-in, no guilt-trips) |
| 13 | **Daily quests / missions** | Goal-setting; Zeigarnik; variety | Fortnite/Candy Crush dailies (+25% DAU when added) | 2–3 rotating daily goals ("review 20 cards", "clear all Again cards", "3-day accuracy"). Completion → chest/XP. | **Med** (research: missed quests create negative affect; keep gentle, avoid punishment) |
| 14 | **Daily-login / return reward** | Habit routine; endowed progress | 95% of mobile games; escalating login calendars | A small reward the *first* time you open the app each day (before any review) to reduce activation energy; escalates over consecutive days. | **Med** (rewarding *opening* not *learning* is borderline; tie the reward to a real review, not a bare login) |
| 15 | **Confetti / particle reward reveal** | Sensory reward; dopamine cue conditioning | Candy Crush "pop"; app success animations | Grade-scaled particle burst on answer (Easy = big, Again = supportive/soft, not shaming). Reserve the biggest bursts for milestone moments to avoid habituation. | **Low** |
| 16 | **Haptic feedback** | Multisensory reward; conditioned cue | iOS haptics; slot/betting cashout haptics | Distinct haptic per grade + a stronger pattern for combos/level-ups/chest opens. Restraint: don't buzz every routine tap. | **Low** |
| 17 | **Sound design (rising pitch)** | Conditioned auditory reward; "juice" | Duolingo chime; Mario coin/combo pitch ramp | Answer chimes that rise in pitch with combo depth; celebratory sting on milestones. Respect mute/quiet-hours. | **Low** |
| 18 | **Streak/save notifications** | Trigger (Hooked); loss aversion; FOMO | Duolingo behavioral pushes (max 2/day, fire at habit window; "Don't let Duo down!") | Push at the user's *revealed* review time; a "save" push when the streak/goal is about to lapse. Cap ≤2/day, rotate hooks. | **Med–High** (guilt-driven pushes are effective but manipulative; cap, allow full opt-out, avoid shaming copy) |
| 19 | **Guilt / mascot nudge** | Parasocial pressure; loss aversion | Duolingo's "passive-aggressive owl" widget/meme | An avatar reacts to your progress; gets (mildly, comedically) sad if you skip. Keep it *funny*, never coercive; ethics toggle to disable. | **High** (guilt marketing; must be opt-out and never cruel) |
| 20 | **Endowed-progress onboarding** | Endowed progress + goal-gradient | Loyalty cards pre-stamped "2/10" | New users' first streak/level/ring starts partially filled so the first session already shows progress. | **Low** |
| 21 | **Unpredictable "big win" moment** | Prediction error; VR big-payoff | Slot jackpot; rare gacha 5★ | Rarely (low probability), a normal correct answer triggers an outsized celebration + XP jackpot. Honest randomness, disclosed rate. | **Med** |
| 22 | **Mastery/collection meta-progress** | Investment (Hooked); completion; sunk value | Pokédex; Duolingo achievements | Cards/decks "mastered" fill a collection/gallery; long-horizon completion goals. Ties reward to *real* SRS maturity (great alignment of dopamine with learning). | **Low** (recommended — aligns engagement with genuine retention) |

---

## Part 3 — Ethics, dark-patterns & humane guardrails

The brief is intentionally "addictive," but we **document and expose** guardrails. Over 80% of top-grossing games
use at least one manipulative design element ([policyreview.info](https://policyreview.info/articles/news/unmasking-dark-patterns-video-games/1739)),
and loot-box mechanics are **regulated as gambling in Belgium and the Netherlands**, with China mandating disclosed
odds and daily pull caps. Our differentiator: the underlying activity (spaced repetition) is *genuinely good for the
user*, so engagement pressure is far more defensible than in a pay-to-win game — **provided we don't monetize the
addictive loop and we keep the reward layer honest.**

**Highest-risk mechanics in this catalog** (gate behind an ethics toggle, opt-in, or omit):
- **Gacha/loot chests with paid pulls** → keep **free-only, no purchases, odds published**. Never sell pulls.
- **Near-miss reveals** → the most explicitly gambling-derived pattern; use sparingly/honestly or omit.
- **Friend streaks & leagues** → documented adolescent anxiety/FOMO; make **opt-in**, offer solo mode.
- **Guilt/mascot & save notifications** → effective but coercive; **cap ≤2/day, full opt-out, no shaming copy**.

**Humane counter-designs to ship alongside (the "toggleable guardrails" of the DoD):**
1. **Honest streaks** — a streak counts a *day you did your real due reviews*, not a bare app-open; freezes are
   *earned by extra work*, not bought. Streak measures learning, not mere presence.
2. **Healthy-use limits** — optional daily session cap / "you're done for today" hard stop at end of due cards
   (this restores the *stopping cue* that infinite scroll removes — the exact thing EU regulators flagged in TikTok).
3. **No dopamine/SRS corruption** — rewards never alter FSRS intervals; a real *Again* stays a real lapse. We never
   fake wins (no "losses disguised as wins" on the learning record).
4. **Transparency panel** — show real drop-rates for chests, and a "why am I seeing this card" explanation
   (schedule-driven, not engagement-driven).
5. **Opt-out for social & guilt** — leagues, friend streaks, and mascot guilt all default-off or one-tap disable.
6. **Notification hygiene** — behavior-timed, ≤2/day, rotate hooks, and a true "off" switch.
- Sources: [GameDesignKnowledge — Ethics of dark patterns](https://www.gamedesignknowledge.com/blog-post/the-ethics-of-dark-patterns-in-game-design) · [U. Colorado Law Review — loot boxes & dark patterns](https://lawreview.colorado.edu/print/when-the-cats-away-techlash-loot-boxes-and-regulating-dark-patterns-in-the-video-game-industrys-monetization-strategies/) · [policyreview.info — Unmasking dark patterns](https://policyreview.info/articles/news/unmasking-dark-patterns-video-games/1739) · [EU Commission / TikTok addictive design](https://medium.com/@aberouch/tiktoks-design-patterns-are-too-addictive-says-eu-commission-redesign-on-the-way-2d1d6631d5cb)

---

## Part 4 — TOP 12 MECHANICS TO IMPLEMENT FIRST

Ranked by **(engagement impact × ease of building on a flashcard feed)**. All are cosmetic overlays on real FSRS
reviews. "Effort" is rough MVP build effort; "Impact" is expected engagement lift; "Risk" is dark-pattern risk.

| Rank | Mechanic | Why first (impact × ease) | Effort | Impact | Risk | Build note |
|------|----------|---------------------------|--------|--------|------|------------|
| 1 | **Variable-magnitude XP reveal** (#1) | The core dopamine loop; trivial to compute per answer; highest single lever. | Low | High | Med | On answer: `xp = base[grade] × rand(1..5)` with an anticipation animation before the number lands. |
| 2 | **Grade-scaled particle + haptic + sound reveal** (#15/16/17) | Turns every tap into a reward; pure front-end; the "juice" that sells the whole feed. | Low | High | Low | Map grade→(particle size, haptic pattern, chime pitch). Rising pitch with combo. |
| 3 | **In-session combo multiplier** (#2) | Cheap counter; strong goal-gradient pull; makes streaks of *Good/Easy* feel great. | Low | High | Low–Med | `combo++` on Good/Easy, reset combo on Again; multiplier feeds XP; escalate FX per tier. |
| 4 | **Daily progress ring + daily goal (endowed start)** (#5/20) | Clear Zeigarnik/goal-gradient loop; the day's "close the ring" moment. | Low | High | Low | Ring over due-card count; pre-fill ~10%; confetti + haptic at 100%. |
| 5 | **Daily streak counter** (#3) | Best-documented retention driver (Duolingo/Snapchat); one integer + persistence. | Low | High | Med | +1 when the day's due cards are cleared; flame HUD; persist across reload. |
| 6 | **Streak freeze (honest)** (#4) | Cuts churn ~21% for at-risk users; the humane guardrail that also boosts retention. | Low | Med–High | Low | Stockpile freezes earned by extra reviews; auto-apply on a missed day. |
| 7 | **XP leveling + level-up moment** (#10) | Long-horizon status; reuses XP already computed; punchy dopamine spike at level-up. | Low | Med–High | Low | Cumulative XP→level curve; full-screen level-up sting. |
| 8 | **Infinite vertical swipe feed** (#8) | The signature TikTok skin; low friction = high Fogg-ability; the app's identity. | Med | High | Med | Full-screen cards, swipe/tap to grade, auto-advance — but **stop at "due done"** (guardrail). |
| 9 | **Loot chest (free, odds-disclosed)** (#6) | Gacha surprise = strong VR reward; cosmetics-only keeps it legal/ethical. | Med | High | High | Chest on goal/session complete; tiered cosmetic drops; **no paid pulls, publish odds**. |
| 10 | **Streak/save notifications (behavior-timed, ≤2/day)** (#18) | Highest re-engagement lever; the trigger that restarts the Hooked loop. | Med | High | Med–High | Fire at revealed habit window; "save" push when streak about to lapse; hard opt-out. |
| 11 | **Daily quests (2–3 rotating)** (#13) | +25% DAU in game studies; modular on top of XP/streak/combo already built. | Med | Med–High | Med | Rotate simple goals; completion → chest/XP; keep misses gentle. |
| 12 | **Mastery/collection meta-progress** (#22) | Aligns dopamine with *real* SRS maturity — the most ethically sound long-term hook. | Med | Med | Low | "Mastered" gallery keyed to FSRS card maturity; long-horizon completion goals. |

**Deliberately deferred / ethics-gated** (build later, behind toggles): near-miss reveals (#7), friend streaks (#12),
leagues (#11), guilt/mascot nudges (#19), daily-login-only rewards (#14). All are high-impact but high-risk; ship the
honest core (ranks 1–12) first, then layer these as opt-in.

---

### Source index (all URLs)
- Skinner / VR schedule: appcues.com/blog/variable-rewards · courses.lumenlearning.com/waymaker-psychology/chapter/reading-reinforcement-schedules · medium.com/design-bootcamp (Skinner box) · neurolaunch.com/variable-reward-psychology
- Dopamine / prediction error: tandfonline.com/doi/full/10.31887/DCNS.2016.18.1/wschultz · neurosity.co/guides/reward-prediction-error-dopamine · ncbi.nlm.nih.gov/pmc/articles/PMC1182345
- Hooked model: nirandfar.com/how-to-manufacture-desire · amplitude.com/blog/the-hook-model · productplan.com/glossary/hook-model
- Fogg B=MAP: northbeam.io/blog/fogg-behavior-model-motivation-ability-and-prompts · ui-patterns.com/blog/making-the-fogg-behavior-model-actionable
- Progress/loss psych: coglode.com/research/goal-gradient-effect · learningloop.io/plays/psychology/goal-gradient-effect · researchgate.net (Endowed Progress Effect) · medium.com/@davidteodorescu (endowed progress UX)
- TikTok feed: octalysisgroup.com/2023/01/the-behavioral-science-behind-tiktok-addiction · medium.com/@aberouch (EU addictive design) · freedom.to/blog/how-tiktok-keeps-you-hooked
- Gacha/loot boxes: geekvibesnation.com/loot-boxes-gacha · adjust.com/blog/gacha-mechanics-for-mobile-games-explained · mdpi.com/2078-2489/16/10/890
- Near-miss / LDW: pubmed.ncbi.nlm.nih.gov/28421402 · link.springer.com/article/10.1007/s10899-017-9688-0 · en.wikipedia.org/wiki/Near-miss_effect
- Duolingo: trophy.so/blog/duolingo-gamification-case-study · digia.tech/post/duolingo-habit-forming-reminders-retention-architecture · deconstructoroffun.com (Duolingo DAU) · duolingo.deconstructoroffun.com/mechanics/notifications · webdesignerdepot.com (Duolingo notifications)
- Snapchat/BeReal/Wordle streaks: dutable.com/snapchat-streaks-the-psychology-behind-the-obsession · sciencedirect.com/science/article/pii/S2772503023000476 · socialmediavictims.org/social-media-addiction/mental-health/fomo
- Candy Crush / daily rewards / juice: stepico.com/blog/candy-crush-business-model · keewano.com/blog/reward-systems-mobile-games · ncbi.nlm.nih.gov/pmc/articles/PMC5445157 (Candy Crush near-miss) · medium.com/@mezoistvan (juicy UI)
- Micro-interactions/haptics: veroke.com/insights/micro-interactions-in-ui-ux · supercharged.studio/blog/psychology-of-microinteractions-in-ux-design
- Daily quests research: dl.acm.org/doi/abs/10.1145/3549489 (Daily Quests or Daily Pests?) · researchgate.net/publication/365003534
- Ethics/dark patterns/regulation: gamedesignknowledge.com/blog-post/the-ethics-of-dark-patterns-in-game-design · lawreview.colorado.edu/print/when-the-cats-away · policyreview.info/articles/news/unmasking-dark-patterns-video-games/1739
