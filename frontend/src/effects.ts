// Restrained sensory effects: soft audio, opt-in Android haptics, sparse embers.
import type { LootTier, Rating } from "./types.ts";

export interface EffectsFlags { soundEnabled: boolean; hapticsEnabled: boolean }
export interface BurstOptions { rating?: Rating; tier?: LootTier; x?: number; y?: number }

const reduced = (): boolean => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const TIER_COLOR: Record<LootTier, string> = {
  common: "#AEB6C2", rare: "#6FE0C6", epic: "#B79CFF", legendary: "#E4C07A",
};
const GRADE_COUNT: Record<Rating, number> = { 1: 4, 2: 8, 3: 14, 4: 20 };

interface Ember { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; size: number; color: string }

export class Effects {
  private flags: EffectsFlags = { soundEnabled: true, hapticsEnabled: false };
  private ctx: AudioContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private c2d: CanvasRenderingContext2D | null = null;
  private particles: Ember[] = [];
  private raf = 0;

  setFlags(flags: Partial<EffectsFlags>): void { this.flags = { ...this.flags, ...flags }; }

  private ensureAudio(): AudioContext | null {
    if (!this.flags.soundEnabled || typeof window === "undefined") return null;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    this.ctx ??= new AC();
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  private tone(freq: number, duration: number, when = 0, gain = .055): void {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const start = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const volume = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(freq * .985, start + duration);
    volume.gain.setValueAtTime(.0001, start);
    volume.gain.exponentialRampToValueAtTime(gain, start + .018);
    volume.gain.exponentialRampToValueAtTime(.0001, start + duration);
    osc.connect(volume).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + .02);
  }

  answerTick(rating: Rating, _combo: number): void {
    const pitch: Record<Rating, number> = { 1: 170, 2: 190, 3: 215, 4: 240 };
    this.tone(pitch[rating], .075, 0, .035);
  }

  comboRise(combo: number): void {
    const base = 185 + Math.min(combo, 12) * 2;
    this.tone(base, .12, 0, .035);
    this.tone(base * 1.2, .14, .055, .025);
  }

  legendaryChime(): void { this.warmChime(); }
  levelUpChime(): void { this.warmChime(); }
  private warmChime(): void {
    this.tone(146.83, .42, 0, .065);
    this.tone(220, .46, .07, .045);
    this.tone(293.66, .5, .14, .03);
  }

  lootChime(tier: LootTier): void {
    if (tier === "legendary") this.legendaryChime();
    else if (tier !== "common") this.tone(tier === "epic" ? 220 : 196, .18, 0, .035);
  }

  softBlip(): void { this.tone(165, .07, 0, .02); }

  private isAndroid(): boolean {
    return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
  }

  private vibrate(pattern: number | number[]): void {
    if (!this.flags.hapticsEnabled || !this.isAndroid() || typeof navigator.vibrate !== "function") return;
    navigator.vibrate(pattern);
  }

  gradeHaptic(rating: Rating): void { this.vibrate(rating >= 3 ? 14 : 9); }
  lootHaptic(tier: LootTier): void {
    const pattern: Record<LootTier, number | number[]> = {
      common: 10, rare: 14, epic: [15, 28, 15], legendary: [18, 34, 22],
    };
    this.vibrate(pattern[tier]);
  }

  private ensureCanvas(): void {
    if (this.canvas) return;
    const canvas = document.createElement("canvas");
    canvas.className = "fx-canvas";
    canvas.setAttribute("aria-hidden", "true");
    const resize = (): void => {
      const dpr = devicePixelRatio;
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
      canvas.style.width = `${innerWidth}px`;
      canvas.style.height = `${innerHeight}px`;
    };
    resize();
    addEventListener("resize", resize);
    (document.getElementById("fx-layer") ?? document.body).append(canvas);
    this.canvas = canvas;
    this.c2d = canvas.getContext("2d");
  }

  burst(opts: BurstOptions): void {
    if (reduced()) return;
    this.ensureCanvas();
    if (!this.c2d) return;
    const dpr = devicePixelRatio;
    const x = (opts.x ?? innerWidth / 2) * dpr;
    const y = (opts.y ?? innerHeight * .5) * dpr;
    const tierCount: Record<LootTier, number> = { common: 6, rare: 14, epic: 24, legendary: 60 };
    const desired = opts.tier ? tierCount[opts.tier] : opts.rating ? GRADE_COUNT[opts.rating] : 8;
    const cap = opts.tier === "legendary" ? 60 : 24;
    const count = Math.max(0, Math.min(desired, cap - this.particles.length));
    const color = opts.tier ? TIER_COLOR[opts.tier] : "#6FE0C6";
    for (let i = 0; i < count; i++) {
      const maxLife = 22 + Math.random() * 22;
      this.particles.push({
        x: x + (Math.random() - .5) * 80 * dpr,
        y: y + (Math.random() - .5) * 30 * dpr,
        vx: (Math.random() - .5) * .55 * dpr,
        vy: (-.45 - Math.random() * 1.1) * dpr,
        life: maxLife, maxLife,
        size: (.8 + Math.random() * 1.8) * dpr,
        color,
      });
    }
    this.startLoop();
  }

  private startLoop(): void {
    if (this.raf) return;
    const step = (): void => {
      const ctx = this.c2d;
      if (!ctx || !this.canvas) { this.raf = 0; return; }
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = "lighter";
      this.particles = this.particles.filter((p) => p.life > 0);
      for (const p of this.particles) {
        p.x += p.vx; p.y += p.vy; p.vx *= .98; p.life--;
        const progress = p.life / p.maxLife;
        ctx.globalAlpha = Math.sin(progress * Math.PI) * .42;
        ctx.shadowBlur = p.size * 4;
        ctx.shadowColor = p.color;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = "source-over";
      if (this.particles.length) this.raf = requestAnimationFrame(step);
      else this.raf = 0;
    };
    this.raf = requestAnimationFrame(step);
  }
}

export const effects = new Effects();
