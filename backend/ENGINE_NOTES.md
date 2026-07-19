# Verified engine integration notes (tested live on Python 3.14.6, this machine)

## Packages that install & work on py3.14.6
- `anki==26.5`  ✅ (cp310-abi3 wheel; bundled Rust backend loads on 3.14). Pulls protobuf, orjson.
- `fsrs==6.3.1` ✅ (pure python, dep: typing_extensions)
- `genanki==0.13.1` ✅ (for .apkg import/export, optional)

## AnkiLibEngine (PRIMARY) — verified call sequence
```python
from anki.collection import Collection
col = Collection("/path/to/collection.anki2")   # creates if missing
col.set_config("fsrs", True)                      # enable FSRS scheduler (V3)
# add note:
m = col.models.by_name("Basic")
note = col.new_note(m); note["Front"]="犬"; note["Back"]="dog"
col.add_note(note, deck_id=col.decks.id("DeckName"))
# next card:
queued = col.sched.get_queued_cards()            # anki.scheduler.v3
# -> queued.cards[0].card  (a backend card); get_card via col.get_card(cid)
# answer:
card = col.get_card(cid)
card.start_timer()                                # REQUIRED before build_answer
ans = col.sched.build_answer(card=card, states=..., rating=3)  # 1..4
col.sched.answer_card(ans)                         # writes revlog, advances due
```
Notes:
- Collection is SINGLE-WRITER SQLite, NOT thread-safe/async → serialize with app write-lock (matches ARCHITECTURE §2).
- FSRS per-card `memory_state` (stability/difficulty) available after reviews; deck has `desiredRetention`, `fsrsParams6`.
- License: anki is AGPL-3.0 (note in README; our repo wraps it).
- The exact v3 `get_queued_cards()` / `build_answer` shapes vary by version — the AnkiLibEngine implementer must introspect `anki==26.5` in a venv and adapt. Prefer the highest-level scheduler API available.

## FsrsSqliteEngine (FALLBACK) — verified fsrs 6.3.1 API
```python
from fsrs import Scheduler, Card, Rating
sch = Scheduler()                                  # default params/retention
card = Card()                                       # new card
card, review_log = sch.review_card(card, Rating.Good)  # Rating.Again/Hard/Good/Easy
card.due                                             # next due datetime (UTC)
d = card.to_dict();  Card.from_dict(d)              # persist round-trip
```
Rating enum ints line up with Anki: Again=1, Hard=2, Good=3, Easy=4.
Store note fields as JSON + one FSRS state per card + full review_log (ARCHITECTURE §7 srs.sqlite3).

## AnkiConnect (OPTIONAL bridge, not MVP-critical)
HTTP JSON on localhost:8765, requires Anki desktop running. Modern `answerCards` action grades by
cardId+ease without the GUI. Build as an optional adapter only.
