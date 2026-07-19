// MOCK MODE — a standalone fake of the DopaMine backend so the UI is
// demonstrable without a server (toggled by ?mock=1 or on network failure).
//
// The mock mirrors the reward math in ARCHITECTURE §4 closely enough to feel
// real, but it is explicitly NOT authoritative: the real server is the source of
// truth. Idempotency is keyed by review_id, matching the contract.

import {
  BASE_LOOT_ODDS,
  DEFAULT_GUARDRAILS,
  type AnswerRequest,
  type AnswerResponse,
  type CardView,
  type ConfigResponse,
  type DecksResponse,
  type GuardrailConfig,
  type GuardrailPatch,
  type ImportSummary,
  type LootTier,
  type NextCardResponse,
  type PlayerState,
  type Rating,
  type RewardEvent,
  type SeedDemoResponse,
  type StateResponse,
  type SyncDirection,
  type SyncFullResult,
  type SyncLoginResult,
  type SyncLogoutResult,
  type SyncResult,
  type SyncStatus,
} from "./types.ts";
import { makeReviewId } from "./api.ts";

const BASE_XP: Record<Rating, number> = { 1: 4, 2: 8, 3: 10, 4: 12 };

const LOOT_POOLS: Record<LootTier, string[]> = {
  common: ["spark", "slime"],
  rare: ["neon_cat", "streak_freeze"],
  epic: ["golden_brain", "glitch_aura"],
  legendary: ["dopamine_crown"],
};

const DEMO_DECK = "DopaMine Demo";

const DEMO_NOTES: Array<{ front: string; back: string; tags: string[] }> = [
  { front: "犬", back: "dog", tags: ["dopamine-demo"] },
  { front: "猫", back: "cat", tags: ["dopamine-demo"] },
  { front: "水", back: "water", tags: ["dopamine-demo"] },
  { front: "火", back: "fire", tags: ["dopamine-demo"] },
  { front: "山", back: "mountain", tags: ["dopamine-demo"] },
  { front: "川", back: "river", tags: ["dopamine-demo"] },
  { front: "空", back: "sky", tags: ["dopamine-demo"] },
  { front: "本", back: "book", tags: ["dopamine-demo"] },
  { front: "手", back: "hand", tags: ["dopamine-demo"] },
  { front: "目", back: "eye", tags: ["dopamine-demo"] },
];

interface MockCard extends CardView {}

function nowIso(): string {
  return new Date().toISOString();
}

function localDate(tz: string): string {
  // Best-effort local calendar date in the configured timezone.
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(new Date()); // en-CA -> YYYY-MM-DD
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function levelFor(totalXp: number): number {
  return Math.floor(Math.sqrt(totalXp / 100)) + 1;
}

class MockBackend {
  private config: GuardrailConfig = { ...DEFAULT_GUARDRAILS };
  private cards: MockCard[] = [];
  private queue: string[] = []; // card_ids in scheduler order
  private sessionStart = nowIso();

  // Canonical stored fields (subset). reviews_today/level are projections.
  private state = {
    player_id: "local",
    total_xp: 0,
    combo: 0,
    streak_days: 0,
    last_active_date: null as string | null,
    rare_pity: 0,
    legendary_pity: 0,
    inventory: {} as Record<string, number>,
    reviews_today: 0,
    version: 0,
  };

  // review_id -> prior response (idempotent replay)
  private answered = new Map<string, AnswerResponse>();
  private reviewedCount = 0;
  private importSeq = 0;

  constructor() {
    this.seedInternal(false);
  }

  private seedInternal(replace: boolean): SeedDemoResponse {
    const existingBefore = this.cards.length;
    if (replace || this.cards.length === 0) {
      this.cards = DEMO_NOTES.map((n, i) => {
        const noteId = `demo-note-${i + 1}`;
        return {
          card_id: `demo-${i + 1}`,
          note_id: noteId,
          deck: DEMO_DECK,
          front_html: n.front,
          back_html: n.back,
          css: "", // plain demo cards carry no custom note-type styling
          tags: n.tags,
          due_at: nowIso(),
        };
      });
      this.queue = this.cards.map((c) => c.card_id);
    }
    return {
      deck: DEMO_DECK,
      created: replace || existingBefore === 0 ? this.cards.length : 0,
      existing: replace ? 0 : existingBefore,
      card_ids: this.cards.map((c) => c.card_id),
    };
  }

  private projectState(): PlayerState {
    return {
      player_id: this.state.player_id,
      total_xp: this.state.total_xp,
      level: levelFor(this.state.total_xp),
      combo: this.state.combo,
      streak_days: this.state.streak_days,
      last_active_date: this.state.last_active_date,
      rare_pity: this.state.rare_pity,
      legendary_pity: this.state.legendary_pity,
      inventory: { ...this.state.inventory },
      reviews_today: this.state.reviews_today,
      session_started_at: this.sessionStart,
      session_review_count: this.state.reviews_today,
      version: this.state.version,
    };
  }

  async getNextCard(deck?: string): Promise<NextCardResponse> {
    const pool = deck ? this.queue.filter((id) => {
      const c = this.cards.find((x) => x.card_id === id);
      return c && c.deck === deck;
    }) : this.queue;
    const nextId = pool[0];
    const card = nextId ? this.cards.find((c) => c.card_id === nextId) ?? null : null;
    return { card, server_time: nowIso() };
  }

  async getState(): Promise<StateResponse> {
    const dueNow = this.queue.length;
    return {
      state: this.projectState(),
      guardrails: { ...this.config },
      srs: {
        due_now: dueNow,
        reviewed_today: this.state.reviews_today,
        total_cards: this.cards.length,
        retention: null,
      },
    };
  }

  async getDecks(): Promise<DecksResponse> {
    const dueByDeck = new Map<string, number>();
    for (const id of this.queue) {
      const c = this.cards.find((x) => x.card_id === id);
      if (c) dueByDeck.set(c.deck, (dueByDeck.get(c.deck) ?? 0) + 1);
    }
    const decks = new Map<string, { due: number; total: number }>();
    for (const c of this.cards) {
      const e = decks.get(c.deck) ?? { due: 0, total: 0 };
      e.total += 1;
      decks.set(c.deck, e);
    }
    return {
      decks: Array.from(decks.entries()).map(([name, e]) => ({
        name,
        due_count: dueByDeck.get(name) ?? 0,
        total_count: e.total,
      })),
    };
  }

  async seedDemo(_deck: string, replace = false): Promise<SeedDemoResponse> {
    return this.seedInternal(replace);
  }

  /**
   * Fake an .apkg import so the flow is demoable offline (?mock=1 or after a
   * network failure). Derives a plausible deck name from the file name, adds a
   * small set of cards to the in-memory scheduler, and returns a summary shaped
   * exactly like the real POST /api/import `imported` object.
   */
  async importApkg(file: File): Promise<ImportSummary> {
    const base = (file.name || "deck").replace(/\.(apkg|colpkg)$/i, "").trim() || "deck";
    // Mimic Anki's "::" subdeck path; title-case the leaf for a friendly label.
    const leaf = base
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const deck = `Imported::${leaf}`;

    const notes: Array<{ front: string; back: string }> = [
      { front: "一", back: "one" },
      { front: "二", back: "two" },
      { front: "三", back: "three" },
      { front: "四", back: "four" },
      { front: "五", back: "five" },
      { front: "六", back: "six" },
      { front: "七", back: "seven" },
      { front: "八", back: "eight" },
      { front: "九", back: "nine" },
      { front: "十", back: "ten" },
      { front: "百", back: "hundred" },
      { front: "千", back: "thousand" },
    ];

    this.importSeq += 1;
    const seq = this.importSeq;
    // A small sample note-type CSS so ?mock=1 exercises the Shadow-DOM styling
    // path (the real backend supplies each note type's actual CSS).
    const sampleCss = ".card { background: #14142b; } .card__front { color: #7cf; }";
    const added: MockCard[] = notes.map((n, i) => ({
      card_id: `import-${seq}-${i + 1}`,
      note_id: `import-note-${seq}-${i + 1}`,
      deck,
      front_html: n.front,
      back_html: n.back,
      css: sampleCss,
      tags: ["imported"],
      due_at: nowIso(),
    }));
    this.cards.push(...added);
    this.queue.push(...added.map((c) => c.card_id));

    return { decks: [deck], notes: notes.length, cards: notes.length };
  }

  async putConfig(patch: GuardrailPatch): Promise<ConfigResponse> {
    this.config = { ...this.config, ...patch };
    return { config: { ...this.config } };
  }

  // ---- AnkiWeb sync (happy-path fake so ?mock=1 exercises the flow) --------

  private syncLoggedIn = false;

  async syncStatus(): Promise<SyncStatus> {
    return { logged_in: this.syncLoggedIn };
  }

  async syncLogin(): Promise<SyncLoginResult> {
    this.syncLoggedIn = true;
    return { ok: true, endpoint: "AnkiWeb (mock)" };
  }

  async sync(): Promise<SyncResult> {
    return {
      status: "ok",
      required: "no_changes",
      server_message: "mock sync",
      media: "started",
    };
  }

  /**
   * Fake a wholesale full sync so ?mock=1 exercises the bootstrap flow. A
   * "download" simulates pulling an AnkiWeb account down, REPLACING the local
   * collection with its decks (so refreshed decks appear). An "upload" pushes
   * local up and leaves the local collection untouched. Either way the mock is
   * (and stays) logged in and considered fully synced afterwards.
   */
  async syncFull(direction: SyncDirection): Promise<SyncFullResult> {
    this.syncLoggedIn = true;
    if (direction === "download") {
      // Replace local with a plausible "downloaded from AnkiWeb" collection.
      const downloaded: Array<{ front: string; back: string }> = [
        { front: "月", back: "moon" },
        { front: "星", back: "star" },
        { front: "海", back: "sea" },
        { front: "花", back: "flower" },
        { front: "雨", back: "rain" },
        { front: "雪", back: "snow" },
      ];
      this.cards = downloaded.map((n, i) => ({
        card_id: `ankiweb-${i + 1}`,
        note_id: `ankiweb-note-${i + 1}`,
        deck: "AnkiWeb::Bootstrap",
        front_html: n.front,
        back_html: n.back,
        css: "",
        tags: ["ankiweb"],
        due_at: nowIso(),
      }));
      this.queue = this.cards.map((c) => c.card_id);
    }
    return { status: "ok", direction };
  }

  async syncLogout(): Promise<SyncLogoutResult> {
    this.syncLoggedIn = false;
    return { ok: true };
  }

  private rollLoot(rng: () => number): {
    tier: LootTier | null;
    pityForced: boolean;
  } {
    // Legendary pity: guaranteed legendary on the 100th consecutive miss.
    if (this.state.legendary_pity >= 99) {
      return { tier: "legendary", pityForced: true };
    }
    // Rare-or-better pity on the 20th consecutive no-Rare+ review.
    if (this.state.rare_pity >= 19) {
      const r = rng();
      const tier: LootTier = r < 0.05 ? "legendary" : r < 0.25 ? "epic" : "rare";
      return { tier, pityForced: true };
    }
    // Normal variable-ratio roll, highest tier first (single roll).
    const r = rng();
    let acc = 0;
    const order: LootTier[] = ["legendary", "epic", "rare", "common"];
    const p: Record<LootTier, number> = {
      legendary: BASE_LOOT_ODDS.legendary,
      epic: BASE_LOOT_ODDS.epic,
      rare: BASE_LOOT_ODDS.rare,
      common: BASE_LOOT_ODDS.common,
    };
    for (const t of order) {
      acc += p[t];
      if (r < acc) return { tier: t, pityForced: false };
    }
    return { tier: null, pityForced: false };
  }

  async answer(req: AnswerRequest): Promise<AnswerResponse> {
    // Idempotent replay: same review_id returns the original response.
    const prior = this.answered.get(req.review_id);
    if (prior) return prior;

    const rating = req.rating;
    const comboBefore = this.state.combo;
    const rng = Math.random; // mock RNG only; server uses HMAC-seeded RNG

    // ---- XP + combo -------------------------------------------------------
    const multiplier = Math.min(2.0, 1.0 + 0.1 * Math.floor(comboBefore / 5));
    const base = BASE_XP[rating];
    const amount = Math.floor(base * multiplier);
    this.state.total_xp += amount;
    this.state.combo = rating === 1 ? 0 : comboBefore + 1;

    const events: RewardEvent[] = [];
    const ev = (
      type: RewardEvent["type"],
      payload: RewardEvent["payload"],
    ): void => {
      events.push({
        event_id: makeReviewId(),
        review_id: req.review_id,
        type,
        created_at: nowIso(),
        payload,
      } as RewardEvent);
    };

    ev("xp_awarded", { amount, multiplier: Math.round(multiplier * 100) / 100 });
    ev("combo_changed", { combo: this.state.combo });

    // ---- Streak -----------------------------------------------------------
    const today = localDate(this.config.timezone);
    const prevDate = this.state.last_active_date;
    let streakChanged = false;
    let freezeProtected = false;
    if (prevDate !== today) {
      if (prevDate === null) {
        this.state.streak_days = 1;
      } else {
        const gapDays = Math.round(
          (Date.parse(today) - Date.parse(prevDate)) / 86_400_000,
        );
        const freezes = this.state.inventory["streak_freeze"] ?? 0;
        if (gapDays === 1) {
          this.state.streak_days += 1;
        } else if (!this.config.honest_streak_mode && freezes > 0) {
          this.state.inventory["streak_freeze"] = freezes - 1;
          freezeProtected = true;
        } else {
          this.state.streak_days = 1;
        }
      }
      this.state.last_active_date = today;
      streakChanged = true;
      this.state.reviews_today = 0; // new day resets the daily projection
    }
    if (streakChanged) {
      ev("streak_changed", {
        streak_days: this.state.streak_days,
        freeze_protected: freezeProtected,
      });
    }

    // ---- Loot roll --------------------------------------------------------
    const { tier, pityForced } = this.rollLoot(rng);
    if (tier) {
      const pool = LOOT_POOLS[tier];
      const item = pool[Math.floor(rng() * pool.length)] ?? pool[0]!;
      // streak_freeze only enters inventory when honest mode is off.
      if (item !== "streak_freeze" || !this.config.honest_streak_mode) {
        this.state.inventory[item] = (this.state.inventory[item] ?? 0) + 1;
      }
      // Reset pity counters at/above their tier.
      const rank: Record<LootTier, number> = {
        common: 0,
        rare: 1,
        epic: 2,
        legendary: 3,
      };
      this.state.rare_pity = rank[tier] >= 1 ? 0 : this.state.rare_pity + 1;
      this.state.legendary_pity =
        rank[tier] >= 3 ? 0 : this.state.legendary_pity + 1;
      ev("loot_dropped", { tier, item, pity_forced: pityForced });
    } else {
      // No drop. Increment pity counters.
      this.state.rare_pity += 1;
      this.state.legendary_pity += 1;
      // Near-miss (presentation only) unless no-dark-pattern mode.
      const nearMissP = Math.min(0.25, 0.05 + 0.01 * this.state.rare_pity);
      if (!this.config.no_dark_pattern_mode && rng() < nearMissP) {
        ev("near_miss", { teased_tier: "rare", truth: "no_drop" });
      } else if (this.config.no_dark_pattern_mode) {
        ev("no_drop", {
          odds: {
            common: BASE_LOOT_ODDS.common,
            rare: BASE_LOOT_ODDS.rare,
            epic: BASE_LOOT_ODDS.epic,
            legendary: BASE_LOOT_ODDS.legendary,
          },
        });
      } else {
        ev("no_drop", {});
      }
    }

    // ---- Advance the scheduler queue -------------------------------------
    this.reviewedCount += 1;
    this.state.reviews_today += 1;
    this.state.version += 1;
    // Move answered card to the back with a synthetic next-due.
    const idx = this.queue.indexOf(req.card_id);
    if (idx >= 0) this.queue.splice(idx, 1);

    const intervalByRating: Record<Rating, number> = { 1: 0.007, 2: 1, 3: 3, 4: 6 };
    const interval = intervalByRating[rating];
    const nextDue = new Date(Date.now() + interval * 86_400_000).toISOString();

    const response: AnswerResponse = {
      review_id: req.review_id,
      srs: {
        card_id: req.card_id,
        rating,
        answered_at: nowIso(),
        next_due_at: nextDue,
        interval_days: interval,
      },
      rewards: events,
      state: this.projectState(),
    };
    this.answered.set(req.review_id, response);
    return response;
  }
}

/** Singleton mock backend used as the GET fallback and ?mock=1 target. */
export const mockApi = new MockBackend();
