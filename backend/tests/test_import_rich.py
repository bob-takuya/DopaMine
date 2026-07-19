from pathlib import Path

from app.srs.fsrs_sqlite import FsrsSqliteEngine


FIXTURES = Path(__file__).parent / "fixtures"


def test_import_modern_zstd_prefers_real_collection(tmp_path: Path) -> None:
    engine = FsrsSqliteEngine(tmp_path / "srs.sqlite3")

    summary = engine.import_apkg(str(FIXTURES / "modern_zstd.apkg"))

    assert summary.notes_imported == 10
    assert summary.cards_imported == 10
    assert "Modern::Basic" in summary.decks
    card = engine.next_card(deck="Modern::Basic")
    assert card is not None
    assert card.front_html == "犬"
    assert "dog" in card.back_html


def test_import_rich_templates_and_cloze(tmp_path: Path) -> None:
    engine = FsrsSqliteEngine(tmp_path / "srs.sqlite3")

    summary = engine.import_apkg(str(FIXTURES / "rich_legacy.apkg"))

    assert summary.notes_imported == 10
    assert summary.cards_imported == 10
    vocab = engine.next_card(deck="Rich::Vocab")
    assert vocab is not None
    assert "to eat" in vocab.back_html
    assert "パンを食べる" in vocab.back_html
    cloze = engine.next_card(deck="Rich::Cloze")
    assert cloze is not None
    assert "[...]" in cloze.front_html
    assert "{{c1::" not in cloze.front_html
    assert "Tokyo" in cloze.back_html
