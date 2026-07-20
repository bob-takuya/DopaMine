// Heads-up display: streak flame, XP/level progress bar, combo counter, daily
// progress ring (with ~10% endowed prefill), and the session-cap remaining
// indicator. Everything renders from authoritative store state — the HUD never
// computes rewards, only projects server truth (ARCHITECTURE §6, §9).

import { animate, bloom, countUp, reduceMotion, SPRING } from "../motion.ts";
import type { AppSnapshot } from "../store.ts";

/** Level progress within the current level band: 100*(level-1)^2 .. 100*level^2-1. */
function levelProgress(totalXp: number, level: number): { pct: number; into: number; span: number } {
  const floor = 100 * (level - 1) ** 2;
  const ceil = 100 * level ** 2;
  const span = ceil - floor;
  const into = Math.max(0, totalXp - floor);
  return { pct: span > 0 ? Math.min(1, into / span) : 0, into, span };
}

const ENDOWED_PREFILL = 0.1; // never start the daily ring at literal zero

export class Hud {
  readonly el: HTMLElement;
  private ring!: SVGCircleElement;
  private ringLabel!: HTMLElement;
  private flameEl!: HTMLElement;
  private streakWrap!: HTMLElement;
  private streakNum!: HTMLElement;
  private comboEl!: HTMLElement;
  private xpFill!: HTMLElement;
  private levelEl!: HTMLElement;
  private xpLabel!: HTMLElement;
  private capEl!: HTMLElement;
  private capTimer = 0;
  private lastCombo = 0;
  // Transition bookkeeping: animate BETWEEN authoritative values, never invent
  // them. `primed` gates the first render so nothing animates on initial load.
  private primed = false;
  private lastStreak = 0;
  private lastLevel = 0;
  private lastXpInto = 0;
  private lastSpan = 100;
  private lastPct = 0;
  private lastOffset = 0;
  private cancelXp: (() => void) | null = null;

  constructor(private onOpenSettings: () => void) {
    this.el = document.createElement("header");
    this.el.className = "hud";
    this.build();
  }

  private build(): void {
    // Streak flame
    const streak = document.createElement("div");
    streak.className = "hud__streak";
    this.streakWrap = streak;
    this.flameEl = document.createElement("span");
    // A single soft mark that slow-breathes (CSS, stripped under reduced motion).
    this.flameEl.className = "flame flame--breathe";
    this.flameEl.textContent = "🔥";
    this.streakNum = document.createElement("span");
    this.streakNum.className = "hud__streak-num";
    this.streakNum.textContent = "0";
    streak.append(this.flameEl, this.streakNum);

    // Combo
    this.comboEl = document.createElement("div");
    this.comboEl.className = "hud__combo";
    this.comboEl.textContent = "";

    // XP / level bar
    const xpWrap = document.createElement("div");
    xpWrap.className = "hud__xp";
    this.levelEl = document.createElement("span");
    this.levelEl.className = "hud__level";
    this.levelEl.textContent = "Lv 1";
    const bar = document.createElement("div");
    bar.className = "xp-bar";
    this.xpFill = document.createElement("div");
    this.xpFill.className = "xp-bar__fill";
    // Fill via transform (scaleX), never width — no layout animation (spec §5).
    this.xpFill.style.width = "100%";
    this.xpFill.style.transformOrigin = "left center";
    this.xpFill.style.transform = "scaleX(0)";
    this.xpFill.style.transition = "none";
    bar.appendChild(this.xpFill);
    this.xpLabel = document.createElement("span");
    this.xpLabel.className = "hud__xp-label";
    this.xpLabel.textContent = "0 / 100 XP";
    xpWrap.append(this.levelEl, bar, this.xpLabel);

    // Daily ring
    const ringWrap = document.createElement("div");
    ringWrap.className = "hud__ring";
    const R = 18;
    const C = 2 * Math.PI * R;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 44 44");
    svg.setAttribute("class", "ring-svg");
    const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    track.setAttribute("cx", "22");
    track.setAttribute("cy", "22");
    track.setAttribute("r", String(R));
    track.setAttribute("class", "ring-track");
    this.ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    this.ring.setAttribute("cx", "22");
    this.ring.setAttribute("cy", "22");
    this.ring.setAttribute("r", String(R));
    this.ring.setAttribute("class", "ring-progress");
    this.ring.style.strokeDasharray = String(C);
    // Drive the ring with a JS SPRING; disable the CSS transition so they don't fight.
    this.ring.style.transition = "none";
    this.lastOffset = C * (1 - ENDOWED_PREFILL);
    this.ring.style.strokeDashoffset = String(this.lastOffset);
    svg.append(track, this.ring);
    this.ringLabel = document.createElement("span");
    this.ringLabel.className = "ring-label";
    this.ringLabel.textContent = "0";
    ringWrap.append(svg, this.ringLabel);

    // Session cap remaining
    this.capEl = document.createElement("div");
    this.capEl.className = "hud__cap";
    this.capEl.textContent = "";

    // Settings button
    const gear = document.createElement("button");
    gear.className = "hud__gear";
    gear.type = "button";
    gear.setAttribute("aria-label", "Settings & guardrails");
    gear.textContent = "⚙";
    gear.addEventListener("click", () => this.onOpenSettings());

    const left = document.createElement("div");
    left.className = "hud__left";
    left.append(streak, this.comboEl);

    const center = document.createElement("div");
    center.className = "hud__center";
    center.append(xpWrap);

    const right = document.createElement("div");
    right.className = "hud__right";
    right.append(this.capEl, ringWrap, gear);

    this.el.append(left, center, right);
    this.startCapTicker();
  }

  update(snap: AppSnapshot): void {
    const st = snap.state;
    if (!st) return;

    // ---- Streak: soft mark breathes (CSS); one pulse + bloom on increment. ----
    this.streakNum.textContent = String(st.streak_days);
    this.flameEl.classList.toggle("flame--cold", st.streak_days === 0);
    const freezeProtected =
      !snap.config.honest_streak_mode && (st.inventory["streak_freeze"] ?? 0) > 0;
    this.streakWrap.classList.toggle("hud__streak--frozen", freezeProtected);
    if (this.primed && st.streak_days > this.lastStreak) this.streakPulse();
    this.lastStreak = st.streak_days;

    // ---- Combo: refined chip; spring pulse up, calm deflate on reset. ----
    if (st.combo >= 2) {
      this.comboEl.textContent = `x${st.combo} COMBO`;
      this.comboEl.classList.add("hud__combo--on");
      // At high combo the accent-line warms slightly toward gold (spec §3).
      this.comboEl.classList.toggle("hud__combo--warm", st.combo >= 10);
      if (this.primed && st.combo > this.lastCombo) this.comboPulse();
    } else {
      this.comboEl.classList.remove("hud__combo--warm");
      if (this.primed && this.lastCombo >= 2) {
        this.comboDeflate();
      } else {
        this.comboEl.textContent = "";
        this.comboEl.classList.remove("hud__combo--on");
      }
    }
    this.lastCombo = st.combo;

    // ---- XP / level ----
    const { pct, into, span } = levelProgress(st.total_xp, st.level);
    this.levelEl.textContent = `Lv ${st.level}`;
    const levelUp = this.primed && st.level > this.lastLevel;

    // XP value counts up (tabular-nums via inherited font-variant). On a level
    // change the band (span) shifts, so snap to the new value instead of counting.
    this.cancelXp?.();
    this.cancelXp = null;
    if (!this.primed || span !== this.lastSpan) {
      this.xpLabel.textContent = `${into} / ${span} XP`;
    } else {
      this.cancelXp = countUp(this.xpLabel, this.lastXpInto, into, {
        format: (v) => `${Math.round(v)} / ${span} XP`,
      });
    }

    // XP progress bar fills with SPRING (scaleX). On level-up it completes to
    // full first, then settles into the new band — one quiet beat.
    this.setBar(pct, levelUp);
    if (levelUp) this.levelUpFlourish();

    // ---- Daily ring — over due-card count, endowed ~10% prefill, SPRING fill. ----
    const reviewed = st.reviews_today;
    const due = snap.srs?.due_now ?? 0;
    const goal = Math.max(1, reviewed + due);
    const raw = reviewed / goal;
    const shown = ENDOWED_PREFILL + (1 - ENDOWED_PREFILL) * Math.min(1, raw);
    const R = 18;
    const C = 2 * Math.PI * R;
    const offset = C * (1 - shown);
    this.ring.style.strokeDashoffset = String(offset); // commit final value
    if (this.primed && !reduceMotion()) {
      animate(this.ring, { strokeDashoffset: [this.lastOffset, offset] }, { type: "spring", ...SPRING });
    }
    this.lastOffset = offset;
    this.ring.classList.toggle("ring-progress--done", raw >= 1);
    this.ringLabel.textContent = String(reviewed);

    this.lastXpInto = into;
    this.lastSpan = span;
    this.lastLevel = st.level;
    this.lastPct = pct;
    this.primed = true;
  }

  // ---- Motion helpers (all cancel-safe & reduced-motion aware) -------------

  /** Fill the XP bar via scaleX transform. Level-up completes then settles. */
  private setBar(pct: number, levelUp: boolean): void {
    this.xpFill.style.transform = `scaleX(${pct})`; // commit final value
    if (!this.primed || reduceMotion()) return;
    if (levelUp) {
      animate(
        this.xpFill,
        { transform: [`scaleX(${this.lastPct})`, "scaleX(1)", `scaleX(${pct})`] },
        { duration: 0.7, times: [0, 0.5, 1], ease: [0.22, 1, 0.36, 1] },
      );
    } else {
      animate(
        this.xpFill,
        { transform: [`scaleX(${this.lastPct})`, `scaleX(${pct})`] },
        { type: "spring", ...SPRING },
      );
    }
  }

  /** Level-up: number flips up (rotateX/translateY spring) + ONE bloom. */
  private levelUpFlourish(): void {
    if (reduceMotion()) return;
    animate(
      this.levelEl,
      {
        transform: [
          "perspective(400px) rotateX(-90deg) translateY(6px)",
          "perspective(400px) rotateX(0deg) translateY(0px)",
        ],
        opacity: [0.3, 1],
      },
      { type: "spring", ...SPRING },
    );
    const r = this.levelEl.getBoundingClientRect();
    bloom(r.left + r.width / 2, r.top + r.height / 2, { size: 140, intensity: 0.5 });
  }

  private comboPulse(): void {
    if (reduceMotion()) return;
    animate(
      this.comboEl,
      { transform: ["scale(1)", "scale(1.06)", "scale(1)"] },
      { type: "spring", ...SPRING },
    );
  }

  /** Again reset: chip deflates calmly (scale + opacity dip), then clears. */
  private comboDeflate(): void {
    const el = this.comboEl;
    const clear = (): void => {
      el.textContent = "";
      el.classList.remove("hud__combo--on");
    };
    if (reduceMotion()) {
      clear();
      return;
    }
    const controls = animate(
      el,
      { transform: ["scale(1)", "scale(0.94)", "scale(1)"], opacity: [1, 0.6, 1] },
      { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
    );
    void controls.then(clear).catch(clear);
  }

  private streakPulse(): void {
    if (reduceMotion()) return;
    animate(
      this.streakWrap,
      { transform: ["scale(1)", "scale(1.08)", "scale(1)"] },
      { type: "spring", ...SPRING },
    );
    const r = this.streakWrap.getBoundingClientRect();
    bloom(r.left + r.width / 2, r.top + r.height / 2, { size: 90, intensity: 0.4 });
  }

  // ---- Session cap indicator ----------------------------------------------

  private startCapTicker(): void {
    if (this.capTimer) return;
    this.capTimer = window.setInterval(() => this.tickCap(), 1000);
  }

  private snap: AppSnapshot | null = null;
  setSnapshot(snap: AppSnapshot): void {
    this.snap = snap;
    this.update(snap);
    this.tickCap();
  }

  private tickCap(): void {
    const snap = this.snap;
    if (!snap || !snap.state) return;
    const capMin = snap.config.session_length_cap_minutes;
    if (capMin == null) {
      this.capEl.textContent = "∞";
      this.capEl.classList.remove("hud__cap--warn", "hud__cap--over");
      return;
    }
    const started = snap.state.session_started_at
      ? Date.parse(snap.state.session_started_at)
      : Date.now();
    const elapsedMs = Date.now() - started;
    const remainMs = capMin * 60_000 - elapsedMs;
    const remainMin = Math.max(0, Math.ceil(remainMs / 60_000));
    const mm = Math.floor(Math.max(0, remainMs) / 60_000);
    const ss = Math.floor((Math.max(0, remainMs) % 60_000) / 1000);
    this.capEl.textContent = `⏱ ${mm}:${String(ss).padStart(2, "0")}`;
    this.capEl.classList.toggle("hud__cap--warn", remainMin <= 3 && remainMs > 0);
    this.capEl.classList.toggle("hud__cap--over", remainMs <= 0);
  }
}
