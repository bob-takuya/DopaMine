// Mirror of the backend API JSON types from ARCHITECTURE.md §5.
// These are the wire contract; keep them in exact lock-step with the server.

/** Anki/FSRS answer rating. 1=Again, 2=Hard, 3=Good, 4=Easy. */
export type Rating = 1 | 2 | 3 | 4;

export const RATING_LABEL: Record<Rating, string> = {
  1: "Again",
  2: "Hard",
  3: "Good",
  4: "Easy",
};

/** GET /api/next-card -> card. Null when no card is due. */
export interface CardView {
  card_id: string;
  note_id: string;
  deck: string;
  front_html: string;
  back_html: string;
  /**
   * The note type's CSS (Anki's card template `.card { ... }` styling). Rendered
   * inside a Shadow DOM so it cannot leak into the app chrome. The backend always
   * sends it; it is "" for plain cards with no custom styling.
   */
  css: string;
  tags: string[];
  due_at: string | null; // ISO-8601 UTC
}

export interface NextCardResponse {
  card: CardView | null;
  server_time: string; // ISO-8601 UTC
}

/** The SRS side of POST /api/answer — the authoritative scheduler result. */
export interface SrsResult {
  card_id: string;
  rating: Rating;
  answered_at: string; // ISO-8601 UTC
  next_due_at: string; // ISO-8601 UTC
  interval_days: number;
}

// ---- Reward events (emitted in order by resolve_reward) --------------------

export type LootTier = "common" | "rare" | "epic" | "legendary";

export interface XpAwardedPayload {
  amount: number;
  multiplier: number;
}

export interface ComboChangedPayload {
  combo: number;
}

export interface StreakChangedPayload {
  streak_days: number;
  /** true when a freeze was consumed instead of resetting (honest mode off). */
  freeze_protected?: boolean;
}

export interface LootDroppedPayload {
  tier: LootTier;
  item: string;
  pity_forced: boolean;
}

export interface NoDropPayload {
  // Present when no_dark_pattern_mode discloses exact odds.
  odds?: Partial<Record<LootTier, number>>;
}

export interface NearMissPayload {
  teased_tier: LootTier;
  /** Always "no_drop" — a near-miss is presentation only, never a real drop. */
  truth: "no_drop";
}

export type RewardType =
  | "xp_awarded"
  | "combo_changed"
  | "streak_changed"
  | "loot_dropped"
  | "no_drop"
  | "near_miss";

interface RewardEventBase<T extends RewardType, P> {
  event_id: string;
  review_id?: string;
  type: T;
  created_at?: string;
  payload: P;
}

export type RewardEvent =
  | RewardEventBase<"xp_awarded", XpAwardedPayload>
  | RewardEventBase<"combo_changed", ComboChangedPayload>
  | RewardEventBase<"streak_changed", StreakChangedPayload>
  | RewardEventBase<"loot_dropped", LootDroppedPayload>
  | RewardEventBase<"no_drop", NoDropPayload>
  | RewardEventBase<"near_miss", NearMissPayload>;

/** Response projection of player state (subset returned on /api/answer). */
export interface PlayerState {
  player_id?: string;
  total_xp: number;
  level: number; // derived projection
  combo: number;
  streak_days: number;
  last_active_date?: string | null;
  rare_pity: number;
  legendary_pity: number;
  inventory: Record<string, number>;
  reviews_today: number; // derived projection
  session_started_at?: string | null;
  session_review_count: number;
  version: number;
}

export interface AnswerRequest {
  review_id: string; // client-generated UUID (idempotency key)
  card_id: string;
  rating: Rating;
}

export interface AnswerResponse {
  review_id: string;
  srs: SrsResult;
  rewards: RewardEvent[];
  state: PlayerState;
}

// ---- Guardrails / config (ARCHITECTURE §7, §9) -----------------------------

export interface GuardrailConfig {
  timezone: string;
  session_length_cap_minutes: number | null;
  honest_streak_mode: boolean;
  no_dark_pattern_mode: boolean;
  sound_enabled: boolean;
  haptics_enabled: boolean;
}

export type GuardrailPatch = Partial<GuardrailConfig>;

export interface SrsStats {
  due_now: number;
  reviewed_today: number;
  total_cards: number;
  retention: number | null;
}

/** GET /api/state */
export interface StateResponse {
  state: PlayerState;
  guardrails: GuardrailConfig;
  srs: SrsStats;
}

// ---- Decks -----------------------------------------------------------------

export interface DeckInfo {
  name: string;
  due_count: number;
  total_count: number;
}

export interface DecksResponse {
  decks: DeckInfo[];
}

// ---- Seed demo -------------------------------------------------------------

export interface SeedDemoRequest {
  deck: string;
  replace: boolean;
}

export interface SeedDemoResponse {
  deck: string;
  created: number;
  existing: number;
  card_ids: string[];
}

export interface ConfigResponse {
  config: GuardrailConfig;
}

// ---- Import (.apkg) --------------------------------------------------------

/** Summary of a successful `.apkg` import (POST /api/import -> `imported`). */
export interface ImportSummary {
  /** Deck names that received cards, e.g. ["Imported::JLPT N5"]. */
  decks: string[];
  notes: number;
  cards: number;
}

/** POST /api/import wire response. */
export interface ImportResponse {
  imported: ImportSummary;
}

// ---- AnkiWeb sync ----------------------------------------------------------
//
// The backend NEVER returns the AnkiWeb session token (hkey) to the client; it
// keeps it server-side. The UI only ever sees these projections. Under the
// FSRS fallback engine every sync route returns 501 SYNC_UNSUPPORTED.

/** GET /api/sync/status */
export interface SyncStatus {
  logged_in: boolean;
  /** Present when the server flags a full sync is required (e.g. "full_sync_required"). */
  required?: string;
}

/** POST /api/sync/login request body. Password is sent ONCE and never stored. */
export interface SyncLoginRequest {
  username: string;
  password: string;
}

/** POST /api/sync/login -> 200. No hkey is ever included. */
export interface SyncLoginResult {
  ok: boolean;
  /** The AnkiWeb sync endpoint the session is bound to (display only). */
  endpoint: string;
}

/** POST /api/sync -> 200. */
export interface SyncResult {
  status: "ok" | "no_changes" | "full_sync_required";
  required?: string;
  server_message?: string;
  /** "started" once media sync kicks off in the background. */
  media?: string;
}

/** POST /api/sync/logout -> {ok:true}. */
export interface SyncLogoutResult {
  ok: boolean;
}

/** Direction of a wholesale full sync (one side OVERWRITES the other). */
export type SyncDirection = "download" | "upload";

/**
 * POST /api/sync/full -> 200. A full sync REPLACES one collection wholesale:
 *  - "download" pulls AnkiWeb down, replacing the local (DopaMine) collection.
 *  - "upload" pushes local up, replacing the server.
 */
export interface SyncFullResult {
  status: string;
  direction: SyncDirection;
}

/** Uniform error envelope: {"error":{"code","message"}}. */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

/** Effective config defaults (ARCHITECTURE §7). Used before first /api/state. */
export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  timezone: "Asia/Tokyo",
  session_length_cap_minutes: 20,
  honest_streak_mode: true,
  no_dark_pattern_mode: false,
  sound_enabled: true,
  haptics_enabled: false,
};

/** Disclosed base loot odds (ARCHITECTURE §4). Shown in no-dark-pattern mode. */
export const BASE_LOOT_ODDS: Record<LootTier | "no_drop", number> = {
  common: 0.1,
  rare: 0.03,
  epic: 0.008,
  legendary: 0.002,
  no_drop: 0.86,
};
