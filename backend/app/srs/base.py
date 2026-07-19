from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Mapping, Protocol, Sequence

Rating = Literal[1, 2, 3, 4]  # Again, Hard, Good, Easy


@dataclass(frozen=True)
class CardView:
    card_id: str
    note_id: str
    deck: str
    front_html: str
    back_html: str
    tags: tuple[str, ...]
    due_at: datetime | None
    # The note type's CSS (Anki model `css`, styling `.card` and friends). Empty
    # when unknown. Media in front/back_html keeps original filenames; the API
    # rewrites them to /api/media/<name> and serves via a MediaProvider engine.
    css: str = ""


@dataclass(frozen=True)
class AnswerResult:
    card_id: str
    rating: Rating
    answered_at: datetime
    next_due_at: datetime
    interval_days: float


@dataclass(frozen=True)
class DeckInfo:
    name: str
    due_count: int
    total_count: int


@dataclass(frozen=True)
class SrsStats:
    due_now: int
    reviewed_today: int
    total_cards: int
    retention: float | None


@dataclass(frozen=True)
class ImportSummary:
    decks: tuple[str, ...]
    notes_imported: int
    cards_imported: int


class MediaProvider(Protocol):
    """Optional capability: resolve a media file referenced by card HTML.

    Card front/back HTML keeps the original Anki filename (e.g. ``dot.png``);
    the API rewrites those references to ``/api/media/<name>`` and serves the
    bytes by calling ``open_media(name)`` on the active engine. Returns ``None``
    when the file is unknown. Implementations MUST reject path traversal.
    """

    def open_media(self, name: str) -> bytes | None: ...


class ApkgImporter(Protocol):
    """Optional capability: import a `.apkg`/`.colpkg` Anki package.

    Both concrete engines implement this. The import endpoint requires it; the
    base `AnkiEngine` does not, so a minimal engine need not support import.
    ``into_deck`` overrides the destination deck name when the package's own
    deck names cannot be preserved (fallback engine); ``None`` keeps origins.
    """

    def import_apkg(self, apkg_path: str, into_deck: str | None = None) -> ImportSummary: ...


class AnkiEngine(Protocol):
    def next_card(self, deck: str | None = None) -> CardView | None: ...
    def answer_card(self, card_id: str, rating: Rating) -> AnswerResult: ...
    def add_note(
        self,
        deck: str,
        fields: Mapping[str, str],
        tags: Sequence[str] = (),
        model: str = "Basic",
    ) -> Sequence[str]: ...
    def deck_list(self) -> Sequence[DeckInfo]: ...
    def stats(self, deck: str | None = None) -> SrsStats: ...
