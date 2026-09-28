You are Codex on the DopaMine team. Add MEDIA extraction and NOTE-TYPE CSS to the FSRS fallback engine.
You own backend/app/srs/fsrs_sqlite.py (its schema) + a new test. Do NOT touch base.py, anki_lib.py, main.py, frontend/*.

READ FIRST: backend/app/srs/base.py — note the NEW `CardView.css: str = ""` field and the `MediaProvider`
Protocol (`open_media(self, name: str) -> bytes | None`) you must implement. Also backend/app/srs/fsrs_sqlite.py
(your existing import_apkg, _render_apkg_note, _apkg_models, schema).

Venv python: ./.venv/bin/python (has zstandard, anki for cross-check).
Fixtures: backend/tests/fixtures/media_css.apkg (genanki: model "StyledImg" WITH css, deck "Media::Styled",
2 notes referencing <img src="dot.png">, media map {"0":"dot.png"}, member layout: collection.anki2 + media + "0").
Also the earlier fixtures still exist (jlpt_n5, rich_legacy, modern_zstd).

TASK 1 — MEDIA extraction + open_media:
- The engine gets a media directory next to its DB: `self._media_dir = self.db_path.parent / "media"` (create lazily).
- During import_apkg, extract the package's media into that dir under ORIGINAL filenames:
  * The `media` zip member maps stored-number -> original name. LEGACY packages: `media` is JSON like {"0":"dot.png"}
    and the numbered files ("0","1",...) are raw bytes. MODERN (.anki21b) packages: `media` is a protobuf
    (anki.import_export_pb2.MediaEntries) and each numbered media file is zstd-compressed. Handle BOTH:
    try `json.loads(media_bytes)` first; on failure, parse with `from anki.import_export_pb2 import MediaEntries`
    (best-effort; if that import/parse fails just skip media). For modern, zstd-decompress each numbered file.
  * Write each file to `self._media_dir / <original_name>` but SANITIZE: use only the basename, reject names
    containing path separators or "..". Don't overwrite across imports destructively is fine (last wins).
- Implement `open_media(self, name: str) -> bytes | None`: resolve `self._media_dir / basename(name)`, reject
  traversal (the resolved path must be inside _media_dir), return bytes or None if missing. This satisfies MediaProvider.
- Do NOT rewrite media URLs in the stored HTML — leave `<img src="dot.png">` with the original name; the API layer
  rewrites to /api/media/<name>. (Just make sure the file is extracted so the API can serve it.)

TASK 2 — NOTE-TYPE CSS:
- Note types carry a `css` string (legacy: model["css"] in col.models JSON; modern: notetypes.config protobuf has
  a `css` field — reuse your existing _apkg_models modern path, add css there too). Extend _apkg_models so each model
  dict includes "css".
- Persist css so next_card can return it. Add a `css TEXT NOT NULL DEFAULT ''` column to the `notes` table (extend
  _SCHEMA; also ALTER TABLE ADD COLUMN guarded for existing DBs). Extend add_note with an optional `css: str = ""`
  param that stores it. In import_apkg, pass the rendered note's model css to add_note.
- Update next_card to SELECT n.css and return it as CardView(..., css=<css>). (Basic/demo notes: css="" is fine.)

TESTS — backend/tests/test_import_media_css.py:
- Import media_css.apkg into a fresh engine (fresh tmp dir). Assert open_media("dot.png") returns bytes starting with
  the PNG signature b"\x89PNG". Assert open_media("../secret") and open_media("nope.png") return None.
- Assert next_card(deck="Media::Styled").css contains ".word" and "background" (the model css came through), and its
  front_html still contains `<img src="dot.png">` (original name, unrewritten) and the rendered `<div class="word">ねこ`.
- Keep every existing test passing (Basic notes get css="").

RUN: ./.venv/bin/python -m pytest backend/tests/test_import_media_css.py backend/tests/test_import_rich.py backend/tests/test_import_fsrs.py -q  then FULL backend/tests/ -q. Fix until green.
Report: how you handled legacy vs modern media, the css source, and final pytest output.
