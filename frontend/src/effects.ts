// Sensory "juice": Web Audio chimes, opt-in haptics, and particle bursts.
// (ARCHITECTURE §6, research/addiction-ux.md ranks #2/#15/#16/#17.)
//
// Guardrails honored here:
//  - AudioContext is created lazily on first sound (browsers require a gesture).
//  - Sound respects the mute/sound_enabled toggle AND prefers-reduced-motion.
//  - Haptics call navigator.vibrate ONLY after explicit opt-in (haptics_enabled).
//  - No-drop celebratory sound/haptics are suppressed by callers in
//    no_dark_pattern_mode.

import type { LootTier, Rating } from "./types.ts";

interface EffectsFlags {
  soundEnabled: boolean;
  hapticsEnabled: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const TIER_COLOR: Record<LootTier, string> = {
  common: "#7cf6c4",
  rare: "#5db4ff",
  epic: "#c07bff",
  legendary: "#ffd23f",
};

const GRADE_PARTICLES: Record<Rating, number> = { 1: 6, 2: 14, 3: 26, 4: 40 };
const GRADE_HAPTIC: Record<Rating, number | number[]> = {
  1: 12,
  2: 20,
  3: [15, 30, 15],
  4: [20, 40, 25, 40],
};

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

export class Effects {
  private flags: EffectsFlags = { soundEnabled: true, hapticsEnabled: false };
  private ctx: AudioContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private c2d: CanvasRenderingContext2D | null = null;
  private particles: Particle[] = [];
  private raf = 0;

  setFlags(flags: Partial<EffectsFlags>): void {
    this.flags = { ...this.flags, ...flags };
  }

  private ensureAudio(): AudioContext | null {
    if (!this.flags.soundEnabled) return null;
    if (prefersReducedMotion()) return null;
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  private ensureCanvas(): void {
    if (this.canvas) return;
    const canvas = document.createElement("canvas");
    canvas.className = "fx-canvas";
    canvas.setAttribute("aria-hidden", "true");
    const resize = (): void => {
      canvas.width = window.innerWidth * devicePixelRatio;
      canvas.height = window.innerHeight * devicePixelRatio;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    document.body.appendChild(canvas);
    this.canvas = canvas;
    this.c2d = canvas.getContext("2d");
  }

  /** A single tone. freq in Hz, dur in seconds. */
  private tone(freq: number, dur: number, when = 0, type: OscillatorType = "triangle", gain = 0.18): void {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /**
   * Rising-pitch answer tick — pitch climbs with the in-session combo depth so
   * chains of Good/Easy feel escalating (research #17).
   */
  answerTick(rating: Rating, combo: number): void {
    // Base pitch by grade; ramps up with combo, saturating so it never shrieks.
    const gradeBase: Record<Rating, number> = { 1: 220, 2: 300, 3: 380, 4: 460 };
    const base = gradeBase[rating];
    const climb = Math.min(12, combo) * 28;
    this.tone(base + climb, 0.12, 0, rating === 1 ? "sine" : "triangle", rating === 1 ? 0.12 : 0.2);
  }

  levelUpChime(): void {
    // Ascending arpeggio sting.
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, 0.18, i * 0.08, "triangle", 0.22));
  }

  lootChime(tier: LootTier): void {
    const seqByTier: Record<LootTier, number[]> = {
      common: [523.25, 659.25],
      rare: [523.25, 659.25, 783.99],
      epic: [659.25, 783.99, 987.77, 1174.66],
      legendary: [523.25, 783.99, 1046.5, 1318.51, 1567.98],
    };
    seqByTier[tier].forEach((f, i) => this.tone(f, 0.22, i * 0.09, "sawtooth", 0.2));
  }

  /** A soft, non-celebratory blip for no-drop (never used to fake a win). */
  softBlip(): void {
    this.tone(180, 0.09, 0, "sine", 0.08);
  }

  // ---- Haptics (opt-in only) ------------------------------------------------

  private vibrate(pattern: number | number[]): void {
    if (!this.flags.hapticsEnabled) return;
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
    navigator.vibrate(pattern);
  }

  gradeHaptic(rating: Rating): void {
    this.vibrate(GRADE_HAPTIC[rating]);
  }

  lootHaptic(tier: LootTier): void {
    const byTier: Record<LootTier, number[]> = {
      common: [15],
      rare: [20, 30, 20],
      epic: [25, 40, 25, 40],
      legendary: [30, 50, 30, 50, 60],
    };
    this.vibrate(byTier[tier]);
  }

  // ---- Particles ------------------------------------------------------------

  /**
   * Particle burst scaled by grade and (optionally) loot rarity. Suppressed
   * entirely under prefers-reduced-motion.
   */
  burst(opts: {
    rating?: Rating;
    tier?: LootTier;
    x?: number;
    y?: number;
  }): void {
    if (prefersReducedMotion()) return;
    this.ensureCanvas();
    if (!this.c2d) return;
    const cx = (opts.x ?? window.innerWidth / 2) * devicePixelRatio;
    const cy = (opts.y ?? window.innerHeight * 0.5) * devicePixelRatio;

    let count = opts.rating ? GRADE_PARTICLES[opts.rating] : 20;
    let colors = ["#ff4fd8", "#4ff0ff", "#c07bff", "#fff27a"];
    if (opts.tier) {
      const tierCount: Record<LootTier, number> = {
        common: 30,
        rare: 55,
        epic: 90,
        legendary: 150,
      };
      count = Math.max(count, tierCount[opts.tier]);
      colors = [TIER_COLOR[opts.tier], "#ffffff", TIER_COLOR[opts.tier]];
    }

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (2 + Math.random() * 6) * devicePixelRatio;
      const maxLife = 40 + Math.random() * 40;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 3 * devicePixelRatio,
        life: maxLife,
        maxLife,
        size: (2 + Math.random() * 4) * devicePixelRatio,
        color: colors[Math.floor(Math.random() * colors.length)] ?? "#fff",
      });
    }
    this.startLoop();
  }

  private startLoop(): void {
    if (this.raf) return;
    const step = (): void => {
      const ctx = this.c2d;
      const canvas = this.canvas;
      if (!ctx || !canvas) {
        this.raf = 0;
        return;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const gravity = 0.15 * devicePixelRatio;
      this.particles = this.particles.filter((p) => p.life > 0);
      for (const p of this.particles) {
        p.vy += gravity;
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 1;
        ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (this.particles.length > 0) {
        this.raf = requestAnimationFrame(step);
      } else {
        this.raf = 0;
      }
    };
    this.raf = requestAnimationFrame(step);
  }
}

export const effects = new Effects();
