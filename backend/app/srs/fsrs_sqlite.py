"""SQLite-backed FSRS fallback engine.

This adapter owns its schema and intentionally makes no claim of Anki database
compatibility. Datetimes are stored as ISO-8601 UTC strings.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import zipfile
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fsrs import Card, Rating as FsrsRating, Scheduler

from .base import AnswerResult, CardView, DeckInfo, ImportSummary, Rating, SrsStats


_SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
    note_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    fields_json TEXT NOT NULL,
    tags TEXT NOT NULL,
    deck TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
    card_id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(note_id),
    deck TEXT NOT NULL,
    fsrs_json TEXT NOT NULL,
    due_at TEXT NOT NULL,
    reps INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS review_log (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(card_id),
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
    answered_at TEXT NOT NULL,
    elapsed_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seed_runs (
    seed_name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_due_idx ON cards(due_at);
CREATE INDEX IF NOT EXISTS cards_deck_due_idx ON cards(deck, due_at);
CREATE INDEX IF NOT EXISTS review_log_answered_idx ON review_log(answered_at);
"""


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("datetime must be timezone-aware")
    return value.astimezone(timezone.utc).isoformat()


def _datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("stored datetime is not timezone-aware")
    return parsed.astimezone(timezone.utc)


class FsrsSqliteEngine:
    """An :class:`AnkiEngine`-compatible local FSRS implementation."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._scheduler = Scheduler()
        with self._connect() as connection:
            connection.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def next_card(self, deck: str | None = None) -> CardView | None:
        now = _iso(_utc_now())
        query = """
            SELECT c.card_id, c.note_id, c.deck, c.due_at,
                   n.model, n.fields_json, n.tags
            FROM cards AS c
            JOIN notes AS n ON n.note_id = c.note_id
            WHERE c.due_at <= ?
        """
        parameters: list[str] = [now]
        if deck is not None:
            query += " AND c.deck = ?"
            parameters.append(deck)
        query += " ORDER BY c.due_at ASC, c.card_id ASC LIMIT 1"

        with self._connect() as connection:
            row = connection.execute(query, parameters).fetchone()
        if row is None:
            return None

        fields = json.loads(row["fields_json"])
        if row["model"] != "Basic":
            raise ValueError(f"unsupported note model: {row['model']}")
        return CardView(
            card_id=row["card_id"],
            note_id=row["note_id"],
            deck=row["deck"],
            front_html=str(fields.get("Front", "")),
            back_html=str(fields.get("Back", "")),
            tags=tuple(json.loads(row["tags"])),
            due_at=_datetime(row["due_at"]),
        )

    def answer_card(self, card_id: str, rating: Rating) -> AnswerResult:
        if rating not in (1, 2, 3, 4):
            raise ValueError(f"invalid rating: {rating}")

        answered_at = _utc_now()
        with self._connect() as connection:
            row = connection.execute(
                "SELECT fsrs_json, due_at FROM cards WHERE card_id = ?", (card_id,)
            ).fetchone()
            if row is None:
                raise KeyError(card_id)
            if _datetime(row["due_at"]) > answered_at:
                raise ValueError(f"card is not currently answerable: {card_id}")

            card = Card.from_dict(json.loads(row["fsrs_json"]))
            card, review = self._scheduler.review_card(
                card, FsrsRating(rating), review_datetime=answered_at
            )
            due = card.due.astimezone(timezone.utc)
            connection.execute(
                """
                UPDATE cards
                SET fsrs_json = ?, due_at = ?, reps = reps + 1
                WHERE card_id = ?
                """,
                (json.dumps(card.to_dict()), _iso(due), card_id),
            )
            connection.execute(
                """
                INSERT INTO review_log(id, card_id, rating, answered_at, elapsed_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    uuid4().hex,
                    card_id,
                    rating,
                    _iso(answered_at),
                    json.dumps(review.to_dict()),
                ),
            )

        return AnswerResult(
            card_id=card_id,
            rating=rating,
            answered_at=answered_at,
            next_due_at=due,
            interval_days=(due - answered_at).total_seconds() / 86400.0,
        )

    def add_note(
        self,
        deck: str,
        fields: Mapping[str, str],
        tags: Sequence[str] = (),
        model: str = "Basic",
    ) -> Sequence[str]:
        if model != "Basic":
            raise ValueError(f"unsupported note model: {model}")
        if "Front" not in fields or "Back" not in fields:
            raise ValueError("Basic notes require Front and Back fields")

        note_id = uuid4().hex
        card_id = uuid4().hex
        now = _utc_now()
        card = Card()
        card.due = now
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO notes(note_id, model, fields_json, tags, deck) VALUES (?, ?, ?, ?, ?)",
                (note_id, model, json.dumps(dict(fields)), json.dumps(list(tags)), deck),
            )
            connection.execute(
                """
                INSERT INTO cards(card_id, note_id, deck, fsrs_json, due_at, reps)
                VALUES (?, ?, ?, ?, ?, 0)
                """,
                (card_id, note_id, deck, json.dumps(card.to_dict()), _iso(now)),
            )
        return [card_id]

    def import_apkg(self, apkg_path: str, into_deck: str | None = None) -> ImportSummary:
        """Import Basic notes from a plain-SQLite Anki package."""

        try:
            with zipfile.ZipFile(apkg_path) as package:
                members = set(package.namelist())
                collection_name = next(
                    (name for name in ("collection.anki21", "collection.anki2") if name in members),
                    None,
                )
                if collection_name is None:
                    if "collection.anki21b" in members:
                        raise ValueError(
                            "zstd-compressed collection.anki21b is not supported by the fallback "
                            "engine; re-export as a legacy .apkg"
                        )
                    raise ValueError("Anki package contains no supported collection database")
                collection_bytes = package.read(collection_name)
        except (OSError, zipfile.BadZipFile) as exc:
            raise ValueError(f"invalid Anki package: {exc}") from exc

        try:
            with tempfile.TemporaryDirectory(prefix="dopamine-apkg-") as temp_dir:
                collection_path = Path(temp_dir) / collection_name
                collection_path.write_bytes(collection_bytes)
                uri = f"{collection_path.as_uri()}?mode=ro"
                try:
                    with sqlite3.connect(uri, uri=True) as source:
                        source.row_factory = sqlite3.Row
                        deck_names = self._apkg_deck_names(source)
                        rows = source.execute(
                            """
                            SELECT n.id, n.flds, n.tags, c.did
                            FROM notes AS n
                            LEFT JOIN cards AS c ON c.id = (
                                SELECT MIN(c2.id) FROM cards AS c2 WHERE c2.nid = n.id
                            )
                            ORDER BY n.id
                            """
                        ).fetchall()
                except sqlite3.Error as exc:
                    raise ValueError(f"invalid Anki collection database: {exc}") from exc
        finally:
            collection_bytes = b""

        imported_decks: set[str] = set()
        notes_imported = 0
        cards_imported = 0
        for row in rows:
            fields = str(row["flds"]).split("\x1f")
            front = fields[0] if fields else ""
            back = fields[1] if len(fields) > 1 else ""
            original_deck = deck_names.get(str(row["did"])) if row["did"] is not None else None
            deck_name = into_deck or original_deck or "Imported"
            card_ids = self.add_note(
                deck_name,
                {"Front": front, "Back": back},
                tags=str(row["tags"] or "").split(),
            )
            imported_decks.add(deck_name)
            notes_imported += 1
            cards_imported += len(card_ids)

        return ImportSummary(tuple(sorted(imported_decks)), notes_imported, cards_imported)

    @staticmethod
    def _apkg_deck_names(connection: sqlite3.Connection) -> dict[str, str]:
        has_decks_table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decks'"
        ).fetchone()
        if has_decks_table:
            return {
                str(row["id"]): str(row["name"])
                for row in connection.execute("SELECT id, name FROM decks")
            }

        row = connection.execute("SELECT decks FROM col LIMIT 1").fetchone()
        if row is None:
            return {}
        decks = json.loads(row["decks"] or "{}")
        return {
            str(deck_id): str(deck["name"])
            for deck_id, deck in decks.items()
            if isinstance(deck, dict) and "name" in deck
        }

    def deck_list(self) -> Sequence[DeckInfo]:
        now = _iso(_utc_now())
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT deck,
                       SUM(CASE WHEN due_at <= ? THEN 1 ELSE 0 END) AS due_count,
                       COUNT(*) AS total_count
                FROM cards
                GROUP BY deck
                ORDER BY deck
                """,
                (now,),
            ).fetchall()
        return [DeckInfo(row["deck"], row["due_count"], row["total_count"]) for row in rows]

    def stats(self, deck: str | None = None) -> SrsStats:
        now = _utc_now()
        start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
        card_filter = "" if deck is None else " WHERE deck = ?"
        review_filter = "" if deck is None else " AND c.deck = ?"
        parameters = () if deck is None else (deck,)
        with self._connect() as connection:
            total = connection.execute(
                f"SELECT COUNT(*) FROM cards{card_filter}", parameters
            ).fetchone()[0]
            due_parameters = (_iso(now),) + parameters
            due = connection.execute(
                f"SELECT COUNT(*) FROM cards WHERE due_at <= ?"
                + ("" if deck is None else " AND deck = ?"),
                due_parameters,
            ).fetchone()[0]
            reviewed = connection.execute(
                """
                SELECT COUNT(*) FROM review_log AS r
                JOIN cards AS c ON c.card_id = r.card_id
                WHERE r.answered_at >= ? AND r.answered_at <= ?
                """
                + review_filter,
                (_iso(start_of_day), _iso(now)) + parameters,
            ).fetchone()[0]
        return SrsStats(due, reviewed, total, None)

    def seed_demo(self, deck: str, notes: list[tuple[str, str]]) -> Sequence[str]:
        """Add demo Basic notes once per deck, returning newly created card IDs."""

        marker = f"demo:{deck}"
        with self._connect() as connection:
            if connection.execute(
                "SELECT 1 FROM seed_runs WHERE seed_name = ?", (marker,)
            ).fetchone():
                return []

            card_ids: list[str] = []
            now = _utc_now()
            for front, back in notes:
                note_id = uuid4().hex
                card_id = uuid4().hex
                card = Card()
                card.due = now
                connection.execute(
                    "INSERT INTO notes(note_id, model, fields_json, tags, deck) VALUES (?, 'Basic', ?, ?, ?)",
                    (
                        note_id,
                        json.dumps({"Front": front, "Back": back}),
                        json.dumps(["dopamine-demo"]),
                        deck,
                    ),
                )
                connection.execute(
                    "INSERT INTO cards(card_id, note_id, deck, fsrs_json, due_at, reps) VALUES (?, ?, ?, ?, ?, 0)",
                    (card_id, note_id, deck, json.dumps(card.to_dict()), _iso(now)),
                )
                card_ids.append(card_id)
            connection.execute(
                "INSERT INTO seed_runs(seed_name, applied_at) VALUES (?, ?)",
                (marker, _iso(now)),
            )
        return card_ids
