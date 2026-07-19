"""PRIMARY SRS engine: ``AnkiLibEngine`` wraps the real ``anki`` library.

This adapter opens a user's real ``collection.anki2``, enables the FSRS
scheduler (Anki scheduler v3), and delegates every scheduling decision to
Anki itself. Ratings, due dates, and intervals are Anki's own — this module
only translates between Anki's protobuf/backend shapes and the neutral
dataclasses defined in ``base.py``.

Verified against ``anki==26.5`` (cp310-abi3 wheel, running on CPython 3.14.6).
Anki desktop is NOT required and must not be running.

License
-------
The ``anki`` package is licensed **AGPL-3.0**. This module links against it at
runtime; any distribution of DopaMine that bundles ``anki`` must comply with
AGPL-3.0 (source availability, license notice, etc.).

Threading / concurrency
-----------------------
An Anki ``Collection`` is a single-writer, SQLite-backed object. It is NOT
thread-safe and NOT async-safe. This class deliberately adds **no** locking of
its own: callers MUST serialize all access through the application's single
process-level write lock (see ARCHITECTURE.md §2). Do not share one instance
across threads without external mutual exclusion.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping, Sequence

import anki.import_export_pb2 as import_export_pb2
from anki.collection import Collection
from anki.consts import (
    QUEUE_TYPE_DAY_LEARN_RELEARN,
    QUEUE_TYPE_LRN,
    QUEUE_TYPE_REV,
)
from anki.errors import NotFoundError
from anki.scheduler_pb2 import CardAnswer

from .base import AnswerResult, CardView, DeckInfo, ImportSummary, Rating, SrsStats

_SECS_PER_DAY = 86_400

# DopaMine ratings are Literal[1,2,3,4] = Again, Hard, Good, Easy.
# Anki's protobuf CardAnswer.Rating enum is 0-indexed (AGAIN=0 .. EASY=3), so
# the two scales are offset by one. Getting this mapping wrong silently grades
# the wrong button (e.g. our Good would be applied as Anki Easy) — this table is
# the single source of truth for the translation.
_RATING_TO_PROTO: dict[int, int] = {
    1: CardAnswer.AGAIN,
    2: CardAnswer.HARD,
    3: CardAnswer.GOOD,
    4: CardAnswer.EASY,
}

# Anki revlog "type" 4 is a manual reschedule / no-op, not a real study review.
_REVLOG_TYPE_MANUAL = 4


class AnkiLibEngine:
    """``AnkiEngine`` implementation backed by the real ``anki`` scheduler.

    Satisfies the ``AnkiEngine`` protocol in :mod:`backend.app.srs.base`.
    """

    def __init__(self, collection_path: str) -> None:
        path = Path(collection_path).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)
        # Collection() creates the .anki2 file if it does not exist.
        self.col = Collection(str(path))
        # Enable the FSRS scheduler (scheduler v3). Idempotent; only write when
        # needed so we don't churn the collection on every open.
        if not self.col.get_config("fsrs", False):
            self.col.set_config("fsrs", True)

    def close(self) -> None:
        """Close the underlying collection (releases the SQLite file lock)."""
        self.col.close()

    def __enter__(self) -> "AnkiLibEngine":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ------------------------------------------------------------------ #
    # internal helpers
    # ------------------------------------------------------------------ #
    def _due_at(self, card) -> datetime | None:
        """Best-effort UTC datetime for a card's scheduled due time.

        Anki overloads ``card.due`` depending on the queue:
        * intraday learning (queue 1): ``due`` is a unix epoch (seconds);
        * review / day-learning (queue 2, 3): ``due`` is a *day number*
          counted from ``col.crt`` (the collection's rollover-aligned epoch);
        * new / suspended / buried: no meaningful scheduled time -> ``None``.
        """
        q = card.queue
        if q == QUEUE_TYPE_LRN:
            return datetime.fromtimestamp(card.due, tz=timezone.utc)
        if q in (QUEUE_TYPE_REV, QUEUE_TYPE_DAY_LEARN_RELEARN):
            secs = self.col.crt + card.due * _SECS_PER_DAY
            return datetime.fromtimestamp(secs, tz=timezone.utc)
        return None

    def _card_view(self, card) -> CardView:
        note = card.note()
        return CardView(
            card_id=str(card.id),
            note_id=str(note.id),
            deck=self.col.decks.name(card.did),
            # card.question()/answer() render the full Anki HTML (with the note
            # type's <style>), which is exactly what the feed shows.
            front_html=card.question(),
            back_html=card.answer(),
            tags=tuple(note.tags),
            due_at=self._due_at(card),
        )

    def _next_card_for_deck(self, deck_id: int):
        """Return the top scheduler card for ``deck_id`` (and its subdecks), or None.

        ``get_queued_cards`` respects the *currently selected* deck, so we select
        the target deck first. This mirrors how the Anki reviewer picks a card.
        """
        self.col.decks.set_current(deck_id)
        queued = self.col.sched.get_queued_cards(fetch_limit=1)
        if not queued.cards:
            return None
        return self.col.get_card(queued.cards[0].card.id)

    @staticmethod
    def _priority_key(card) -> float:
        """Sort key for choosing the most urgent card across decks.

        Cards with a concrete due time sort by that time; new cards (no due
        time) sort last so any actually-due card wins.
        """
        q = card.queue
        if q == QUEUE_TYPE_LRN:
            return float(card.due)
        if q in (QUEUE_TYPE_REV, QUEUE_TYPE_DAY_LEARN_RELEARN):
            # Compare on the same absolute-epoch scale as learning cards.
            return float(card.due) * _SECS_PER_DAY  # crt offset is constant, ok for ordering
        return float("inf")

    def _real_decks(self):
        """Yield (deck_id, name) for real (non-filtered) decks."""
        for entry in self.col.decks.all_names_and_ids(include_filtered=False):
            yield entry.id, entry.name

    # ------------------------------------------------------------------ #
    # AnkiEngine protocol
    # ------------------------------------------------------------------ #
    def next_card(self, deck: str | None = None) -> CardView | None:
        if deck is not None:
            deck_id = self.col.decks.id_for_name(deck)
            if deck_id is None:
                return None
            card = self._next_card_for_deck(deck_id)
            return self._card_view(card) if card is not None else None

        # No deck filter: ask each real deck for its top card and return the
        # most urgent one across all of them.
        best = None
        best_key = float("inf")
        for deck_id, _name in self._real_decks():
            card = self._next_card_for_deck(deck_id)
            if card is None:
                continue
            key = self._priority_key(card)
            if best is None or key < best_key:
                best, best_key = card, key
        return self._card_view(best) if best is not None else None

    def answer_card(self, card_id: str, rating: Rating) -> AnswerResult:
        proto_rating = _RATING_TO_PROTO.get(rating)
        if proto_rating is None:
            raise ValueError(f"invalid rating {rating!r}; expected 1..4")

        try:
            cid = int(card_id)
        except (TypeError, ValueError):
            raise KeyError(f"unknown card id {card_id!r}") from None

        try:
            card = self.col.get_card(cid)
        except NotFoundError:
            raise KeyError(f"unknown card id {card_id!r}") from None

        # Suspended (-1) and buried (-2, -3) cards are not answerable.
        if card.queue < 0:
            raise ValueError(f"card {card_id} is not currently answerable")

        # "Currently answerable" guard: a card scheduled for the future (e.g. a
        # card that was *just* answered and pushed to a learning step, or a review
        # card not yet due) must not be graded. This enforces the SRS contract and
        # closes the recovery/replay double-answer window: after a real answer the
        # card's due moves forward, so a re-grade of the same review is rejected
        # here instead of silently advancing the scheduler twice.
        due_now = self._due_at(card)
        if due_now is not None and due_now > datetime.now(timezone.utc):
            raise ValueError(f"card {card_id} is not currently due")

        # SchedulingStates for this exact card — the same data get_queued_cards
        # carries, fetched here so we can grade a card addressed by id.
        states = self.col._backend.get_scheduling_states(cid)

        card.start_timer()  # REQUIRED before build_answer so time-taken is recorded
        answered_at = datetime.now(timezone.utc)
        answer = self.col.sched.build_answer(
            card=card, states=states, rating=proto_rating
        )
        self.col.sched.answer_card(answer)  # writes revlog + advances scheduling

        # Re-read the card to observe its new scheduled state.
        card = self.col.get_card(cid)
        next_due_at = self._due_at(card)
        if next_due_at is None:
            # Extremely unlikely for a just-answered card; keep the contract
            # (next_due_at is non-optional) with a sane fallback.
            next_due_at = answered_at

        if card.queue in (QUEUE_TYPE_REV, QUEUE_TYPE_DAY_LEARN_RELEARN):
            # Review interval is an exact integer number of days in Anki.
            interval_days = float(card.ivl)
        else:
            # Learning steps are sub-day; report the real wait until next due.
            interval_days = max(
                0.0, (next_due_at - answered_at).total_seconds() / _SECS_PER_DAY
            )

        return AnswerResult(
            card_id=str(cid),
            rating=rating,
            answered_at=answered_at,
            next_due_at=next_due_at,
            interval_days=interval_days,
        )

    def add_note(
        self,
        deck: str,
        fields: Mapping[str, str],
        tags: Sequence[str] = (),
        model: str = "Basic",
    ) -> Sequence[str]:
        note_type = self.col.models.by_name(model)
        if note_type is None:
            raise ValueError(f"unknown note type {model!r}")

        note = self.col.new_note(note_type)
        valid_fields = set(note.keys())
        for name, value in fields.items():
            if name not in valid_fields:
                raise ValueError(
                    f"field {name!r} not in note type {model!r}; "
                    f"valid fields: {sorted(valid_fields)}"
                )
            note[name] = value
        if tags:
            note.tags = list(tags)

        deck_id = self.col.decks.id(deck)  # creates the deck if missing
        self.col.add_note(note, deck_id=deck_id)
        return [str(cid) for cid in note.card_ids()]

    # ------------------------------------------------------------------ #
    # ApkgImporter capability
    # ------------------------------------------------------------------ #
    def import_apkg(
        self, apkg_path: str, into_deck: str | None = None
    ) -> ImportSummary:
        """Import a ``.apkg``/``.colpkg`` package via Anki's own importer.

        Delegates to ``col.import_anki_package`` so notes, cards, note types and
        their *original* deck names are recreated exactly as the package author
        intended. The scheduling history in the package is deliberately dropped
        (``with_scheduling=False``): imported cards enter as fresh *new* cards so
        they surface in the DopaMine feed immediately.

        ``into_deck`` is a hint only for this engine — the package carries its own
        deck hierarchy which Anki always preserves, so it is ignored here. (The
        fallback ``FsrsSqliteEngine`` honours it because it has no deck data to
        preserve.)

        Counts are derived from the returned ``ImportResponse`` log and from a
        before/after diff of ``find_cards`` (the log reports notes, not cards).
        """
        path = Path(apkg_path).expanduser()

        # Snapshot existing cards so we can attribute exactly which cards (and
        # thus which decks) the import produced.
        before_cards = set(self.col.find_cards(""))

        Update = import_export_pb2.ImportAnkiPackageUpdateCondition
        options = import_export_pb2.ImportAnkiPackageOptions(
            merge_notetypes=False,
            with_scheduling=False,
            with_deck_configs=False,
            update_notes=Update.IMPORT_ANKI_PACKAGE_UPDATE_CONDITION_ALWAYS,
            update_notetypes=Update.IMPORT_ANKI_PACKAGE_UPDATE_CONDITION_ALWAYS,
        )
        request = import_export_pb2.ImportAnkiPackageRequest(
            package_path=str(path),
            options=options,
        )
        response = self.col.import_anki_package(request)
        log = response.log

        # Cards the import added, and the decks they landed in.
        after_cards = set(self.col.find_cards(""))
        new_card_ids = after_cards - before_cards
        cards_imported = len(new_card_ids)

        deck_names: set[str] = set()
        note_ids: set[int] = set()
        for cid in new_card_ids:
            card = self.col.get_card(cid)
            deck_names.add(self.col.decks.name(card.did))
            note_ids.add(card.nid)

        # Notes added/updated by the import. ``log.new``/``log.updated`` are the
        # authoritative per-note lists; fall back to the distinct notes among the
        # newly-added cards (``found_notes`` counts the *package* contents, which
        # overcounts duplicate/no-op imports where nothing was actually added).
        notes_imported = len(log.new) + len(log.updated)
        if notes_imported == 0:
            notes_imported = len(note_ids)

        return ImportSummary(
            decks=tuple(sorted(deck_names)),
            notes_imported=notes_imported,
            cards_imported=cards_imported,
        )

    def deck_list(self) -> Sequence[DeckInfo]:
        # deck_due_tree carries the limit-respected new/learn/review counts
        # (the numbers Anki shows next to each deck), aggregated over subdecks.
        counts: dict[int, int] = {}
        self._collect_tree_counts(self.col.sched.deck_due_tree(), counts)

        decks: list[DeckInfo] = []
        for deck_id, name in self._real_decks():
            total = len(self.col.find_cards(f'deck:"{name}"'))
            # Skip the always-present empty "Default" deck to avoid noise.
            if name == "Default" and total == 0:
                continue
            decks.append(
                DeckInfo(
                    name=name,
                    due_count=counts.get(deck_id, 0),
                    total_count=total,
                )
            )
        decks.sort(key=lambda d: d.name)
        return decks

    def _collect_tree_counts(self, node, out: dict[int, int]) -> None:
        # node.deck_id == 0 is the synthetic root; still recurse into children.
        if node.deck_id:
            out[node.deck_id] = (
                node.new_count + node.learn_count + node.review_count
            )
        for child in node.children:
            self._collect_tree_counts(child, out)

    def stats(self, deck: str | None = None) -> SrsStats:
        due_now = self._due_now(deck)
        total_cards = self._total_cards(deck)
        reviewed_today = self._reviewed_today(deck)
        retention = self._retention(deck)
        return SrsStats(
            due_now=due_now,
            reviewed_today=reviewed_today,
            total_cards=total_cards,
            retention=retention,
        )

    def _due_now(self, deck: str | None) -> int:
        tree = self.col.sched.deck_due_tree()
        if deck is None:
            # Root node aggregates every deck.
            return tree.new_count + tree.learn_count + tree.review_count
        deck_id = self.col.decks.id_for_name(deck)
        if deck_id is None:
            return 0
        counts: dict[int, int] = {}
        self._collect_tree_counts(tree, counts)
        return counts.get(deck_id, 0)

    def _total_cards(self, deck: str | None) -> int:
        if deck is None:
            return len(self.col.find_cards(""))
        deck_id = self.col.decks.id_for_name(deck)
        if deck_id is None:
            return 0
        return len(self.col.find_cards(f'deck:"{deck}"'))

    def _day_start_ms(self) -> int:
        # day_cutoff is the epoch (secs) at the *next* rollover; today started
        # one day earlier. revlog ids are epoch milliseconds.
        return (self.col.sched.day_cutoff - _SECS_PER_DAY) * 1000

    def _reviewed_today(self, deck: str | None) -> int:
        start_ms = self._day_start_ms()
        if deck is None:
            return (
                self.col.db.scalar(
                    "select count() from revlog where id >= ? and type != ?",
                    start_ms,
                    _REVLOG_TYPE_MANUAL,
                )
                or 0
            )
        deck_id = self.col.decks.id_for_name(deck)
        if deck_id is None:
            return 0
        deck_ids = self.col.decks.deck_and_child_ids(deck_id)
        placeholders = ",".join("?" * len(deck_ids))
        return (
            self.col.db.scalar(
                f"select count() from revlog r join cards c on r.cid = c.id "
                f"where r.id >= ? and r.type != ? and c.did in ({placeholders})",
                start_ms,
                _REVLOG_TYPE_MANUAL,
                *deck_ids,
            )
            or 0
        )

    def _retention(self, deck: str | None) -> float | None:
        """Pass rate over real review-type revlog entries (type == 1).

        ``ease`` 1 is Again (a lapse); ease > 1 is a pass. Returns ``None`` when
        there are no genuine reviews yet (e.g. only new/learning steps so far).
        """
        if deck is None:
            total = self.col.db.scalar(
                "select count() from revlog where type = 1"
            )
            if not total:
                return None
            passed = self.col.db.scalar(
                "select count() from revlog where type = 1 and ease > 1"
            )
            return (passed or 0) / total
        deck_id = self.col.decks.id_for_name(deck)
        if deck_id is None:
            return None
        deck_ids = self.col.decks.deck_and_child_ids(deck_id)
        placeholders = ",".join("?" * len(deck_ids))
        total = self.col.db.scalar(
            f"select count() from revlog r join cards c on r.cid = c.id "
            f"where r.type = 1 and c.did in ({placeholders})",
            *deck_ids,
        )
        if not total:
            return None
        passed = self.col.db.scalar(
            f"select count() from revlog r join cards c on r.cid = c.id "
            f"where r.type = 1 and r.ease > 1 and c.did in ({placeholders})",
            *deck_ids,
        )
        return (passed or 0) / total
