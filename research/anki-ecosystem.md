# Anki Ecosystem Integration Research

**For:** Project "DopaMine" — wrapping Anki's real SRS engine under a dopamine-driven UI.
**Question:** Best way to programmatically serve cards + record real spaced-repetition reviews while staying Anki-compatible.
**Test machine:** macOS (Darwin 24.5, arm64), **Python 3.14.6**, Node 22.17. Anki desktop **not** installed.
**Date:** 2026-07-19.

---

## TL;DR

- **All four candidate pip packages install AND run end-to-end on Python 3.14.6** in a clean venv. This is the key finding — the modern `anki` library ships an `abi3` wheel (`cp310-abi3`) so its Rust backend loads on 3.14 with no build step and no Anki desktop.
- **Recommended path: use the official `anki` library** (v26.5) as the MVP engine. It gives us the *real* Collection, the *real* V3 scheduler, and *real* FSRS with memory state — fully Anki-compatible, no desktop required.
- `py-fsrs` (`fsrs` 6.3.1) is a clean, dependency-light fallback / auxiliary engine.
- `genanki` 0.13.1 covers `.apkg` creation/import portability.
- **AnkiConnect** is an *optional bridge* for users who already run Anki desktop and want live two-way sync; it is not needed for the self-contained MVP.

---

## What actually installed & ran on THIS machine (Python 3.14.6)

Two isolated venvs under `~/anki-addiction/temp/`.

### `venv_anki` — `pip install anki`  ✅
```
anki==26.5            <- cp310-abi3 wheel, macosx_12_0_arm64, 9.8 MB (bundles Rust backend)
protobuf==7.35.1
orjson==3.11.9
requests==2.34.2  markdown==3.10.2  decorator==5.3.1
+ certifi charset-normalizer idna urllib3 PySocks typing_extensions
```
- `anki` 26.5 released 2026-06-16. Metadata: **Requires-Python >=3.10**, wheels tagged **`cp310-abi3`** → forward-compatible with 3.11/3.12/3.13/**3.14**. AGPL-3.0-or-later. Wheels only (no sdist) for Win/Linux/macOS x86-64 + arm64.
- **Verified end-to-end** (`temp/test_anki.py`): opened a fresh collection, added a Basic note, pulled the next due card from the V3 queue, answered "Good", and read the updated schedule + revlog. Output:
  ```
  scheduler version reported: 2      # sched_ver()==2 → V3 scheduler backend active
  sched2021(v3) config: True
  sched class: anki.scheduler.v3.Scheduler
  BEFORE: due=1 ivl=0 queue=0 type=0 reps=0
  AFTER Good(3): due=5 ivl=5 queue=2 type=2 reps=1
  revlog entries: 1                  # a real review-log row was written
  ```
- **FSRS verified inside anki** (`temp/test_anki_fsrs.py`): `col.set_config("fsrs", True)` then answering "Good" produced `ivl=10` and `card.memory_state = stability:8.29 difficulty:1`. Deck config exposes `desiredRetention` (0.9), `fsrsParams6`, `fsrsWeights`, `sm2Retention`.

### `venv_fsrs` — `pip install fsrs` and `pip install genanki`  ✅
```
fsrs==6.3.1           <- pure-python (py3-none-any), only dep: typing_extensions
genanki==0.13.1       <- + chevron pyyaml frozendict cached-property
```
- `fsrs` 6.3.1 released 2026-03-10, Requires-Python >=3.10, zero heavy deps. **Verified** (`temp/test_fsrs.py`): `Scheduler().review_card(Card(), Rating.Good)` → next due +10m, stability 2.307, difficulty 2.118; `Card.to_dict()/from_dict()` round-trips cleanly for persistence.
- `genanki` 0.13.1 **verified** (`temp/test_genanki.py`): wrote a valid 53 KB `.apkg` (zip containing `collection.anki2` + `media`).

> Bottom line: **nothing had to be compiled and Anki desktop was never involved.** The abi3 wheel is why `anki` works on a Python version (3.14) that postdates the package.

---

## Path 1 — Official `anki` Python library  ⭐ (recommended engine)

The `anki` package is the exact backend the Anki desktop app and all add-ons use: a thin Python layer (`anki/`) over a Rust core (`rslib`) communicating via protobuf. Installing it gives us the real scheduler, not a reimplementation — so anything we do is byte-for-byte Anki-compatible and syncs to AnkiWeb.

**Install (works on py3.14):**
```bash
pip install anki           # headless library only
# pip install aqt          # ONLY if you also want the Qt desktop GUI — we do NOT
```

**What it exposes (all confirmed present on 26.5):**
- `anki.collection.Collection(path)` — opens/creates a `.anki2` SQLite collection. All state lives here.
- `col.sched` — the scheduler. On a fresh 26.5 collection this is **`anki.scheduler.v3.Scheduler`** (the V3/2021 scheduler, `sched_ver()==2`), which is the FSRS-capable engine.
- Card serving: `col.sched.get_queued_cards()` → next due card(s) with per-button next-state previews (`qc.states`); `col.get_card(id)`.
- Answering (grade a review): `ca = col.sched.build_answer(card=card, states=qc.states, rating=R)` then `col.sched.answer_card(ca)`. `rating`: **1=Again, 2=Hard, 3=Good, 4=Easy**. This writes the revlog and advances scheduling exactly as the desktop would. (Legacy `col.sched.answerCard(card, ease)` also exists.)
- Notes/decks: `col.models.by_name("Basic")`, `col.new_note(m)`, `col.add_note(note, deck_id)`, `col.decks`, deck config via `col.decks.config_dict_for_deck_id(did)`.
- FSRS: global toggle `col.set_config("fsrs", True)`; per-deck `desiredRetention`, `fsrsParams6`; per-card `card.memory_state` (stability/difficulty). Optimizer: `col.compute_fsrs_params(...)`.
- Review logs: the `revlog` table (id, cid, ease, ivl, lastIvl, factor, time, type) readable via `col.db`.
- Import/export: `col.import_anki_package(...)` / `col.export_anki_package(...)` for `.apkg`/`.colpkg`.

**Minimal code sketch (open→add→serve→answer→read due):**
```python
from anki.collection import Collection

col = Collection("/path/to/collection.anki2")   # creates if missing
col.set_config("fsrs", True)                     # opt into modern FSRS scheduling

# add a note
m = col.models.by_name("Basic")
note = col.new_note(m)
note["Front"], note["Back"] = "capital of France?", "Paris"
col.add_note(note, deck_id=1)                    # 1 = Default deck

# serve the next due card
queued = col.sched.get_queued_cards()
qc = queued.cards[0]
card = col.get_card(qc.card.id)
card.start_timer()                               # REQUIRED before build_answer (sets timer_started)

# answer it: 1=Again 2=Hard 3=Good 4=Easy
answer = col.sched.build_answer(card=card, states=qc.states, rating=3)
col.sched.answer_card(answer)                    # writes revlog + reschedules

card.load()
print(card.due, card.ivl, card.memory_state)     # updated schedule + FSRS memory state
col.close()                                       # ALWAYS close (flushes + releases the SQLite lock)
```

**Gotchas we hit (document for backend impl):**
1. `card.start_timer()` **must** be called before `build_answer`, or `build_answer` throws `TypeError: unsupported operand … 'float' and 'NoneType'` because `card.time_taken()` dereferences an unset `timer_started`. Our FastAPI wrapper should call `start_timer()` the moment it serves a card.
2. The collection holds an **exclusive SQLite lock** — only one process may have it open. FastAPI must own a single long-lived `Collection` (or a serialized access layer), not open-per-request. Call `col.close()` on shutdown.
3. `Collection` is **not** async and not thread-safe; wrap calls behind a lock / run in a threadpool executor.
4. Licence is **AGPL-3.0** — linking our backend to `anki` makes the backend subject to AGPL. Fine for an open MVP; flag it if the product ever needs a non-copyleft licence (that's the main reason to prefer the `fsrs`-only path).

**Pros:** real Anki scheduler + FSRS, zero reimplementation risk, opens/writes genuine `.anki2` collections, syncs to AnkiWeb, no desktop needed, installs on 3.14 today.
**Cons:** AGPL; heavier (Rust backend, ~10 MB wheel + protobuf); single-writer SQLite; API is under-documented and versioned to the app (pin the version).

---

## Path 2 — AnkiConnect (optional companion bridge)

Add-on that runs an HTTP JSON server on **`http://127.0.0.1:8765`** inside a **running Anki desktop**. Request shape: `POST {"action": <str>, "version": 6, "params": {...}}` → `{"result": ..., "error": null}`.

**Key actions for us:**
- Read/serve: `deckNames`, `deckNamesAndIds`, `findCards` (query like `deck:Default is:due`), `cardsInfo`, `notesInfo`, `getNextCards`/`guiCurrentCard` (currently-shown card).
- Create: `addNote` / `addNotes`, `createDeck`.
- Grade reviews **without the GUI**: **`answerCards`** — `{"answers":[{"cardId":<id>,"ease":1-4}]}` (modern versions) answers cards directly through the scheduler and writes the revlog.
- Grade via the review screen: `guiAnswerCard {"ease":1-4}` (must have `guiShowQuestion`/`guiShowAnswer` state); `guiDeckReview` to start reviewing.

**Pros:** trivial HTTP; two-way live integration with the user's *existing* running collection; great for a "companion app" that decorates the desktop.
**Cons:** **requires Anki desktop open** (violates the MVP's "don't require desktop" goal); localhost-only; you inherit whatever scheduler the desktop is configured with; not headless/CI-friendly. → Best as an **optional adapter**, not the core.

---

## Path 3 — `.apkg` / `.colpkg` + `genanki` / raw SQLite (portability layer)

- **`.apkg`/`.colpkg`** are zip files bundling a `collection.anki2` (SQLite) + a `media` map. This is the universal Anki interchange format.
- **`genanki`** (0.13.1, verified on 3.14): pure-python **creation** of `.apkg` decks — define `Model`, `Deck`, `Note`, `Package(...).write_to_file()`. Use it to **seed the demo deck** and to **export** user progress as a shareable/importable file. It does *not* schedule or read existing collections.
- **Reading an existing collection:** either `col.import_anki_package()` via the `anki` lib (preferred — handles schema versions), or open `collection.anki2` directly with `sqlite3` for read-only queries (`cards`, `notes`, `revlog`, `col`). Direct-writing the SQLite for scheduling is **not recommended** (you'd be reimplementing the scheduler and can corrupt the collection).

**Pros:** portability, import/export, demo-deck seeding, no dependencies for creation.
**Cons:** not a scheduler; format/schema drift between Anki versions; hand-writing SQLite scheduling is fragile. → **Use for import/export/seed only.**

---

## Path 4 — Standalone FSRS (`fsrs` / py-fsrs)

`pip install fsrs` (v6.3.1, verified on 3.14) — a **self-contained FSRS-6 scheduler** with no Anki dependency. Ideal if we ever want our own lightweight engine + our own SQLite schema (avoids AGPL, avoids the Rust backend).

**Minimal code sketch:**
```python
from datetime import datetime, timezone
from fsrs import Scheduler, Card, Rating

scheduler = Scheduler(desired_retention=0.9)     # also: learning_steps, maximum_interval, enable_fuzzing
card = Card()                                     # new card (state=Learning)

now = datetime.now(timezone.utc)
card, review_log = scheduler.review_card(card, Rating.Good, review_datetime=now)
#   Rating: Again=1  Hard=2  Good=3  Easy=4   (same integers as Anki ease buttons)

print(card.due)                                   # next review datetime (tz-aware UTC)
print(card.stability, card.difficulty, card.state)
print(card.due - now)                             # interval until next review

# persistence (we own the storage):
blob = card.to_dict()                             # JSON-safe; Card.from_dict(blob) restores
# optimize params later from accumulated ReviewLogs:  Scheduler.optimizer / fsrs[optimizer]
```

**Pros:** tiny (one dep), MIT-friendly (not AGPL), pure-python, trivial to embed, exact same FSRS algorithm family as Anki, we control the DB schema. Same 1-4 rating semantics as Anki so mapping is 1:1.
**Cons:** **not** an Anki collection — cards/reviews live in *our* store, so "Anki-compatible" only holds if we also export to `.apkg` (via genanki) or mirror into an `anki` collection. Reimplements the storage/queue that `anki` gives for free. Parameters differ subtly from a given user's optimized Anki params unless we import them.

---

## Comparison

| Path | Real Anki scheduler | Needs desktop | Headless/MVP | py3.14 verified | Anki-compatible store | Licence | Role |
|---|---|---|---|---|---|---|---|
| **`anki` lib** | ✅ V3 + FSRS | ❌ | ✅ | ✅ e2e | ✅ native `.anki2` | AGPL-3.0 | **Core engine** |
| AnkiConnect | ✅ (desktop's) | ✅ | ❌ | n/a (needs app) | ✅ | add-on | Optional bridge |
| genanki / SQLite | ❌ | ❌ | ✅ | ✅ | ✅ (import/export) | MIT | Seed/import/export |
| `fsrs` | ✅ FSRS-6 (own) | ❌ | ✅ | ✅ e2e | ❌ (our store) | MIT | Fallback engine |

---

## RECOMMENDED INTEGRATION

**Primary: build the MVP on the official `anki` library (v26.5).** It installs cleanly and runs the full serve→grade→reschedule loop on this machine's Python 3.14.6 with no desktop and no compilation, using the *real* V3 scheduler and *real* FSRS (with per-card memory state). That directly satisfies the brief's non-negotiables ("wrap don't replace", "every review is a real SRS review", "Anki-compatible cards/logs/scheduling"), and collections it writes sync to AnkiWeb.

Concretely for `backend/`:
1. FastAPI owns **one long-lived `Collection`** behind an async lock (single-writer SQLite). Enable FSRS (`col.set_config("fsrs", True)`).
2. `GET /next-card` → `get_queued_cards()`, `col.get_card(id)`, **call `card.start_timer()`**, render fields to the feed.
3. `POST /answer {card_id, rating 1-4}` → `build_answer(...)` + `answer_card(...)`; return new due/ivl/memory_state for the gamification engine to theme (the reward overlay reads SRS outcome but never mutates it).
4. Seed the demo deck with **`genanki`** (or `col.import_anki_package` an `.apkg`); export progress the same way.
5. Ship an **AnkiConnect adapter** (`answerCards`/`findCards` over `:8765`) behind the same backend interface as an *optional* mode for users who prefer to keep their desktop as the source of truth.

**Fallback (only if AGPL or the Rust dependency becomes a blocker):** swap the engine for **`fsrs` (py-fsrs) + our own SQLite**, keeping the identical 1-4 rating API, and use `genanki` to stay `.apkg`-interoperable. The hypothesis in the brief holds, but note the fallback is *not* needed on technical grounds — `anki` installs and works on 3.14 today; the only reason to fall back is licensing/footprint.

**Pin versions** in `backend/requirements.txt`: `anki==26.5`, `fsrs==6.3.1`, `genanki==0.13.1` (all confirmed working here on 3.14.6).

---

### Reproduction artifacts (in `temp/`, gitignore-able)
- `temp/venv_anki/`, `temp/venv_fsrs/` — the two test venvs.
- `temp/test_anki.py`, `temp/test_anki_fsrs.py`, `temp/test_fsrs.py`, `temp/test_genanki.py` — the verification scripts (all pass).

### Sources
- [anki on PyPI](https://pypi.org/project/anki/) · [The 'anki' Module — add-on docs](https://addon-docs.ankiweb.net/the-anki-module.html) · [anki dev docs](https://github.com/ankitects/anki/blob/main/docs/development.md)
- [fsrs (py-fsrs) on PyPI](https://pypi.org/project/fsrs/) · [open-spaced-repetition/py-fsrs](https://github.com/open-spaced-repetition/py-fsrs)
- [genanki](https://github.com/kerrickstaley/genanki)
- [AnkiConnect (amikey mirror README)](https://github.com/amikey/anki-connect) · [Anki-Connect-Plus supported actions](https://github.com/Soki-Team/Anki-Connect-Plus/blob/main/SUPPORTED_ACTIONS.md)
