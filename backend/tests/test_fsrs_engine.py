from pathlib import Path

import pytest

from app.srs.fsrs_sqlite import FsrsSqliteEngine


def test_scheduling_and_persistence(tmp_path: Path) -> None:
    db_path = tmp_path / "srs.sqlite3"
    engine = FsrsSqliteEngine(db_path)
    card_ids = [
        engine.add_note("Demo", {"Front": f"front {index}", "Back": f"back {index}"})[0]
        for index in range(3)
    ]

    card = engine.next_card("Demo")
    assert card is not None
    assert card.card_id in card_ids
    assert card.front_html.startswith("front ")

    before = engine.stats("Demo")
    result = engine.answer_card(card.card_id, 3)
    assert result.next_due_at > result.answered_at
    assert result.interval_days >= 0
    assert engine.stats("Demo").reviewed_today == before.reviewed_today + 1

    with pytest.raises(KeyError):
        engine.answer_card("unknown-card", 3)

    reopened = FsrsSqliteEngine(db_path)
    assert reopened.stats("Demo").total_cards == 3
    assert reopened.stats("Demo").reviewed_today == 1
    assert reopened.next_card("Demo") is not None


def test_seed_demo_is_idempotent(tmp_path: Path) -> None:
    engine = FsrsSqliteEngine(tmp_path / "srs.sqlite3")
    notes = [("one", "uno"), ("two", "dos")]

    assert len(engine.seed_demo("Demo", notes)) == 2
    assert engine.seed_demo("Demo", notes) == []
    assert engine.stats("Demo").total_cards == 2
