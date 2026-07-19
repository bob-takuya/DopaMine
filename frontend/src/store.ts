// A tiny observable store holding authoritative player state, guardrail config,
// decks, and SRS stats. The server's `version` is the arbiter: an update whose
// state.version is older than what we already hold is ignored for the HUD, so
// stale/out-of-order responses never regress the display (ARCHITECTURE §6).

import type {
  DeckInfo,
  GuardrailConfig,
  PlayerState,
  SrsStats,
} from "./types.ts";
import { DEFAULT_GUARDRAILS } from "./types.ts";

export interface AppSnapshot {
  state: PlayerState | null;
  config: GuardrailConfig;
  decks: DeckInfo[];
  srs: SrsStats | null;
  mock: boolean;
  offline: boolean;
  activeDeck: string | null;
}

type Listener = (snap: AppSnapshot) => void;

export class Store {
  private snap: AppSnapshot = {
    state: null,
    config: { ...DEFAULT_GUARDRAILS },
    decks: [],
    srs: null,
    mock: false,
    offline: false,
    activeDeck: null,
  };
  private readonly listeners = new Set<Listener>();

  get(): AppSnapshot {
    return this.snap;
  }

  get state(): PlayerState | null {
    return this.snap.state;
  }

  get config(): GuardrailConfig {
    return this.snap.config;
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    cb(this.snap); // fire immediately with current snapshot
    return () => this.listeners.delete(cb);
  }

  private emit(patch: Partial<AppSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const cb of this.listeners) cb(this.snap);
  }

  /**
   * Merge an authoritative player state. Server `version` wins: a lower or equal
   * version than the one we already display is dropped (unless we had none).
   */
  setState(next: PlayerState): void {
    const cur = this.snap.state;
    if (cur && next.version < cur.version) return; // stale — ignore
    this.emit({ state: next });
  }

  setConfig(next: GuardrailConfig): void {
    this.emit({ config: next });
  }

  setDecks(next: DeckInfo[]): void {
    this.emit({ decks: next });
  }

  setSrs(next: SrsStats): void {
    this.emit({ srs: next });
  }

  setActiveDeck(deck: string | null): void {
    this.emit({ activeDeck: deck });
  }

  setMock(mock: boolean): void {
    if (this.snap.mock === mock) return;
    this.emit({ mock });
  }

  setOffline(offline: boolean): void {
    if (this.snap.offline === offline) return;
    this.emit({ offline });
  }

  /** Hydrate from read-only cache without overriding fresher server state. */
  hydrate(patch: {
    state?: PlayerState | null;
    config?: GuardrailConfig;
    decks?: DeckInfo[];
    srs?: SrsStats | null;
  }): void {
    const merged: Partial<AppSnapshot> = {};
    if (patch.state && (!this.snap.state || patch.state.version > this.snap.state.version)) {
      merged.state = patch.state;
    }
    if (patch.config) merged.config = patch.config;
    if (patch.decks && this.snap.decks.length === 0) merged.decks = patch.decks;
    if (patch.srs && !this.snap.srs) merged.srs = patch.srs;
    if (Object.keys(merged).length) this.emit(merged);
  }
}

export const store = new Store();
