// Reward overlay: consumes server reward events IN ORDER and presents them.
//
// Contract (ARCHITECTURE §6, §9):
//  - Renders EXACTLY the server payload. It never rerolls or invents outcomes;
//    a near_miss carries truth="no_drop" and MUST NOT show a real drop.
//  - XP/combo/streak are a non-blocking ~700ms flourish.
//  - Loot reveal is a skippable, at-most-1.5s anticipation. The suspense timing
//    is randomized *presentation only* — the tier shown is the server's tier.
//  - In no_dark_pattern_mode: near-miss events are already suppressed server-
//    side; the overlay drops suspense delays and shows disclosed odds.

import {
  BASE_LOOT_ODDS,
  type GuardrailConfig,
  type LootTier,
  type RewardEvent,
} from "../types.ts";
import { effects } from "../effects.ts";

const TIER_LABEL: Record<LootTier, string> = {
  common: "COMMON",
  rare: "RARE",
  epic: "EPIC",
  legendary: "LEGENDARY",
};

const ITEM_EMOJI: Record<string, string> = {
  spark: "✨",
  slime: "🟢",
  neon_cat: "🐱",
  streak_freeze: "🧊",
  golden_brain: "🧠",
  glitch_aura: "🌀",
  dopamine_crown: "👑",
};

export interface OverlayContext {
  config: GuardrailConfig;
  /** Player level before vs after, to detect a level-up moment. */
  levelBefore: number;
  levelAfter: number;
}

export class RewardOverlay {
  readonly el: HTMLElement;
  private skipResolve: (() => void) | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "reward-overlay";
    this.el.setAttribute("aria-live", "polite");
    // Tap anywhere to skip the current loot reveal.
    this.el.addEventListener("pointerdown", () => this.skip());
  }

  private skip(): void {
    if (this.skipResolve) {
      const r = this.skipResolve;
      this.skipResolve = null;
      r();
    }
  }

  /**
   * Play a reward sequence. Resolves when the (skippable) loot reveal is done so
   * the feed can then animate the answered card out.
   */
  async play(events: RewardEvent[], ctx: OverlayContext): Promise<void> {
    this.config = ctx.config;
    const reduced =
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Consume in emitted order.
    for (const ev of events) {
      switch (ev.type) {
        case "xp_awarded":
          this.flourishXp(ev.payload.amount, ev.payload.multiplier);
          break;
        case "combo_changed":
          if (ev.payload.combo >= 2) this.flourishCombo(ev.payload.combo);
          break;
        case "streak_changed":
          this.flourishStreak(
            ev.payload.streak_days,
            ev.payload.freeze_protected === true,
          );
          break;
        case "loot_dropped":
          await this.revealLoot(
            ev.payload.tier,
            ev.payload.item,
            ev.payload.pity_forced,
            ctx,
            reduced,
          );
          break;
        case "near_miss":
          // Presentation only — teases a tier but truth is no_drop.
          await this.revealNearMiss(ev.payload.teased_tier, ctx, reduced);
          break;
        case "no_drop":
          this.revealNoDrop(ctx, "odds" in ev.payload ? ev.payload.odds : undefined);
          break;
      }
    }

    // Level-up sting after the sequence, if the level advanced.
    if (ctx.levelAfter > ctx.levelBefore) {
      this.levelUp(ctx.levelAfter);
    }
  }

  // ---- Non-blocking flourishes (~700ms) -----------------------------------

  private floater(text: string, cls: string, life = 700): void {
    const node = document.createElement("div");
    node.className = `reward-float ${cls}`;
    node.textContent = text;
    this.el.appendChild(node);
    window.setTimeout(() => node.remove(), life + 60);
  }

  private flourishXp(amount: number, multiplier: number): void {
    const mult = multiplier > 1 ? ` ×${multiplier.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}` : "";
    this.floater(`+${amount} XP${mult}`, "reward-float--xp");
  }

  private flourishCombo(combo: number): void {
    this.floater(`x${combo} COMBO`, "reward-float--combo");
  }

  private flourishStreak(days: number, freezeProtected: boolean): void {
    const label = freezeProtected
      ? `🧊 Streak ${days} (freeze protected)`
      : `🔥 ${days}-day streak`;
    this.floater(label, "reward-float--streak", 900);
  }

  private levelUp(level: number): void {
    if (this.el.querySelector(".levelup")) return;
    const node = document.createElement("div");
    node.className = "levelup";
    node.innerHTML = `<span class="levelup__flash"></span><span class="levelup__text">LEVEL ${level}</span>`;
    this.el.appendChild(node);
    if (this.config?.sound_enabled) effects.levelUpChime();
    effects.burst({ tier: "epic" });
    window.setTimeout(() => node.remove(), 1400);
  }

  private config: GuardrailConfig | null = null;

  // ---- Loot reveal (skippable, ≤1.5s) -------------------------------------

  private async revealLoot(
    tier: LootTier,
    item: string,
    pityForced: boolean,
    ctx: OverlayContext,
    reduced: boolean,
  ): Promise<void> {
    this.config = ctx.config;
    const noDark = ctx.config.no_dark_pattern_mode;
    // Anticipation duration: randomized presentation, capped at 1.5s. No-dark or
    // reduced-motion collapses it to an instant reveal.
    const suspenseMs = noDark || reduced ? 0 : 400 + Math.floor(Math.random() * 1100);

    const panel = document.createElement("div");
    panel.className = `loot loot--${tier}`;
    const chest = document.createElement("div");
    chest.className = "loot__chest";
    chest.textContent = "🎁";
    const tierEl = document.createElement("div");
    tierEl.className = "loot__tier";
    tierEl.textContent = suspenseMs > 0 ? "…" : TIER_LABEL[tier];
    const itemEl = document.createElement("div");
    itemEl.className = "loot__item";
    const skipHint = document.createElement("div");
    skipHint.className = "loot__skip";
    skipHint.textContent = "tap to skip";
    panel.append(chest, tierEl, itemEl, skipHint);

    if (noDark) {
      panel.appendChild(this.oddsTable());
    }
    this.el.appendChild(panel);

    // Anticipation window (skippable).
    if (suspenseMs > 0) {
      panel.classList.add("loot--suspense");
      await this.skippableDelay(suspenseMs);
      panel.classList.remove("loot--suspense");
    }

    // Land the exact server outcome.
    tierEl.textContent = TIER_LABEL[tier];
    itemEl.textContent = `${ITEM_EMOJI[item] ?? "🎁"} ${item}`;
    if (pityForced) {
      const pity = document.createElement("div");
      pity.className = "loot__pity";
      pity.textContent = "pity guaranteed";
      panel.appendChild(pity);
    }
    if (ctx.config.sound_enabled) effects.lootChime(tier);
    if (ctx.config.haptics_enabled) effects.lootHaptic(tier);
    effects.burst({ tier });

    // Hold the landed reveal briefly (also skippable).
    await this.skippableDelay(noDark || reduced ? 300 : 700);
    panel.classList.add("loot--out");
    window.setTimeout(() => panel.remove(), 260);
  }

  private async revealNearMiss(
    teased: LootTier,
    ctx: OverlayContext,
    reduced: boolean,
  ): Promise<void> {
    // Honest: tease the tier, then reveal it did NOT drop. Never shows an item.
    this.config = ctx.config;
    const panel = document.createElement("div");
    panel.className = `loot loot--near-miss loot--${teased}`;
    const chest = document.createElement("div");
    chest.className = "loot__chest";
    chest.textContent = "🎁";
    const tierEl = document.createElement("div");
    tierEl.className = "loot__tier";
    tierEl.textContent = `so close… ${TIER_LABEL[teased]}?`;
    const truth = document.createElement("div");
    truth.className = "loot__item loot__item--miss";
    panel.append(chest, tierEl, truth);
    this.el.appendChild(panel);

    const suspenseMs = reduced ? 0 : 500 + Math.floor(Math.random() * 800);
    if (suspenseMs > 0) {
      panel.classList.add("loot--suspense");
      await this.skippableDelay(suspenseMs);
      panel.classList.remove("loot--suspense");
    }
    tierEl.textContent = `${TIER_LABEL[teased]}…`;
    truth.textContent = "no drop";
    effects.softBlip();
    await this.skippableDelay(reduced ? 200 : 500);
    panel.classList.add("loot--out");
    window.setTimeout(() => panel.remove(), 260);
  }

  private revealNoDrop(
    ctx: OverlayContext,
    odds?: Partial<Record<LootTier, number>>,
  ): void {
    this.config = ctx.config;
    // No celebration for no-drop, especially in no_dark_pattern_mode.
    const node = document.createElement("div");
    node.className = "reward-float reward-float--nodrop";
    node.textContent = "no drop";
    this.el.appendChild(node);
    if (ctx.config.no_dark_pattern_mode && odds) {
      node.appendChild(this.oddsTable(odds));
    }
    window.setTimeout(() => node.remove(), 900);
  }

  private oddsTable(odds?: Partial<Record<LootTier, number>>): HTMLElement {
    const table = document.createElement("div");
    table.className = "loot__odds";
    const src = odds ?? {
      common: BASE_LOOT_ODDS.common,
      rare: BASE_LOOT_ODDS.rare,
      epic: BASE_LOOT_ODDS.epic,
      legendary: BASE_LOOT_ODDS.legendary,
    };
    const header = document.createElement("div");
    header.className = "loot__odds-title";
    header.textContent = "Drop rates";
    table.appendChild(header);
    (Object.keys(src) as LootTier[]).forEach((tier) => {
      const row = document.createElement("div");
      row.className = "loot__odds-row";
      const pct = ((src[tier] ?? 0) * 100).toFixed(src[tier]! < 0.01 ? 2 : 1);
      row.textContent = `${TIER_LABEL[tier]}: ${pct}%`;
      table.appendChild(row);
    });
    return table;
  }

  private skippableDelay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.skipResolve = null;
        clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(finish, ms);
      this.skipResolve = finish;
    });
  }
}
