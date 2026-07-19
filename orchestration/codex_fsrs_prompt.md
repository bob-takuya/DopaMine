You are Codex on the DopaMine team. base.py (the AnkiEngine protocol) and rewards.py are DONE and tested.
Now implement your owned task: the FsrsSqliteEngine fallback.

READ FIRST:
- docs/ARCHITECTURE.md §3 (engine boundary), §7 (srs.sqlite3 schema)
- backend/ENGINE_NOTES.md (VERIFIED fsrs 6.3.1 API — use exactly this)
- backend/app/srs/base.py (the Protocol you must satisfy: CardView, AnswerResult, DeckInfo, SrsStats, Rating)

Use the project venv Python at ~/anki-addiction/.venv/bin/python (has fsrs==6.3.1, pytest).

Implement backend/app/srs/fsrs_sqlite.py:
- class FsrsSqliteEngine implementing AnkiEngine (structurally), backed by its own SQLite file `srs.sqlite3`
  under a data dir passed to __init__(db_path). Create schema on init: tables notes(note_id, model, fields_json,
  tags, deck), cards(card_id, note_id, deck, fsrs_json, due_at, reps), review_log(id, card_id, rating, answered_at, elapsed_json).
- next_card(deck): return the currently-due card with the earliest due_at (<= now UTC), filtered by deck if given,
  as a CardView (render front_html/back_html from note fields — Basic model Front/Back). Return None if nothing due.
- answer_card(card_id, rating): load the card's fsrs state (fsrs.Card.from_dict), call
  Scheduler().review_card(card, Rating(rating)), persist updated fsrs_json + due_at + append review_log,
  return AnswerResult(card_id, rating, answered_at=now, next_due_at=card.due, interval_days=(due-now).days as float).
  Raise KeyError/ValueError for unknown or non-answerable card.
- add_note(deck, fields, tags, model="Basic"): insert note + one new fresh Card() (fsrs), due now so it's immediately
  studyable; return created card_ids (list[str]).
- deck_list(): DeckInfo per distinct deck with due_count (due_at<=now) and total_count.
- stats(deck): SrsStats(due_now, reviewed_today from review_log by local date UTC, total_cards, retention=None for MVP).
- Use timezone-aware UTC datetimes everywhere. IDs are opaque strings (use uuid4 hex or a monotonic counter — but
  do NOT call wall clock for IDs in a way that breaks; uuid4 is fine here since this is runtime, not the pure reward fn).
- Single-writer: fine to open sqlite3 connections per call with check_same_thread handling.

Also add a demo-seed helper method seed_demo(deck, notes: list[tuple[str,str]]) used later by the API, idempotent by
a stored marker row.

Write backend/tests/test_fsrs_engine.py: create an engine on a tmp sqlite, add_note x3, assert next_card returns one,
answer it Good, assert next_due_at is in the future and interval_days>=0, assert reviewed_today increments, assert
unknown card_id raises. Round-trip persistence: reopen engine on same db, state survives.

RUN: ~/anki-addiction/.venv/bin/python -m pytest backend/tests/test_fsrs_engine.py -q
Fix until green. Do NOT touch base.py, rewards.py, or any frontend/anki_lib file. Report final pytest output.
