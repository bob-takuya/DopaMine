// Read-only IndexedDB cache for the offline app shell (ARCHITECTURE §6).
//
// We persist only the LAST-KNOWN authoritative values: player state, guardrail
// config, decks, and the current ungraded active card. This lets the shell show
// something meaningful when the backend is unreachable.
//
// HARD RULE: we NEVER queue a speculative grade. FSRS scheduling and reward
// resolution require the server; this cache is display-only. There is no write
// path here for pending answers by design.

import type {
  CardView,
  DeckInfo,
  GuardrailConfig,
  PlayerState,
  SrsStats,
} from "./types.ts";

const DB_NAME = "dopamine";
const DB_VERSION = 1;
const STORE = "kv";

type Key = "state" | "config" | "decks" | "srs" | "activeCard";

interface CachedBundle {
  state: PlayerState | null;
  config: GuardrailConfig | null;
  decks: DeckInfo[] | null;
  srs: SrsStats | null;
  activeCard: CardView | null;
}

function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(key: Key, value: unknown): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Caching is best-effort; failures must never break the app.
  }
}

async function get<T>(key: Key): Promise<T | null> {
  if (!idbAvailable()) return null;
  try {
    const db = await openDb();
    const out = await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => resolve((r.result as T) ?? null);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return out;
  } catch {
    return null;
  }
}

export const cache = {
  saveState(state: PlayerState): Promise<void> {
    return put("state", state);
  },
  saveConfig(config: GuardrailConfig): Promise<void> {
    return put("config", config);
  },
  saveDecks(decks: DeckInfo[]): Promise<void> {
    return put("decks", decks);
  },
  saveSrs(srs: SrsStats): Promise<void> {
    return put("srs", srs);
  },
  /** Persist the current ungraded active card so the shell can show it offline. */
  saveActiveCard(card: CardView | null): Promise<void> {
    return put("activeCard", card);
  },

  async loadAll(): Promise<CachedBundle> {
    const [state, config, decks, srs, activeCard] = await Promise.all([
      get<PlayerState>("state"),
      get<GuardrailConfig>("config"),
      get<DeckInfo[]>("decks"),
      get<SrsStats>("srs"),
      get<CardView>("activeCard"),
    ]);
    return { state, config, decks, srs, activeCard };
  },
};
