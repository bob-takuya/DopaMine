// App bootstrap (ARCHITECTURE §6):
//  1. Register the offline app-shell service worker.
//  2. Hydrate the store from the read-only IndexedDB cache (instant shell).
//  3. Fetch authoritative state/config/decks (falls back to mock if unreachable).
//  4. Show a deck picker / seed-demo screen, then mount the feed + HUD.

import "./styles.css";
import { createApiClient } from "./api.ts";
import { cache } from "./cache.ts";
import { Hud } from "./components/hud.ts";
import { effects } from "./effects.ts";
import { Feed } from "./feed.ts";
import { store } from "./store.ts";
import type { DeckInfo, GuardrailPatch } from "./types.ts";

const api = createApiClient();

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("#app root missing");

// ---- Persistent chrome: mock/offline banner -------------------------------

const banner = document.createElement("div");
banner.className = "banner";
banner.hidden = true;
document.body.appendChild(banner);

function refreshBanner(): void {
  const snap = store.get();
  if (snap.offline) {
    banner.hidden = false;
    banner.textContent = "⚠ Offline — showing cached state (read-only, no grading)";
    banner.className = "banner banner--offline";
  } else if (snap.mock) {
    banner.hidden = false;
    banner.textContent = "🧪 Mock mode — backend unreachable, using a local fake API";
    banner.className = "banner banner--mock";
  } else {
    banner.hidden = true;
  }
}

// Keep effects flags synced to config.
store.subscribe((snap) => {
  effects.setFlags({
    soundEnabled: snap.config.sound_enabled,
    hapticsEnabled: snap.config.haptics_enabled,
  });
  refreshBanner();
});

api.onMockChange((mock) => store.setMock(mock));

window.addEventListener("online", () => {
  store.setOffline(false);
  void bootData(); // refetch authoritative state; server version wins
});
window.addEventListener("offline", () => store.setOffline(true));

// ---- Data bootstrapping ---------------------------------------------------

async function bootData(): Promise<void> {
  try {
    const [stateRes, decksRes] = await Promise.all([api.getState(), api.getDecks()]);
    store.setState(stateRes.state);
    store.setConfig(stateRes.guardrails);
    store.setSrs(stateRes.srs);
    store.setDecks(decksRes.decks);
    store.setMock(api.isMock());
    store.setOffline(false);
    void cache.saveState(stateRes.state);
    void cache.saveConfig(stateRes.guardrails);
    void cache.saveSrs(stateRes.srs);
    void cache.saveDecks(decksRes.decks);
  } catch {
    // Total failure with no mock fallback (mutating path) — mark offline.
    store.setOffline(true);
  }
}

// ---- Views ----------------------------------------------------------------

const hud = new Hud(() => openSettings());
let feed: Feed | null = null;

store.subscribe((snap) => hud.setSnapshot(snap));

function clearRoot(): void {
  appRoot!.innerHTML = "";
}

function renderDeckPicker(): void {
  clearRoot();
  const snap = store.get();
  const wrap = document.createElement("div");
  wrap.className = "picker";

  const title = document.createElement("h1");
  title.className = "picker__title";
  title.innerHTML = `Dopa<span>Mine</span>`;
  const sub = document.createElement("p");
  sub.className = "picker__sub";
  sub.textContent = "Spaced repetition, but make it dopamine. Pick a deck to start your feed.";
  wrap.append(title, sub);

  const list = document.createElement("div");
  list.className = "deck-list";
  const decks = snap.decks;
  if (decks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "picker__empty";
    empty.textContent = "No decks yet. Seed the demo deck to try it out.";
    list.appendChild(empty);
  } else {
    for (const d of decks) list.appendChild(deckCard(d));
  }
  wrap.appendChild(list);

  const actions = document.createElement("div");
  actions.className = "picker__actions";

  const seedBtn = document.createElement("button");
  seedBtn.className = "primary-btn";
  seedBtn.type = "button";
  seedBtn.textContent = "Seed demo deck (10 cards)";
  seedBtn.addEventListener("click", async () => {
    seedBtn.disabled = true;
    seedBtn.textContent = "Seeding…";
    try {
      const res = await api.seedDemo("DopaMine Demo", false);
      await bootData();
      startFeed(res.deck);
    } catch (err) {
      seedBtn.disabled = false;
      seedBtn.textContent = "Seed demo deck (10 cards)";
      alert(`Seed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const allBtn = document.createElement("button");
  allBtn.className = "ghost-btn";
  allBtn.type = "button";
  allBtn.textContent = "Study all due (no deck filter)";
  allBtn.addEventListener("click", () => startFeed(null));

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "ghost-btn";
  settingsBtn.type = "button";
  settingsBtn.textContent = "⚙ Settings & guardrails";
  settingsBtn.addEventListener("click", () => openSettings());

  actions.append(seedBtn, allBtn, settingsBtn);
  wrap.appendChild(actions);

  if (snap.mock) {
    const note = document.createElement("p");
    note.className = "picker__mock";
    note.textContent = "Running in mock mode — a local fake backend is serving demo data.";
    wrap.appendChild(note);
  }

  appRoot!.appendChild(wrap);
}

function deckCard(d: DeckInfo): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "deck-card";
  btn.type = "button";
  btn.innerHTML = `
    <span class="deck-card__name">${escapeHtml(d.name)}</span>
    <span class="deck-card__stats"><b>${d.due_count}</b> due · ${d.total_count} total</span>`;
  btn.addEventListener("click", () => startFeed(d.name));
  return btn;
}

function startFeed(deck: string | null): void {
  clearRoot();
  const shell = document.createElement("div");
  shell.className = "app-shell";

  // Back-to-decks affordance lives in the HUD area via a small control.
  const back = document.createElement("button");
  back.className = "back-btn";
  back.type = "button";
  back.setAttribute("aria-label", "Back to decks");
  back.textContent = "‹ Decks";
  back.addEventListener("click", () => renderDeckPicker());

  feed = new Feed(api, store);
  shell.append(hud.el, feed.el, back);
  appRoot!.appendChild(shell);
  void feed.start(deck);
}

// ---- Settings sheet (guardrails, mute, haptics, reduced motion) ----------

function openSettings(): void {
  const cfg = store.config;
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop";
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Settings and guardrails");

  const h = document.createElement("h2");
  h.textContent = "Settings & guardrails";
  sheet.appendChild(h);

  const note = document.createElement("p");
  note.className = "sheet__note";
  note.textContent =
    "These guardrails are explicit and honest by design. Rewards never change card order, due dates, or FSRS parameters.";
  sheet.appendChild(note);

  // Toggles wired to PUT /api/config (guardrails) or local effect flags.
  const toggles: Array<{ key: keyof GuardrailPatch | "reduced"; label: string; desc: string; value: boolean }> = [
    { key: "sound_enabled", label: "Sound", desc: "Rising-pitch answer chimes & loot fanfare.", value: cfg.sound_enabled },
    { key: "haptics_enabled", label: "Haptics (opt-in)", desc: "Vibration on grade, combo, and loot. Off by default.", value: cfg.haptics_enabled },
    { key: "honest_streak_mode", label: "Honest streaks", desc: "Streak counts real study days only; no freezes.", value: cfg.honest_streak_mode },
    { key: "no_dark_pattern_mode", label: "No dark patterns", desc: "No near-misses, disclosed odds, deliberate stop after 10 cards.", value: cfg.no_dark_pattern_mode },
  ];

  for (const t of toggles) {
    const row = document.createElement("label");
    row.className = "toggle-row";
    const info = document.createElement("div");
    info.className = "toggle-row__info";
    const lab = document.createElement("span");
    lab.className = "toggle-row__label";
    lab.textContent = t.label;
    const desc = document.createElement("span");
    desc.className = "toggle-row__desc";
    desc.textContent = t.desc;
    info.append(lab, desc);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "toggle-row__input";
    input.checked = t.value;
    input.addEventListener("change", async () => {
      const patch: GuardrailPatch = { [t.key]: input.checked } as GuardrailPatch;
      try {
        const res = await api.putConfig(patch);
        store.setConfig(res.config);
        void cache.saveConfig(res.config);
      } catch (err) {
        input.checked = !input.checked;
        alert(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    row.append(info, input);
    sheet.appendChild(row);
  }

  // Session cap selector
  const capRow = document.createElement("div");
  capRow.className = "toggle-row";
  const capInfo = document.createElement("div");
  capInfo.className = "toggle-row__info";
  const capLab = document.createElement("span");
  capLab.className = "toggle-row__label";
  capLab.textContent = "Session length cap";
  const capDesc = document.createElement("span");
  capDesc.className = "toggle-row__desc";
  capDesc.textContent = "Healthy-use stop. The feed ends the session at this limit.";
  capInfo.append(capLab, capDesc);
  const capSel = document.createElement("select");
  capSel.className = "cap-select";
  const options: Array<[string, number | null]> = [
    ["10 min", 10],
    ["20 min", 20],
    ["30 min", 30],
    ["No cap", null],
  ];
  for (const [label, val] of options) {
    const opt = document.createElement("option");
    opt.value = String(val);
    opt.textContent = label;
    if (cfg.session_length_cap_minutes === val) opt.selected = true;
    capSel.appendChild(opt);
  }
  capSel.addEventListener("change", async () => {
    const val = capSel.value === "null" ? null : Number(capSel.value);
    try {
      const res = await api.putConfig({ session_length_cap_minutes: val });
      store.setConfig(res.config);
      void cache.saveConfig(res.config);
    } catch (err) {
      alert(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  capRow.append(capInfo, capSel);
  sheet.appendChild(capRow);

  // Transparency: pity counters + disclosed odds
  const st = store.state;
  if (st) {
    const trans = document.createElement("div");
    trans.className = "sheet__transparency";
    trans.innerHTML = `
      <h3>Transparency</h3>
      <div>Rare pity: <b>${st.rare_pity}</b> / 20 · Legendary pity: <b>${st.legendary_pity}</b> / 100</div>
      <div>Base drop rates: Common 10% · Rare 3% · Epic 0.8% · Legendary 0.2% · No drop 86%</div>
      <div>Inventory: ${
        Object.keys(st.inventory).length
          ? Object.entries(st.inventory).map(([k, v]) => `${escapeHtml(k)} ×${v}`).join(", ")
          : "empty"
      }</div>`;
    sheet.appendChild(trans);
  }

  const close = document.createElement("button");
  close.className = "primary-btn";
  close.type = "button";
  close.textContent = "Done";
  close.addEventListener("click", () => backdrop.remove());
  sheet.appendChild(close);

  backdrop.appendChild(sheet);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
}

// ---- Service worker (offline app shell) ----------------------------------

function registerSw(): void {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol === "file:") return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* offline shell is a progressive enhancement */
    });
  });
}

// ---- Go --------------------------------------------------------------------

async function main(): Promise<void> {
  registerSw();
  store.setOffline(typeof navigator !== "undefined" && navigator.onLine === false);

  // Instant shell from cache.
  const cached = await cache.loadAll();
  store.hydrate({
    state: cached.state,
    config: cached.config ?? undefined,
    decks: cached.decks ?? undefined,
    srs: cached.srs,
  });
  renderDeckPicker();

  await bootData();
  renderDeckPicker(); // re-render with authoritative decks
}

void main();

// Minimal HTML escaping for text interpolated into innerHTML above.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
