// Server-authored reward choreography. Events are consumed in their emitted
// order and their payloads are displayed verbatim; presentation never rerolls.

import {
  BASE_LOOT_ODDS,
  type GuardrailConfig,
  type LootTier,
  type RewardEvent,
} from "../types.ts";
import { effects } from "../effects.ts";
import {
  animate,
  bloom,
  countUp,
  EASE_OUT,
  enter,
  exit,
  reduceMotion,
  SPRING,
  SPRING_SOFT,
} from "../motion.ts";

const TIER_LABEL: Record<LootTier, string> = {
  common: "COMMON",
  rare: "RARE",
  epic: "EPIC",
  legendary: "LEGENDARY",
};

const TIER_COLOR: Record<LootTier, string> = {
  common: "var(--rar-common)",
  rare: "var(--rar-rare)",
  epic: "var(--rar-epic)",
  legendary: "var(--rar-legendary)",
};

const ITEM_EMOJI: Record<string, string> = {
  spark: "✨", slime: "🟢", neon_cat: "🐱", streak_freeze: "🧊",
  golden_brain: "🧠", glitch_aura: "🌀", dopamine_crown: "👑",
};

export interface OverlayContext {
  config: GuardrailConfig;
  levelBefore: number;
  levelAfter: number;
}

export class RewardOverlay {
  readonly el: HTMLElement;
  private skipResolve: (() => void) | null = null;
  private config: GuardrailConfig | null = null;
  private lastCombo: number | null = null;
  private run = 0;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "reward-overlay";
    this.el.setAttribute("aria-live", "polite");
    this.el.addEventListener("pointerdown", () => this.skip());
  }

  private skip(): void {
    this.skipResolve?.();
    this.skipResolve = null;
  }

  async play(events: RewardEvent[], ctx: OverlayContext): Promise<void> {
    const run = ++this.run;
    this.skip();
    this.config = ctx.config;

    // Do not reorder: this loop is the server's reward timeline.
    for (const ev of events) {
      if (run !== this.run) return;
      switch (ev.type) {
        case "xp_awarded":
          this.flourishXp(ev.payload.amount, ev.payload.multiplier, run);
          break;
        case "combo_changed":
          this.flourishCombo(ev.payload.combo, run);
          break;
        case "streak_changed":
          this.flourishStreak(ev.payload.streak_days, ev.payload.freeze_protected === true, run);
          break;
        case "loot_dropped":
          await this.revealLoot(ev.payload.tier, ev.payload.item, ev.payload.pity_forced, ctx, run);
          break;
        case "near_miss":
          await this.revealNearMiss(ev.payload.teased_tier, ev.payload.truth, ctx, run);
          break;
        case "no_drop":
          this.revealNoDrop(ctx, "odds" in ev.payload ? ev.payload.odds : undefined, run);
          break;
      }
    }
    if (run === this.run && ctx.levelAfter > ctx.levelBefore) this.levelUp(ctx.levelAfter, run);
  }

  private removeLater(node: HTMLElement, ms: number, run: number): void {
    window.setTimeout(() => {
      if (run === this.run && node.isConnected) void exit(node).then(() => node.remove());
      else node.remove();
    }, ms);
  }

  private center(node: Element): { x: number; y: number } {
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  private flourishXp(amount: number, multiplier: number, run: number): void {
    const node = document.createElement("div");
    node.className = "reward-float reward-float--xp";
    const number = document.createElement("span");
    const suffix = document.createElement("span");
    suffix.textContent = ` XP${multiplier > 1 ? ` ×${multiplier.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}` : ""}`;
    node.append(number, suffix);
    this.el.append(node);
    void enter(node);
    countUp(number, 0, amount, { duration: 480, format: (value) => `+${Math.round(value)}` });
    requestAnimationFrame(() => {
      if (!node.isConnected) return;
      const p = this.center(node);
      const magnitude = Math.max(-1, Math.min(1, (amount - 20) / 80));
      bloom(p.x, p.y, { size: 180 * (1 + magnitude * 0.2), intensity: 0.42 });
    });
    this.removeLater(node, 620, run);
  }

  private flourishCombo(combo: number, run: number): void {
    const previous = this.lastCombo;
    this.lastCombo = combo;
    const node = document.createElement("div");
    node.className = "reward-float reward-float--combo";
    node.textContent = `×${combo} COMBO`;
    node.style.padding = "7px 12px";
    node.style.borderRadius = "var(--r-pill)";
    node.style.background = "var(--accent-dim)";
    node.style.border = combo >= 10
      ? "1px solid color-mix(in srgb, var(--accent-line) 90%, var(--rar-legendary) 10%)"
      : "1px solid var(--accent-line)";
    this.el.append(node);

    const reset = previous !== null && combo < previous;
    if (reduceMotion()) {
      void enter(node);
    } else if (reset) {
      void animate(node, { transform: ["scale(1)", "scale(.94)", "scale(1)"], opacity: [1, .66, 1] },
        { duration: .34, ease: EASE_OUT as never });
    } else {
      void animate(node,
        { transform: ["scale(1)", "scale(1.06)", "scale(1)"], filter: ["brightness(1)", "brightness(1.16)", "brightness(1)"] },
        { type: "spring", ...SPRING });
      if (this.config?.sound_enabled) effects.comboRise(combo);
    }
    this.removeLater(node, 620, run);
  }

  private flourishStreak(days: number, freezeProtected: boolean, run: number): void {
    const node = document.createElement("div");
    node.className = "reward-float reward-float--streak";
    node.textContent = freezeProtected ? `Streak ${days} · freeze protected` : `${days}-day streak`;
    this.el.append(node);
    if (reduceMotion()) void enter(node);
    else void animate(node, { transform: ["scale(1)", "scale(1.05)", "scale(1)"], opacity: [.78, 1, 1] },
      { type: "spring", ...SPRING });
    requestAnimationFrame(() => {
      const p = this.center(node);
      bloom(p.x, p.y, { size: 130, intensity: .22 });
    });
    this.removeLater(node, 720, run);
  }

  private levelUp(level: number, run: number): void {
    if (this.el.querySelector(".levelup")) return;
    const node = document.createElement("div");
    node.className = "levelup";
    const text = document.createElement("span");
    text.className = "levelup__text";
    text.textContent = `LEVEL ${level}`;
    node.append(text);
    this.el.append(node);
    void enter(text, { soft: true });
    const p = this.center(text);
    bloom(p.x, p.y, { size: 260, intensity: .4 });
    if (this.config?.sound_enabled) effects.levelUpChime();
    effects.burst({ tier: "epic" });
    this.removeLater(node, 1050, run);
  }

  private makeLootPanel(tier: LootTier): { panel: HTMLDivElement; token: HTMLDivElement; tierEl: HTMLDivElement; itemEl: HTMLDivElement } {
    const panel = document.createElement("div");
    panel.className = `loot loot--${tier}`;
    panel.style.color = TIER_COLOR[tier];
    const token = document.createElement("div");
    token.className = "loot__chest";
    token.textContent = "◆";
    const tierEl = document.createElement("div");
    tierEl.className = "loot__tier";
    const itemEl = document.createElement("div");
    itemEl.className = "loot__item";
    panel.append(token, tierEl, itemEl);
    return { panel, token, tierEl, itemEl };
  }

  private async revealLoot(tier: LootTier, item: string, pityForced: boolean, ctx: OverlayContext, run: number): Promise<void> {
    const { panel, token, tierEl, itemEl } = this.makeLootPanel(tier);
    tierEl.textContent = TIER_LABEL[tier];
    itemEl.textContent = `${ITEM_EMOJI[item] ?? "◆"} ${item}`;
    if (pityForced) {
      const pity = document.createElement("div");
      pity.className = "loot__pity";
      pity.textContent = "pity guaranteed";
      panel.append(pity);
    }
    if (ctx.config.no_dark_pattern_mode) panel.append(this.oddsTable());
    this.el.append(panel);
    void enter(panel, { soft: true });

    if (tier === "legendary" && !reduceMotion()) this.spotlight(panel, true);
    if (!reduceMotion()) {
      void animate(token, { transform: ["translateY(8px) scale(.94)", "translateY(0) scale(1)"], opacity: [0, 1] },
        { type: "spring", ...SPRING_SOFT });
      if (tier !== "common") this.shimmer(panel);
    }

    const p = this.center(panel);
    if (tier === "legendary") {
      bloom(p.x, p.y, { color: "var(--rar-legendary)", size: 360, intensity: .3 });
      if (ctx.config.sound_enabled) effects.legendaryChime();
    }
    if (ctx.config.haptics_enabled) effects.lootHaptic(tier);
    effects.burst({ tier, x: p.x, y: p.y });

    await this.skippableDelay(reduceMotion() ? 120 : tier === "legendary" ? 1050 : tier === "common" ? 420 : 760);
    if (run !== this.run) return panel.remove();
    if (tier === "legendary") this.spotlight(panel, false);
    await exit(panel);
    panel.remove();
  }

  private shimmer(panel: HTMLElement): void {
    const sweep = document.createElement("span");
    sweep.setAttribute("aria-hidden", "true");
    sweep.style.position = "absolute";
    sweep.style.inset = "0";
    sweep.style.borderRadius = "inherit";
    sweep.style.background = "linear-gradient(115deg, transparent 34%, rgba(255,255,255,.16) 49%, transparent 64%)";
    sweep.style.pointerEvents = "none";
    panel.append(sweep);
    const controls = animate(sweep, { transform: ["translateX(-120%)", "translateX(120%)"], opacity: [0, .65, 0] },
      { duration: .7, times: [0, .45, 1], ease: EASE_OUT as never });
    void controls.then(() => sweep.remove()).catch(() => sweep.remove());
  }

  private spotlight(except: HTMLElement, dim: boolean): void {
    for (const child of Array.from(this.el.children)) {
      if (child === except) continue;
      void animate(child, { opacity: dim ? .6 : 1 }, { duration: .22, ease: EASE_OUT as never });
    }
    const layer = document.getElementById("fx-layer");
    if (layer) void animate(layer, { filter: dim ? "brightness(.6)" : "brightness(1)" }, { duration: .22, ease: EASE_OUT as never });
  }

  private async revealNearMiss(teased: LootTier, truthValue: "no_drop", ctx: OverlayContext, run: number): Promise<void> {
    if (ctx.config.no_dark_pattern_mode || reduceMotion()) {
      this.revealNoDrop(ctx, undefined, run, truthValue);
      return;
    }
    const { panel, token, tierEl, itemEl } = this.makeLootPanel(teased);
    tierEl.textContent = TIER_LABEL[teased];
    itemEl.textContent = `truth: ${truthValue}`;
    this.el.append(panel);
    void enter(panel, { soft: true });
    // One restrained glimmer; no suspense copy and no fake item.
    void animate(token, { filter: ["brightness(1)", "brightness(1.08)", "brightness(1)"], opacity: [.78, 1, .78] },
      { duration: .42, ease: EASE_OUT as never });
    await this.skippableDelay(420);
    tierEl.textContent = "NO DROP";
    await this.skippableDelay(260);
    if (run === this.run) await exit(panel);
    panel.remove();
  }

  private revealNoDrop(ctx: OverlayContext, odds: Partial<Record<LootTier, number>> | undefined, run: number, truth?: "no_drop"): void {
    const node = document.createElement("div");
    node.className = "reward-float reward-float--nodrop";
    node.textContent = truth ? `no drop · truth: ${truth}` : "no drop";
    if (ctx.config.no_dark_pattern_mode && odds) node.append(this.oddsTable(odds));
    this.el.append(node);
    void enter(node);
    this.removeLater(node, reduceMotion() ? 180 : 460, run);
  }

  private oddsTable(odds?: Partial<Record<LootTier, number>>): HTMLElement {
    const table = document.createElement("div");
    table.className = "loot__odds";
    const src = odds ?? BASE_LOOT_ODDS;
    const header = document.createElement("div");
    header.className = "loot__odds-title";
    header.textContent = "Drop rates";
    table.append(header);
    for (const tier of Object.keys(src) as LootTier[]) {
      const row = document.createElement("div");
      row.className = "loot__odds-row";
      const value = src[tier] ?? 0;
      row.textContent = `${TIER_LABEL[tier]}: ${(value * 100).toFixed(value < .01 ? 2 : 1)}%`;
      table.append(row);
    }
    return table;
  }

  private skippableDelay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.skipResolve = null;
        resolve();
      };
      const timer = window.setTimeout(finish, ms);
      this.skipResolve = finish;
    });
  }
}
