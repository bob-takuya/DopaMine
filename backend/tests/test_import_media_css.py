from app.srs.fsrs_sqlite import FsrsSqliteEngine


def test_import_extracts_media_and_preserves_note_type_css(tmp_path):
    engine = FsrsSqliteEngine(tmp_path / "srs.sqlite3")

    engine.import_apkg("backend/tests/fixtures/media_css.apkg")

    assert engine.open_media("dot.png").startswith(b"\x89PNG")
    assert engine.open_media("../secret") is None
    assert engine.open_media("nope.png") is None

    card = engine.next_card(deck="Media::Styled")
    assert card is not None
    assert ".word" in card.css
    assert "background" in card.css
    assert '<img src="dot.png">' in card.front_html
    assert '<div class="word">ねこ' in card.front_html
