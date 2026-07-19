from datetime import datetime, timedelta, timezone
import inspect
from typing import get_args, get_type_hints

import pytest

from app.srs.base import AnkiEngine, AnswerResult, CardView, DeckInfo, Rating, SrsStats


class FakeEngine:
    def next_card(self, deck: str | None = None) -> CardView | None:
        return CardView("c1", "n1", deck or "Default", "front", "back", (), None)

    def answer_card(self, card_id: str, rating: Rating) -> AnswerResult:
        if rating not in get_args(Rating):
            raise ValueError("invalid rating")
        now = datetime.now(timezone.utc)
        return AnswerResult(card_id, rating, now, now + timedelta(days=1), 1.0)

    def add_note(self, deck, fields, tags=(), model="Basic"):
        return ("created",)

    def deck_list(self):
        return (DeckInfo("Default", 1, 1),)

    def stats(self, deck=None):
        return SrsStats(1, 0, 1, None)


def test_protocol_is_satisfied_at_runtime() -> None:
    engine: AnkiEngine = FakeEngine()
    assert isinstance(engine.next_card(), CardView)
    assert isinstance(engine.deck_list()[0], DeckInfo)
    assert isinstance(engine.stats(), SrsStats)


def test_contract_method_names_and_return_annotations() -> None:
    assert set(AnkiEngine.__dict__) >= {"next_card", "answer_card", "add_note", "deck_list", "stats"}
    hints = get_type_hints(AnkiEngine.answer_card)
    assert hints["rating"] == Rating
    assert hints["return"] is AnswerResult
    assert list(inspect.signature(AnkiEngine.add_note).parameters) == ["self", "deck", "fields", "tags", "model"]


@pytest.mark.parametrize("rating", [1, 2, 3, 4])
def test_all_anki_ratings_are_accepted(rating: Rating) -> None:
    assert FakeEngine().answer_card("c1", rating).rating == rating


@pytest.mark.parametrize("rating", [0, 5])
def test_out_of_range_ratings_are_rejected(rating: int) -> None:
    with pytest.raises(ValueError):
        FakeEngine().answer_card("c1", rating)  # type: ignore[arg-type]
