You are Codex on the DopaMine team. Add two capabilities to the FSRS-fallback importer: (A) zstd `.anki21b`
support and (B) note-type template rendering (multi-field + cloze). You own backend/app/srs/fsrs_sqlite.py.

READ FIRST: docs/IMPORT_AND_E2E.md, backend/app/srs/fsrs_sqlite.py (your existing import_apkg + _apkg_deck_names).
Venv python: ./.venv/bin/python (has zstandard==0.25.0, anki==26.5 for cross-checking).

VERIFIED FACTS (established live):
- Anki packs BOTH a modern and a legacy collection in a package. A modern export (legacy=False) contains
  members: `meta`, `collection.anki21b` (REAL data, zstd-compressed sqlite), `collection.anki2` (a STUB whose
  only note says "Please update to the latest Anki version, then import the .colpkg/.apkg file."), and `media`.
  A legacy export contains `collection.anki21` (real) + `collection.anki2` (real) + `media`.
- So the parser MUST prefer the newest real collection. Current code prefers `.anki21` then `.anki2` — that reads
  the STUB for modern packages. New member preference order: **`collection.anki21b` (zstd) > `collection.anki21`
  (plain) > `collection.anki2` (plain)**.
- Fixtures (real, anki-generated): backend/tests/fixtures/modern_zstd.apkg (zstd; decks Modern::Basic + Default
  stub — note the anki2 stub is a separate deck), backend/tests/fixtures/rich_legacy.apkg (plain sqlite; decks
  Modern::Basic 5 Basic notes, Rich::Vocab 3 notes of a custom 4-field "Vocab" notetype, Rich::Cloze 2 Cloze
  notes), and the original jlpt_n5.apkg (legacy Basic, 12 notes).

TASK A — zstd `.anki21b`:
- Update the zip-member selection to the preference order above. If `.anki21b` is chosen, zstd-decompress it to a
  temp sqlite before opening. Use `zstandard`: `dctx = zstandard.ZstdDecompressor(); dctx.stream_reader(fh)` copied
  to a temp file (robust to frames / missing content-size). Add `zstandard` to backend/pyproject.toml deps.
- After this, importing modern_zstd.apkg must read the REAL collection (Modern::Basic 犬/dog etc.), NOT the stub.
  (The stub `Default` deck note will no longer be the source; make sure real notes import.)

TASK B — note-type template rendering (replace the hard field0->Front / field1->Back mapping):
- Read note types (models) from the collection, supporting BOTH schema styles:
  * Legacy: JSON in the `col` table's `models` column (dict keyed by model id). Each model has `id`, `name`,
    `type` (0=standard, 1=cloze), `flds` (ordered list of {name,ord}), `tmpls` (list of {name,qfmt,afmt,ord}).
  * Modern (if a modern-only sqlite ever lacks `col.models`): `notetypes`, `fields`, `templates` tables. Handle if
    present; fall back to `col.models` JSON otherwise. (Our fixtures carry `col.models` JSON — make that work first.)
- For each note (notes.mid -> model, notes.flds split on \x1f -> ordered field values by the model's flds order),
  render a (front_html, back_html) pair:
  * STANDARD notetype: use the FIRST template (tmpls[0]). Render qfmt and afmt by substituting `{{FieldName}}` with
    the field value. Support `{{FrontSide}}` in afmt = the rendered qfmt. Support simple section conditionals
    `{{#Field}}...{{/Field}}` (include body iff field non-empty) and `{{^Field}}...{{/Field}}` (iff empty). Strip any
    remaining `{{...}}` you don't understand (e.g. `{{tts}}`, `{{hint:..}}`) rather than leaking braces. Do NOT
    execute JS or fetch media; leave `<img>` tags as-is (media is out of scope — document that).
  * CLOZE notetype (type==1): the cloze field (the field referenced by `{{cloze:Field}}`, usually "Text") contains
    `{{c1::answer::hint}}` spans. Render ONE card per note: FRONT = the text with every cloze deletion replaced by
    `[...]` (or the hint if present, as `[hint]`), BACK = the text with deletions revealed and wrapped in a
    `<span class="cloze">answer</span>`. Append the "Back Extra" field (if the model has it and it's non-empty) to
    the back. This is a pragmatic single-card rendering (Anki normally makes one card per cloze ordinal); document it.
- Preserve deck names as before (via _apkg_deck_names, already merges both sources). Call self.add_note(deck,
  {"Front": front_html, "Back": back_html}, tags=...) so the RENDERED html is stored and shown by next_card.
- Keep it defensive: notes with fewer fields than expected, empty templates, or unknown models must not crash —
  fall back to field0/field1 and continue.

TESTS — backend/tests/test_import_rich.py:
- Import modern_zstd.apkg into a fresh engine: assert a Modern::Basic card renders 犬 / dog (proves zstd real-data path,
  not the stub).
- Import rich_legacy.apkg: assert Rich::Vocab card's back contains the Meaning ("to eat") AND Example ("パンを食べる")
  — i.e. multi-field template rendered, not just Word/Reading. Assert Rich::Cloze FRONT contains "[...]" and NOT the
  raw "{{c1::" markup, and BACK reveals "Tokyo". Assert notes_imported counts are right.
- Keep the existing test_import_fsrs.py passing (jlpt_n5 legacy Basic still imports 12 and renders 犬/dog).

RUN: ./.venv/bin/python -m pytest backend/tests/test_import_rich.py backend/tests/test_import_fsrs.py -q  then the FULL suite backend/tests/ -q. Fix until all green.
Do NOT touch anki_lib.py, main.py, rewards.py, base.py, or frontend/*. Only fsrs_sqlite.py, pyproject.toml, and the new test.
Report: member-selection order, how you render cloze, and final pytest output.
