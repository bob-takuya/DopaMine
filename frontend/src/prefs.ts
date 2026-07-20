// Client-side DISPLAY preferences — NOT server guardrails. These are personal,
// device-local knobs (card text size, per-card timer visibility) persisted to
// localStorage with a safe in-memory fallback when storage is unavailable
// (private mode, blocked cookies, quota). Exposes get / set / subscribe.

export type FontScale = "s" | "m" | "l";

export interface DisplayPrefs {
  /** Card font-size multiplier bucket. */
  cardFontScale: FontScale;
  /** Show the subtle per-card thinking-time timer during study. */
  showTimer: boolean;
}

/** Multipliers applied to the card face font-size via `--card-scale`. */
export const FONT_SCALE_MULTIPLIER: Record<FontScale, number> = {
  s: 0.82,
  m: 1.0,
  l: 1.22,
};

const DEFAULTS: DisplayPrefs = {
  cardFontScale: "m",
  showTimer: true,
};

const STORAGE_KEY = "dopamine.displayPrefs";

type Listener = (prefs: DisplayPrefs) => void;

/** Best-effort read of the persisted prefs; tolerates missing/corrupt storage. */
function readStored(): Partial<DisplayPrefs> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const p = parsed as Record<string, unknown>;
    const out: Partial<DisplayPrefs> = {};
    if (p.cardFontScale === "s" || p.cardFontScale === "m" || p.cardFontScale === "l") {
      out.cardFontScale = p.cardFontScale;
    }
    if (typeof p.showTimer === "boolean") out.showTimer = p.showTimer;
    return out;
  } catch {
    return {};
  }
}

class Prefs {
  private prefs: DisplayPrefs;
  private readonly listeners = new Set<Listener>();

  constructor() {
    this.prefs = { ...DEFAULTS, ...readStored() };
  }

  get(): DisplayPrefs;
  get<K extends keyof DisplayPrefs>(key: K): DisplayPrefs[K];
  get(key?: keyof DisplayPrefs): DisplayPrefs | DisplayPrefs[keyof DisplayPrefs] {
    return key === undefined ? this.prefs : this.prefs[key];
  }

  set<K extends keyof DisplayPrefs>(key: K, value: DisplayPrefs[K]): void {
    if (this.prefs[key] === value) return;
    this.prefs = { ...this.prefs, [key]: value };
    this.persist();
    for (const cb of this.listeners) cb(this.prefs);
  }

  /** Subscribe to changes. Fires immediately with the current prefs. */
  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    cb(this.prefs);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private persist(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs));
    } catch {
      /* storage unavailable — in-memory only, still fully functional this session */
    }
  }
}

export const prefs = new Prefs();
