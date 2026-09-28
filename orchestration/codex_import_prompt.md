You are Codex on the DopaMine team. Implement your owned task: `.apkg` import for the FsrsSqliteEngine fallback.

READ FIRST:
- docs/IMPORT_AND_E2E.md (the import contract — section 1)
- backend/app/srs/base.py — the NEW `ImportSummary` dataclass and `ApkgImporter` Protocol you must satisfy.
- backend/app/srs/fsrs_sqlite.py — your existing engine; reuse its `add_note(...)`.

Use venv python: ./.venv/bin/python

There is a real fixture at backend/tests/fixtures/jlpt_n5.apkg (genanki-made: a zip with a PLAIN sqlite
`collection.anki2` + a `media` file; deck `Imported::JLPT N5`; 12 Basic notes like 犬/dog).

Implement `FsrsSqliteEngine.import_apkg(self, apkg_path: str, into_deck: str | None = None) -> ImportSummary`:
1. Open the .apkg as a zip. Find the collection member: prefer `collection.anki21`, else `collection.anki2`
   (both plain sqlite). If only `collection.anki21b` exists (zstd-compressed, used by modern Anki), raise a
   clear ValueError telling the user to re-export as a legacy `.apkg` — do NOT attempt zstd in the fallback.
2. Extract it to a temp file and open with sqlite3 (read-only). Read the deck-id→name map: newer schemas have
   a `decks` table (id, name); older ones store decks as JSON in the `col` table's `decks` column. Handle BOTH.
3. For each row in `notes`, split `flds` on '\x1f'. Map field0→Front, field1→Back. Determine the note's deck via
   its card(s) in `cards` (cards.nid=notes.id, cards.did→deck name); if unresolved, use `into_deck` or 'Imported'.
   Preserve original deck names when available (use `into_deck` only as override/fallback).
4. Call self.add_note(deck_name, {"Front":..,"Back":..}, tags=<note tags split on space>) for each — reuse your
   existing engine so imported cards become immediately studyable with fresh FSRS state.
5. Return ImportSummary(decks=tuple(sorted unique deck names), notes_imported=N, cards_imported=M).
   Clean up temp files. Be robust to notes with only one field.

Write backend/tests/test_import_fsrs.py: import the fixture into a fresh engine (tmp sqlite), assert
notes_imported==12, 'Imported::JLPT N5' in decks, then next_card(deck='Imported::JLPT N5') returns an imported
card and it can be answered. Also test the into_deck override path and that a bogus/non-zip file raises cleanly.

RUN: ./.venv/bin/python -m pytest backend/tests/test_import_fsrs.py -q  and fix until green.
Do NOT touch base.py, anki_lib.py, main.py, or frontend/*. Only edit fsrs_sqlite.py and add the test.
Report the final pytest output and the deck/note counts you observed.
