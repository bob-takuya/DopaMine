"""Tests for the PRIMARY SRS engine, ``AnkiLibEngine``.

These run against a throwaway collection under ``tmp_path`` and are skipped
entirely when the ``anki`` package is not importable, so the suite stays green
on environments without the (heavy, platform-sensitive) Anki wheel.
"""

from datetime import datetime, timezone

import pytest

# Skip the whole module if the real anki library is unavailable.
pytest.importorskip("anki")

from app.srs.anki_lib import AnkiLibEngine  # noqa: E402
from app.srs.base import AnswerResult, CardView, DeckInfo, SrsStats  # noqa: E402

DECK = "DopaMine Test"


@pytest.fixture()
def engine(tmp_path):
    col_path = tmp_path / "collection.anki2"
    eng = AnkiLibEngine(str(col_path))
    try:
        yield eng
    finally:
        eng.close()


def _seed(engine, count=3):
    ids = []
    for i in range(count):
        ids.extend(
            engine.add_note(
                DECK,
                {"Front": f"front {i}", "Back": f"back {i}"},
                tags=["demo", f"card{i}"],
            )
        )
    return ids


def test_fsrs_is_enabled(engine):
    assert engine.col.get_config("fsrs") is True


def test_add_note_returns_card_ids(engine):
    ids = engine.add_note(
        DECK, {"Front": "犬", "Back": "dog"}, tags=["demo"]
    )
    assert len(ids) == 1
    assert all(isinstance(i, str) for i in ids)
    assert ids[0].isdigit()


def test_add_note_rejects_unknown_field(engine):
    with pytest.raises(ValueError):
        engine.add_note(DECK, {"Nope": "x"})


def test_next_card_returns_a_due_card(engine):
    _seed(engine)
    card = engine.next_card(DECK)
    assert isinstance(card, CardView)
    assert card.deck == DECK
    assert card.card_id.isdigit()
    assert card.note_id.isdigit()
    assert card.front_html  # rendered HTML, non-empty
    assert card.back_html
    assert "demo" in card.tags


def test_next_card_none_when_nothing_due(engine):
    # Empty deck that exists but has no cards.
    engine.add_note("Elsewhere", {"Front": "x", "Back": "y"})
    assert engine.next_card("Nonexistent Deck") is None


def test_answer_good_schedules_future_and_leaves_queue(engine):
    _seed(engine)
    card = engine.next_card(DECK)
    assert card is not None

    before = datetime.now(timezone.utc)
    result = engine.answer_card(card.card_id, 3)  # Good

    assert isinstance(result, AnswerResult)
    assert result.card_id == card.card_id
    assert result.rating == 3
    assert result.answered_at.tzinfo is not None
    assert result.answered_at >= before
    # Next due must be in the future and interval non-negative.
    assert result.next_due_at > result.answered_at
    assert result.interval_days >= 0

    # The answered card must no longer be the immediate next card.
    nxt = engine.next_card(DECK)
    assert nxt is None or nxt.card_id != card.card_id


def test_answer_unknown_card_raises(engine):
    with pytest.raises((KeyError, ValueError)):
        engine.answer_card("9999999999999", 3)


def test_answer_invalid_rating_raises(engine):
    _seed(engine, count=1)
    card = engine.next_card(DECK)
    with pytest.raises(ValueError):
        engine.answer_card(card.card_id, 7)  # type: ignore[arg-type]


def test_deck_list_shows_deck_with_counts(engine):
    _seed(engine)
    decks = engine.deck_list()
    by_name = {d.name: d for d in decks}
    assert DECK in by_name
    info = by_name[DECK]
    assert isinstance(info, DeckInfo)
    assert info.total_count == 3
    assert info.due_count == 3  # three new cards available


def test_stats_reviewed_today_increments(engine):
    _seed(engine)
    before = engine.stats(DECK)
    assert isinstance(before, SrsStats)
    assert before.reviewed_today == 0
    assert before.total_cards == 3
    assert before.due_now == 3

    card = engine.next_card(DECK)
    engine.answer_card(card.card_id, 3)

    after = engine.stats(DECK)
    assert after.reviewed_today == before.reviewed_today + 1


def test_stats_global(engine):
    _seed(engine)
    stats = engine.stats()
    assert stats.total_cards == 3
    assert stats.due_now == 3
