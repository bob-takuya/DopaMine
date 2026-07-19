from pathlib import Path

import pytest

from app.srs.fsrs_sqlite import FsrsSqliteEngine


FIXTURE = Path(__file__).parent / "fixtures" / "jlpt_n5.apkg"


def test_import_apkg_is_immediately_studyable(tmp_path: Path) -> None:
    engine = FsrsSqliteEngine(tmp_path / "srs.sqlite3")

    summary = engine.import_apkg(str(FIXTURE))

    assert summary.notes_imported == 12
    assert summary.cards_imported == 12
    assert "Imported::JLPT N5" in summary.decks
    card = engine.next_card(deck="Imported::JLPT N5")
    assert card is not None
    assert card.front_html
    assert card.back_html
    assert engine.answer_card(card.card_id, 3).card_id == card.card_id


def test_import_apkg_into_deck_overrides_source_deck(tmp_path: Path) -> None:
    engine = FsrsSqliteEngine(tmp_path / "srs.sqlite3")

    summary = engine.import_apkg(str(FIXTURE), into_deck="My Japanese")

    assert summary.decks == ("My Japanese",)
    assert summary.notes_imported == 12
    assert summary.cards_imported == 12
    assert engine.next_card(deck="My Japanese") is not None
    assert engine.next_card(deck="Imported::JLPT N5") is None


def test_import_apkg_rejects_non_zip(tmp_path: Path) -> None:
    bogus = tmp_path / "bogus.apkg"
    bogus.write_text("not a zip")
    engine = FsrsSqliteEngine(tmp_path / "srs.sqlite3")

    with pytest.raises(ValueError, match="invalid Anki package"):
        engine.import_apkg(str(bogus))
