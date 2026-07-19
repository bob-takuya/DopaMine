// App bootstrap (ARCHITECTURE §6):
//  1. Register the offline app-shell service worker.
//  2. Hydrate the store from the read-only IndexedDB cache (instant shell).
//  3. Fetch authoritative state/config/decks (falls back to mock if unreachable).
//  4. Show a deck picker / seed-demo screen, then mount the feed + HUD.

import "./styles.css";
import { ApiError, createApiClient } from "./api.ts";
import { cache } from "./cache.ts";
import { Hud } from "./components/hud.ts";
import { effects } from "./effects.ts";
import { Feed } from "./feed.ts";
import { store } from "./store.ts";
import type { DeckInfo, GuardrailPatch, SyncDirection } from "./types.ts";

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
  syncFinishBtn = null; // the study-view sync button is gone once we leave the feed
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

  // Import .apkg — a styled label wrapping a real file input so Playwright /
  // native pickers can drive it, while the neon button chrome stays consistent.
  const importLabel = document.createElement("label");
  importLabel.className = "ghost-btn import-label";
  const importText = document.createElement("span");
  importText.textContent = "⬆ Import .apkg";
  const importInput = document.createElement("input");
  importInput.type = "file";
  importInput.accept = ".apkg,.colpkg";
  importInput.className = "import-input";
  importInput.setAttribute("aria-label", "Import an Anki .apkg deck");
  importInput.addEventListener("change", () => {
    const file = importInput.files?.[0];
    if (file) void importDeck(file, importLabel, importText);
  });
  importLabel.append(importText, importInput);

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

  const syncBtn = document.createElement("button");
  syncBtn.className = "ghost-btn";
  syncBtn.type = "button";
  syncBtn.textContent = "☁ AnkiWeb Sync";
  syncBtn.addEventListener("click", () => openSync());

  actions.append(seedBtn, importLabel, allBtn, settingsBtn, syncBtn);
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

  // New study session for this deck: reset the per-tab review counter and the
  // one-shot leave-sync guard so the auto-sync safety net can fire again.
  sessionReviews = 0;
  leaveSyncFired = false;

  // Back-to-decks affordance lives in the HUD area via a small control.
  const back = document.createElement("button");
  back.className = "back-btn";
  back.type = "button";
  back.setAttribute("aria-label", "Back to decks");
  back.textContent = "‹ Decks";
  back.addEventListener("click", () => renderDeckPicker());

  // "☁ 同期して終了" — sync the whole collection back to AnkiWeb, then show a
  // calm "done, safe to close" screen. Only visible when sync is available
  // (logged in on the Anki engine); otherwise it stays hidden, no error shown.
  const syncFinish = document.createElement("button");
  syncFinish.className = "sync-finish-btn";
  syncFinish.type = "button";
  syncFinish.textContent = "☁ 同期して終了";
  syncFinish.hidden = !canSync();
  syncFinish.addEventListener("click", () => void doSyncFinish(syncFinish));
  syncFinishBtn = syncFinish;

  feed = new Feed(api, store, { onReview: () => onSessionReview() });
  shell.append(hud.el, feed.el, back, syncFinish);
  appRoot!.appendChild(shell);
  void feed.start(deck);
}

/** One review committed in the feed — count it for the session summary + gate. */
function onSessionReview(): void {
  sessionReviews += 1;
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

// ---- AnkiWeb sync panel ---------------------------------------------------
//
// Opened from the deck picker's "☁ AnkiWeb Sync" button. The password is only
// ever held in the live <input> and the single login POST — it is never stored,
// logged, echoed back, or written to localStorage/IndexedDB.

// Last known sync endpoint label (display only). Kept in memory for the life of
// the tab; deliberately NOT persisted. The server never returns the hkey.
let syncEndpoint: string | null = null;

function openSync(): void {
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop";
  const sheet = document.createElement("div");
  sheet.className = "sheet sync-sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "AnkiWeb sync");

  const h = document.createElement("h2");
  h.textContent = "☁ AnkiWeb Sync";
  sheet.appendChild(h);

  const note = document.createElement("p");
  note.className = "sheet__note";
  note.textContent =
    "Sync your progress back to the real Anki apps. Your password is sent once to log in and is never stored in the browser.";
  sheet.appendChild(note);

  const body = document.createElement("div");
  body.className = "sync-body";
  sheet.appendChild(body);

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

  void refreshSync(body);
}

/** Fetch status and render the correct sub-view (unsupported / login / synced). */
async function refreshSync(body: HTMLElement): Promise<void> {
  body.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "sync-note";
  loading.textContent = "Checking sync status…";
  body.appendChild(loading);

  try {
    const status = await api.syncStatus();
    if (status.logged_in) {
      renderSyncLoggedIn(body, status.required);
    } else {
      renderSyncLogin(body);
    }
  } catch (err) {
    if (err instanceof ApiError && err.code === "SYNC_UNSUPPORTED") {
      renderSyncUnsupported(body);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    body.replaceChildren();
    const p = document.createElement("p");
    p.className = "sync-note sync-note--error";
    p.textContent = `Could not check sync status: ${msg}`;
    body.appendChild(p);
  }
}

/** 501 SYNC_UNSUPPORTED: no form — an informational note instead of a scary error. */
function renderSyncUnsupported(body: HTMLElement): void {
  body.replaceChildren();
  const p = document.createElement("p");
  p.className = "sync-note sync-note--info";
  p.textContent =
    "Sync needs the Anki engine. Start the backend with DOPAMINE_SRS_ENGINE=anki and a real collection.";
  body.appendChild(p);
}

/** Logged-out: a small AnkiWeb login form. */
function renderSyncLogin(body: HTMLElement): void {
  body.replaceChildren();

  const form = document.createElement("form");
  form.className = "sync-form";
  form.setAttribute("autocomplete", "off");

  const userInput = document.createElement("input");
  userInput.type = "text";
  userInput.className = "sync-input";
  userInput.name = "anki-username";
  userInput.placeholder = "AnkiWeb email";
  userInput.autocomplete = "off";
  userInput.setAttribute("aria-label", "AnkiWeb email");

  const passInput = document.createElement("input");
  passInput.type = "password";
  passInput.className = "sync-input";
  passInput.name = "anki-password";
  passInput.placeholder = "Password";
  passInput.autocomplete = "off";
  passInput.setAttribute("aria-label", "AnkiWeb password");

  const errEl = document.createElement("p");
  errEl.className = "sync-note sync-note--error";
  errEl.hidden = true;

  const submit = document.createElement("button");
  submit.className = "primary-btn";
  submit.type = "submit";
  submit.textContent = "Log in";

  const showErr = (m: string): void => {
    errEl.textContent = m;
    errEl.hidden = false;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const username = userInput.value.trim();
    const password = passInput.value;
    if (!username || !password) {
      showErr("Enter your AnkiWeb email and password.");
      return;
    }
    submit.disabled = true;
    submit.textContent = "Logging in…";
    try {
      const res = await api.syncLogin(username, password);
      syncEndpoint = res.endpoint || null;
      // Never keep the password around after the request resolves.
      passInput.value = "";
      showToast(`Logged in to ${res.endpoint || "AnkiWeb"}`, "success");
      store.setMock(api.isMock());
      // A fresh login makes whole-collection sync available — re-check so the
      // "☁ 同期して終了" affordance turns on.
      void refreshSyncAvailability();
      renderSyncLoggedIn(body);
    } catch (err) {
      // Clear the password regardless of outcome; never render it back.
      passInput.value = "";
      if (err instanceof ApiError && err.code === "SYNC_UNSUPPORTED") {
        renderSyncUnsupported(body);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      showErr(msg);
      submit.disabled = false;
      submit.textContent = "Log in";
    }
  });

  form.append(userInput, passInput, errEl, submit);
  body.appendChild(form);
}

/** Logged-in: identity line + "Sync now" + "Log out" + advanced bootstrap. */
function renderSyncLoggedIn(body: HTMLElement, required?: string): void {
  body.replaceChildren();

  const who = document.createElement("p");
  who.className = "sync-note sync-note--ok";
  who.textContent = `Synced as ${syncEndpoint || "AnkiWeb"}`;
  body.appendChild(who);

  if (required) {
    const req = document.createElement("p");
    req.className = "sync-note sync-note--warn";
    req.textContent =
      "AnkiWebと差分があり、通常の同期ができません。すでにAnki側にデッキがある場合は、下の「AnkiWebから取り込む」で学習データをこの端末に取り込めます。";
    body.appendChild(req);
  }

  const row = document.createElement("div");
  row.className = "sync-actions";

  const syncBtn = document.createElement("button");
  syncBtn.className = "primary-btn";
  syncBtn.type = "button";
  syncBtn.textContent = "Sync now";
  syncBtn.addEventListener("click", () => void doSync(syncBtn, body));

  const logoutBtn = document.createElement("button");
  logoutBtn.className = "ghost-btn";
  logoutBtn.type = "button";
  logoutBtn.textContent = "Log out";
  logoutBtn.addEventListener("click", async () => {
    logoutBtn.disabled = true;
    try {
      await api.syncLogout();
    } catch {
      /* best-effort: drop the local view even if the call failed */
    }
    syncEndpoint = null;
    syncAvailable = false; // sync is no longer available once logged out
    if (syncFinishBtn) syncFinishBtn.hidden = true;
    showToast("Logged out of AnkiWeb", "success");
    renderSyncLogin(body);
  });

  row.append(syncBtn, logoutBtn);
  body.appendChild(row);

  // ---- Advanced / bootstrap: wholesale full sync (OVERWRITES one side) ------
  // Only shown when logged in on the Anki engine. Each button OVERWRITES an
  // entire collection, so both require an explicit confirm() first. When a
  // full sync is required we surface (and highlight) these prominently — a
  // download is exactly how a user seeds DopaMine from an account with decks.
  const adv = document.createElement("details");
  adv.className = "sync-advanced";
  if (required) adv.open = true; // surface prominently on full_sync_required
  const summary = document.createElement("summary");
  summary.className = "sync-advanced__summary";
  summary.textContent = "Advanced / bootstrap";
  adv.appendChild(summary);

  const advNote = document.createElement("p");
  advNote.className = "sync-note";
  advNote.textContent =
    "どちらか一方の内容でもう一方を丸ごと置き換えます。取り消せません。";
  adv.appendChild(advNote);

  const advRow = document.createElement("div");
  advRow.className = "sync-actions";

  const downloadBtn = document.createElement("button");
  downloadBtn.className = "ghost-btn";
  downloadBtn.type = "button";
  downloadBtn.textContent = "⬇ AnkiWebから取り込む（ローカルを置き換え）";
  downloadBtn.addEventListener("click", () => {
    if (
      !confirm(
        "AnkiWebの内容でこの端末の学習データを置き換えます。ローカルの変更は失われます。よろしいですか？",
      )
    ) {
      return;
    }
    void doSyncFull("download", downloadBtn, body);
  });

  const uploadBtn = document.createElement("button");
  uploadBtn.className = "ghost-btn";
  uploadBtn.type = "button";
  uploadBtn.textContent = "⬆ ローカルをAnkiWebへ上書き";
  uploadBtn.addEventListener("click", () => {
    if (
      !confirm(
        "この端末の内容でAnkiWeb側のコレクションを置き換えます。AnkiWeb側の変更は失われます。よろしいですか？",
      )
    ) {
      return;
    }
    void doSyncFull("upload", uploadBtn, body);
  });

  advRow.append(downloadBtn, uploadBtn);
  adv.appendChild(advRow);
  body.appendChild(adv);
}

/** Run POST /api/sync/full (a destructive, wholesale replace) and toast it. */
async function doSyncFull(
  direction: SyncDirection,
  btn: HTMLButtonElement,
  body: HTMLElement,
): Promise<void> {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = direction === "download" ? "取り込み中…" : "上書き中…";
  try {
    await api.syncFull(direction);
    store.setMock(api.isMock());
    // Refresh authoritative state/decks so a freshly downloaded collection
    // appears in the picker and HUD.
    await bootData();
    showToast(
      direction === "download"
        ? "AnkiWebから取り込みました"
        : "AnkiWebへ上書きしました",
      "success",
    );
    renderDeckPicker();
    renderSyncLoggedIn(body);
  } catch (err) {
    if (err instanceof ApiError && err.code === "SYNC_UNSUPPORTED") {
      renderSyncUnsupported(body);
      return;
    }
    if (err instanceof ApiError && err.code === "SYNC_NOT_LOGGED_IN") {
      syncEndpoint = null;
      showToast("Session expired — please log in again.", "error");
      renderSyncLogin(body);
      return;
    }
    // 502 SYNC_FAILED (and any other fault): surface the server's message.
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`フルシンクに失敗しました: ${msg}`, "error");
    btn.disabled = false;
    btn.textContent = original ?? "";
  }
}

/** Run POST /api/sync and toast the outcome per the contract. */
async function doSync(btn: HTMLButtonElement, body: HTMLElement): Promise<void> {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Syncing…";
  syncInFlight = true;
  try {
    const res = await api.sync();
    if (res.status === "full_sync_required") {
      showToast(
        "フルシンクが必要です。すでにAnki側にデッキがあるなら「Advanced / bootstrap」の「⬇ AnkiWebから取り込む」で取り込めます。",
        "warning",
      );
      renderSyncLoggedIn(body, res.required || "full_sync_required");
      return;
    }
    const msg =
      res.status === "no_changes"
        ? "Already up to date — no changes to sync."
        : res.server_message
          ? `Sync complete — ${res.server_message}.`
          : "Sync complete.";
    showToast(msg, "success");
  } catch (err) {
    if (err instanceof ApiError && err.code === "SYNC_UNSUPPORTED") {
      renderSyncUnsupported(body);
      return;
    }
    if (err instanceof ApiError && err.code === "SYNC_NOT_LOGGED_IN") {
      syncEndpoint = null;
      showToast("Session expired — please log in again.", "error");
      renderSyncLogin(body);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`Sync failed: ${msg}`, "error");
  } finally {
    syncInFlight = false;
    btn.disabled = false;
    btn.textContent = original ?? "Sync now";
  }
}

// ---- Sync & finish study flow --------------------------------------------
//
// A logged-in user studies the deck they picked, then taps "☁ 同期して終了" to
// push their reviews to AnkiWeb (sync is WHOLE-COLLECTION; there is no per-deck
// sync). We also fire a best-effort background sync when the tab is closed or
// backgrounded, so reviews aren't stranded if the user just walks away.

// Cached sync-availability: true only when logged in on the Anki engine. Under
// the FSRS engine syncStatus() 501s (SYNC_UNSUPPORTED) and this stays false, so
// the sync-finish affordances simply never appear (no errors shown).
let syncAvailable = false;
// Per-tab study-session review count (drives the summary + the leave-sync gate).
let sessionReviews = 0;
// One-shot guard so the leave beacon fires at most once per hidden transition.
let leaveSyncFired = false;
// True while a manual sync (finish button or panel "Sync now") is in flight, so
// the leave beacon never double-fires on top of it.
let syncInFlight = false;
// The live study-view sync button, when mounted (null on the deck picker).
let syncFinishBtn: HTMLButtonElement | null = null;

/** Is a whole-collection AnkiWeb sync usable right now? (logged in, Anki engine) */
function canSync(): boolean {
  return syncAvailable;
}

/** Check sync availability once and cache it; also reflect it on the live button. */
async function refreshSyncAvailability(): Promise<void> {
  try {
    const status = await api.syncStatus();
    syncAvailable = status.logged_in === true;
  } catch {
    // 501 SYNC_UNSUPPORTED (FSRS engine) or a transient failure — treat as
    // "sync unavailable" and hide the affordance rather than surfacing an error.
    syncAvailable = false;
  }
  if (syncFinishBtn) syncFinishBtn.hidden = !canSync();
}

/** Tap handler: sync the collection, then show the calm "完了" screen. */
async function doSyncFinish(btn: HTMLButtonElement): Promise<void> {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "同期中…";
  syncInFlight = true;
  try {
    const res = await api.sync();
    store.setMock(api.isMock());
    if (res.status === "full_sync_required") {
      showToast(
        "フルシンクが必要です。「☁ AnkiWeb Sync」パネルの「Advanced / bootstrap」から取り込んでください。",
        "warning",
      );
      return;
    }
    showFinishScreen();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.code === "SYNC_NOT_LOGGED_IN")) {
      // Session expired: sync is no longer available; hide the button too.
      syncAvailable = false;
      if (syncFinishBtn) syncFinishBtn.hidden = true;
      showToast("AnkiWebに再ログインしてください", "error");
    } else {
      // 502 SYNC_FAILED (and any other fault): surface the server's message.
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`同期に失敗しました: ${msg}`, "error");
    }
  } finally {
    syncInFlight = false;
    btn.disabled = false;
    btn.textContent = original ?? "☁ 同期して終了";
  }
}

/** Calm terminal overlay: "synced — safe to close", with a session summary. */
function showFinishScreen(): void {
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop finish-backdrop";
  const sheet = document.createElement("div");
  sheet.className = "sheet finish-sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "同期完了");

  const h = document.createElement("h2");
  h.textContent = "完了 🎉";
  sheet.appendChild(h);

  const note = document.createElement("p");
  note.className = "sheet__note";
  note.textContent = "同期しました。タブを閉じてOKです。";
  sheet.appendChild(note);

  const deck = store.get().activeDeck;
  const summary = document.createElement("p");
  summary.className = "finish-summary";
  summary.textContent = `デッキ: ${deck ? deck : "すべての期限カード"} ・ このセッションの学習: ${sessionReviews}枚`;
  sheet.appendChild(summary);

  const cont = document.createElement("button");
  cont.className = "primary-btn";
  cont.type = "button";
  cont.textContent = "続ける";
  cont.addEventListener("click", () => backdrop.remove());
  sheet.appendChild(cont);

  backdrop.appendChild(sheet);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
}

/**
 * Best-effort safety net: when the tab is hidden/unloaded and the user studied
 * at least one card, push their reviews with sendBeacon (guaranteed delivery
 * even during unload). Fire-and-forget: never awaited, never in mock mode, never
 * when not logged in, and at most once per hidden transition.
 */
function leaveSync(): void {
  if (leaveSyncFired || syncInFlight) return;
  if (!canSync() || api.isMock()) return;
  if (sessionReviews < 1) return;
  leaveSyncFired = true;
  try {
    navigator.sendBeacon(
      `${api.baseUrl}/api/sync`,
      new Blob([], { type: "application/json" }),
    );
  } catch {
    /* best-effort only — nothing to recover if the beacon can't be queued */
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) leaveSync();
  else leaveSyncFired = false; // re-arm for the next hidden transition
});
window.addEventListener("pagehide", () => leaveSync());

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

  // Detect whole-collection sync availability once (logged in on the Anki
  // engine). Cached in `syncAvailable`; deliberately does NOT auto-pull — the
  // user pulls via the sync panel's "Sync now" if they studied elsewhere.
  void refreshSyncAvailability();
}

void main();

// ---- Import (.apkg) flow ---------------------------------------------------

async function importDeck(
  file: File,
  label: HTMLElement,
  text: HTMLElement,
): Promise<void> {
  const original = text.textContent;
  label.classList.add("import-label--busy");
  text.textContent = "⬆ Importing…";
  try {
    const summary = await api.importApkg(file);
    const deck = summary.decks[0] ?? "your deck";
    showToast(`Imported ${summary.cards} cards into ${deck}`, "success");
    store.setMock(api.isMock());
    // Refetch authoritative decks so the new deck appears; let the user pick it.
    await bootData();
    renderDeckPicker();
  } catch (err) {
    // Surface the server's error message (e.g. 501 IMPORT_UNSUPPORTED, 415).
    const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
    showToast(`Import failed: ${msg}`, "error");
    label.classList.remove("import-label--busy");
    text.textContent = original;
  }
}

// ---- Toast ----------------------------------------------------------------

let toastTimer = 0;

function showToast(
  message: string,
  kind: "success" | "error" | "warning" = "success",
): void {
  let toast = document.querySelector<HTMLElement>(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `toast toast--${kind} toast--show`;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast?.classList.remove("toast--show");
  }, 4200);
}

// Minimal HTML escaping for text interpolated into innerHTML above.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
