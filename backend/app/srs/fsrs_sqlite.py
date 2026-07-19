"""SQLite-backed FSRS fallback engine.

This adapter owns its schema and intentionally makes no claim of Anki database
compatibility. Datetimes are stored as ISO-8601 UTC strings.
"""

from __future__ import annotations

import json
import re
import shutil
import sqlite3
import tempfile
import zipfile
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fsrs import Card, Rating as FsrsRating, Scheduler
import zstandard

from .base import AnswerResult, CardView, DeckInfo, ImportSummary, Rating, SrsStats


_SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
    note_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    fields_json TEXT NOT NULL,
    tags TEXT NOT NULL,
    deck TEXT NOT NULL,
    css TEXT NOT NULL DEFAULT ''
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
        self._media_dir = self.db_path.parent / "media"
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._scheduler = Scheduler()
        with self._connect() as connection:
            connection.executescript(_SCHEMA)
            columns = {
                row[1] for row in connection.execute("PRAGMA table_info(notes)")
            }
            if "css" not in columns:
                connection.execute(
                    "ALTER TABLE notes ADD COLUMN css TEXT NOT NULL DEFAULT ''"
                )

    def open_media(self, name: str) -> bytes | None:
        """Return imported media by original filename, rejecting traversal."""
        if not name or ".." in name or "/" in name or "\\" in name:
            return None
        try:
            media_root = self._media_dir.resolve()
            path = (self._media_dir / name).resolve()
            path.relative_to(media_root)
            return path.read_bytes()
        except (OSError, ValueError):
            return None

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def next_card(self, deck: str | None = None) -> CardView | None:
        now = _iso(_utc_now())
        query = """
            SELECT c.card_id, c.note_id, c.deck, c.due_at,
                   n.model, n.fields_json, n.tags, n.css
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
            css=row["css"],
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
        css: str = "",
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
                "INSERT INTO notes(note_id, model, fields_json, tags, deck, css) VALUES (?, ?, ?, ?, ?, ?)",
                (note_id, model, json.dumps(dict(fields)), json.dumps(list(tags)), deck, css),
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
        """Import rendered notes from an Anki package.

        Media HTML retains original filenames. Cloze notes pragmatically become
        one fallback card per note, with every cloze ordinal hidden/revealed
        together.
        """

        try:
            package = zipfile.ZipFile(apkg_path)
        except (OSError, zipfile.BadZipFile) as exc:
            raise ValueError(f"invalid Anki package: {exc}") from exc

        with package:
            members = set(package.namelist())
            collection_name = next(
                (
                    name
                    for name in (
                        "collection.anki21b",
                        "collection.anki21",
                        "collection.anki2",
                    )
                    if name in members
                ),
                None,
            )
            if collection_name is None:
                raise ValueError("Anki package contains no supported collection database")

            self._extract_apkg_media(package, collection_name.endswith(".anki21b"))

            with tempfile.TemporaryDirectory(prefix="dopamine-apkg-") as temp_dir:
                collection_path = Path(temp_dir) / "collection.sqlite3"
                try:
                    with package.open(collection_name) as source_file, collection_path.open(
                        "wb"
                    ) as destination:
                        if collection_name.endswith(".anki21b"):
                            dctx = zstandard.ZstdDecompressor()
                            with dctx.stream_reader(source_file) as reader:
                                shutil.copyfileobj(reader, destination)
                        else:
                            shutil.copyfileobj(source_file, destination)
                except (OSError, zstandard.ZstdError) as exc:
                    raise ValueError(f"invalid Anki collection database: {exc}") from exc

                uri = f"{collection_path.as_uri()}?mode=ro"
                try:
                    with sqlite3.connect(uri, uri=True) as source:
                        source.row_factory = sqlite3.Row
                        source.create_collation(
                            "unicase",
                            lambda left, right: (left.casefold() > right.casefold())
                            - (left.casefold() < right.casefold()),
                        )
                        deck_names = self._apkg_deck_names(source)
                        models = self._apkg_models(source)
                        rows = source.execute(
                            """
                            SELECT n.id, n.mid, n.flds, n.tags, c.did
                            FROM notes AS n
                            LEFT JOIN cards AS c ON c.id = (
                                SELECT MIN(c2.id) FROM cards AS c2 WHERE c2.nid = n.id
                            )
                            ORDER BY n.id
                            """
                        ).fetchall()
                except sqlite3.Error as exc:
                    raise ValueError(f"invalid Anki collection database: {exc}") from exc

        imported_decks: set[str] = set()
        notes_imported = 0
        cards_imported = 0
        for row in rows:
            fields = str(row["flds"]).split("\x1f")
            model = models.get(str(row["mid"]))
            front, back = self._render_apkg_note(model, fields)
            original_deck = deck_names.get(str(row["did"])) if row["did"] is not None else None
            deck_name = into_deck or original_deck or "Imported"
            card_ids = self.add_note(
                deck_name,
                {"Front": front, "Back": back},
                tags=str(row["tags"] or "").split(),
                css=str(model.get("css", "")) if model else "",
            )
            imported_decks.add(deck_name)
            notes_imported += 1
            cards_imported += len(card_ids)

        return ImportSummary(tuple(sorted(imported_decks)), notes_imported, cards_imported)

    def _extract_apkg_media(self, package: zipfile.ZipFile, modern: bool) -> None:
        """Extract legacy JSON or modern protobuf media under safe original names."""
        try:
            media_bytes = package.read("media")
        except (KeyError, OSError):
            return

        entries: list[tuple[str, str]] = []
        try:
            mapping = json.loads(media_bytes)
            if isinstance(mapping, dict):
                entries = [(str(stored), str(original)) for stored, original in mapping.items()]
                modern = False
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError):
            try:
                from anki.import_export_pb2 import MediaEntries

                parsed = MediaEntries.FromString(media_bytes)
                entries = [
                    (str(entry.legacy_zip_filename), entry.name) for entry in parsed.entries
                ]
                modern = True
            except (ImportError, TypeError, ValueError):
                return

        for stored_name, original_name in entries:
            if (
                not original_name
                or ".." in original_name
                or "/" in original_name
                or "\\" in original_name
            ):
                continue
            try:
                contents = package.read(stored_name)
                if modern:
                    contents = zstandard.ZstdDecompressor().decompress(contents)
                self._media_dir.mkdir(parents=True, exist_ok=True)
                (self._media_dir / original_name).write_bytes(contents)
            except (KeyError, OSError, zstandard.ZstdError):
                continue

    @staticmethod
    def _apkg_models(connection: sqlite3.Connection) -> dict[str, dict[str, object]]:
        """Load note types from legacy JSON or compatible modern tables."""
        models: dict[str, dict[str, object]] = {}
        try:
            row = connection.execute("SELECT models FROM col LIMIT 1").fetchone()
            decoded = json.loads(row["models"]) if row is not None and row["models"] else {}
            if isinstance(decoded, dict):
                for model_id, model in decoded.items():
                    if isinstance(model, dict):
                        model.setdefault("css", "")
                        models[str(model_id)] = model
        except (sqlite3.Error, ValueError, TypeError):
            pass
        if models:
            return models

        tables = {
            row["name"]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        if not {"notetypes", "fields", "templates"}.issubset(tables):
            return models

        def columns(table: str) -> set[str]:
            return {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}

        nt_columns = columns("notetypes")
        field_columns = columns("fields")
        template_columns = columns("templates")
        type_column = "type" if "type" in nt_columns else None
        config_column = "config" if "config" in nt_columns else None
        for row in connection.execute(
            f"SELECT id, name{', type' if type_column else ''}"
            f"{', config' if config_column else ''} FROM notetypes"
        ):
            model_type = row["type"] if type_column else 0
            if not type_column and config_column:
                try:
                    from anki.notetypes_pb2 import Notetype

                    model_type = Notetype.Config.FromString(row["config"]).kind
                except (ImportError, TypeError, ValueError):
                    pass
            models[str(row["id"])] = {
                "id": row["id"],
                "name": row["name"],
                "type": model_type,
                "flds": [],
                "tmpls": [],
                "css": "",
            }
            if config_column:
                try:
                    from anki.notetypes_pb2 import Notetype

                    config = Notetype.Config.FromString(row["config"])
                    models[str(row["id"])]["type"] = config.kind
                    models[str(row["id"])]["css"] = config.css
                except (ImportError, TypeError, ValueError):
                    pass
        if {"ntid", "ord", "name"}.issubset(field_columns):
            for row in connection.execute("SELECT ntid, ord, name FROM fields"):
                model = models.get(str(row["ntid"]))
                if model is not None:
                    model["flds"].append({"name": row["name"], "ord": row["ord"]})
        if {"ntid", "ord", "name", "qfmt", "afmt"}.issubset(template_columns):
            for row in connection.execute(
                "SELECT ntid, ord, name, qfmt, afmt FROM templates"
            ):
                model = models.get(str(row["ntid"]))
                if model is not None:
                    model["tmpls"].append(dict(row))
        elif {"ntid", "ord", "name", "config"}.issubset(template_columns):
            for row in connection.execute("SELECT ntid, ord, name, config FROM templates"):
                model = models.get(str(row["ntid"]))
                if model is None:
                    continue
                try:
                    from anki.notetypes_pb2 import Notetype

                    config = Notetype.Template.Config.FromString(row["config"])
                    model["tmpls"].append(
                        {
                            "name": row["name"],
                            "ord": row["ord"],
                            "qfmt": config.q_format,
                            "afmt": config.a_format,
                        }
                    )
                except (ImportError, TypeError, ValueError):
                    pass
        return models

    @classmethod
    def _render_apkg_note(
        cls, model: dict[str, object] | None, values: list[str]
    ) -> tuple[str, str]:
        fallback = (values[0] if values else "", values[1] if len(values) > 1 else "")
        if not model:
            return fallback
        try:
            field_defs = sorted(model.get("flds", []), key=lambda field: int(field.get("ord", 0)))
            fields = {
                str(field.get("name", "")): values[index] if index < len(values) else ""
                for index, field in enumerate(field_defs)
            }
            if int(model.get("type", 0)) == 1:
                return cls._render_cloze(fields, model)
            templates = sorted(
                model.get("tmpls", []), key=lambda template: int(template.get("ord", 0))
            )
            if not templates:
                return fallback
            qfmt = str(templates[0].get("qfmt", ""))
            afmt = str(templates[0].get("afmt", ""))
            front = cls._render_template(qfmt, fields)
            back = cls._render_template(afmt, {**fields, "FrontSide": front})
            return front, back
        except (AttributeError, TypeError, ValueError):
            return fallback

    # One left-to-right pass over the template. A stack of open sections means
    # nesting is handled by innermost-close (so nested same-field conditionals
    # pair correctly), and there is no regex backtracking on malformed input.
    _TOKEN_RE = re.compile(r"{{(.*?)}}", re.DOTALL)

    @classmethod
    def _render_template(cls, template: str, fields: Mapping[str, str]) -> str:
        root: list[str] = []
        stack: list[tuple[bool, list[str]]] = []  # (section active?, buffer)

        def buf() -> list[str]:
            return stack[-1][1] if stack else root

        pos = 0
        for match in cls._TOKEN_RE.finditer(template):
            if match.start() > pos:
                buf().append(template[pos:match.start()])
            pos = match.end()
            inner = match.group(1).strip()
            if not inner:
                continue
            marker = inner[0]
            if marker in "#^":  # open positive / inverted section
                name = inner[1:].strip()
                truthy = bool(fields.get(name, ""))
                stack.append((truthy if marker == "#" else not truthy, []))
            elif marker == "/":  # close innermost section
                if stack:
                    active, section = stack.pop()
                    buf().append("".join(section) if active else "")
                # a stray close with no open section is ignored
            else:  # field / {{FrontSide}} / unknown tag -> value or ""
                buf().append(str(fields.get(inner, "")))
        if pos < len(template):
            buf().append(template[pos:])
        while stack:  # tolerate unclosed sections rather than dropping content
            active, section = stack.pop()
            buf().append("".join(section) if active else "")
        return "".join(root)

    @classmethod
    def _render_cloze(
        cls, fields: Mapping[str, str], model: Mapping[str, object]
    ) -> tuple[str, str]:
        templates = model.get("tmpls", [])
        qfmt = str(templates[0].get("qfmt", "")) if templates else ""
        match = re.search(r"{{\s*cloze:([^{}]+?)\s*}}", qfmt)
        cloze_field = match.group(1).strip() if match else "Text"
        text = str(fields.get(cloze_field, next(iter(fields.values()), "")))
        cloze = re.compile(r"{{c\d+::(.*?)}}", re.DOTALL | re.IGNORECASE)

        def parts(match: re.Match[str]) -> tuple[str, str]:
            answer, separator, hint = match.group(1).partition("::")
            return answer, hint if separator else ""

        front = cloze.sub(
            lambda item: f"[{parts(item)[1]}]" if parts(item)[1] else "[...]", text
        )
        back = cloze.sub(
            lambda item: f'<span class="cloze">{parts(item)[0]}</span>', text
        )
        back_extra = str(fields.get("Back Extra", ""))
        if back_extra:
            back += f"<br>{back_extra}"
        return front, back

    @staticmethod
    def _apkg_deck_names(connection: sqlite3.Connection) -> dict[str, str]:
        """Map deck-id -> name, merging BOTH sources an .apkg may use.

        Older schemas store decks as JSON in the ``col`` table; newer ones use a
        real ``decks`` table. A package can carry ids in either, so we merge them
        (the table wins on duplicate ids) instead of trusting only one — otherwise
        ids present only in the JSON would silently fall back to "Imported".
        """
        names: dict[str, str] = {}

        # Legacy: decks JSON in the col table.
        try:
            row = connection.execute("SELECT decks FROM col LIMIT 1").fetchone()
        except sqlite3.OperationalError:
            row = None
        if row is not None and row["decks"]:
            try:
                for deck_id, deck in json.loads(row["decks"]).items():
                    if isinstance(deck, dict) and "name" in deck:
                        names[str(deck_id)] = str(deck["name"])
            except (ValueError, TypeError):
                pass

        # Modern: a real decks table (overrides JSON on duplicate ids).
        has_decks_table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decks'"
        ).fetchone()
        if has_decks_table:
            for row in connection.execute("SELECT id, name FROM decks"):
                names[str(row["id"])] = str(row["name"]).replace("\x1f", "::")

        return names

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
