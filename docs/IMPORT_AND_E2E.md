# Import (.apkg) + E2E test — design contract

Extends `docs/ARCHITECTURE.md`. Two features: real Anki-deck import, and a headless-browser E2E test.

## 1. Import contract

### Engine capability (backend/app/srs/base.py — already added)
```python
@dataclass(frozen=True)
class ImportSummary:
    decks: tuple[str, ...]       # deck names that received cards
    notes_imported: int
    cards_imported: int

class ApkgImporter(Protocol):
    def import_apkg(self, apkg_path: str, into_deck: str | None = None) -> ImportSummary: ...
```
Both engines implement it:
- **AnkiLibEngine.import_apkg** — delegate to the real importer:
  `col.import_anki_package(ImportAnkiPackageRequest(...))` (from `anki.import_export_pb2`;
  request wraps `package_path` + `ImportAnkiPackageOptions`). Preserves the package's own deck
  names. Read the returned `ImportLogWithChanges` for counts (fall back to counting new cards).
- **FsrsSqliteEngine.import_apkg** — no Anki runtime; parse the package yourself:
  1. `.apkg` is a zip. Extract the collection DB member: prefer `collection.anki21b` (zstd — try
     `import anki.utils`? no; use the `anki` lib's decompressor is unavailable in fallback, so support
     the common **plain-sqlite** `collection.anki2` / `collection.anki21` first; if only `.anki21b`
     exists and zstd isn't decodable, raise a clear "re-export as legacy .apkg" error).
  2. Open that sqlite read-only. Notes live in `notes.flds` (fields joined by `\x1f`); `col.decks`
     JSON (or the `decks` table in newer schemas) maps deck ids→names; `cards.did` links note→deck.
  3. For each note, map field[0]→Front, field[1]→Back (Basic), and call the engine's own
     `add_note(deck_name_or_into_deck, {"Front":..,"Back":..}, tags=...)`. Count notes/cards/decks.
  Our genanki fixture (`backend/tests/fixtures/jlpt_n5.apkg`, deck `Imported::JLPT N5`, 12 notes) is
  plain sqlite — make that path work end to end.

### REST endpoint (backend/app/main.py)
`POST /api/import` — `multipart/form-data`, field **`file`** = the `.apkg`.
- Reject non-`.apkg`/`.colpkg` or >25 MB → `415`/`413` with the `{"error":{code,message}}` shape.
- Save to a temp path, call `engine.import_apkg(path)` under the coordinator write-lock, delete temp.
- If the active engine lacks import capability → `501 IMPORT_UNSUPPORTED`.
- Response `200`:
```json
{"imported": {"decks": ["Imported::JLPT N5"], "notes": 12, "cards": 12}}
```

### Frontend
Deck picker gains an **"Import .apkg"** file input → `POST /api/import` (FormData) via `api.ts`
`importApkg(file)`. On success, refetch `/api/decks`, toast "Imported N cards", and let the user pick
the new deck. Mock mode: accept the file and fake a summary so the UI flow is demoable offline.

## 2. E2E test (headless browser)

Use **`@playwright/test`** (Chromium) under `frontend/e2e/`. `npx playwright install chromium` first.
A global setup starts the **real backend** (uvicorn, `DOPAMINE_SRS_ENGINE=fsrs`, throwaway
`DOPAMINE_DATA_DIR`) and the **Vite dev server**, then runs specs against `http://localhost:5173`:

- `feed.spec.ts` — seed demo → first card renders → reveal (Space/tap) → grade Good → **reward overlay
  appears** and **HUD XP increases** → next card promotes. Grade an `Again` and assert **combo resets**.
- `import.spec.ts` — open import, upload `backend/tests/fixtures/jlpt_n5.apkg`, assert the toast/among
  `/api/decks` the `Imported::JLPT N5` deck appears with 12 cards, then study one imported card.
- Assert reload persists state (version/XP) via a fresh page load.

Keep it deterministic: disable animations via `prefers-reduced-motion` / a `?e2e=1` flag if needed;
wait on real DOM/network, not timeouts. Tests must pass headless in CI-style `npx playwright test`.

## Task split
- **Codex:** FsrsSqliteEngine.import_apkg (zip+sqlite parser) + `backend/tests/test_import_fsrs.py`.
- **Claude (anki+api):** AnkiLibEngine.import_apkg + `POST /api/import` + `backend/tests/test_import_api.py`.
- **Claude (frontend+e2e):** import UI + `api.ts` + Playwright harness & specs.
