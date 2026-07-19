"""Tests for ``AnkiLibEngine.import_apkg`` against the real anki importer.

Runs against a throwaway collection under ``tmp_path`` and is skipped when the
``anki`` wheel is unavailable.
"""

from __future__ import annotations

from pathlib import Path

import pytest

# Skip the whole module if the real anki library is unavailable.
pytest.importorskip("anki")

from app.srs.anki_lib import AnkiLibEngine  # noqa: E402
from app.srs.base import ImportSummary  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "jlpt_n5.apkg"
IMPORTED_DECK = "Imported::JLPT N5"


@pytest.fixture()
def engine(tmp_path):
    eng = AnkiLibEngine(str(tmp_path / "collection.anki2"))
    try:
        yield eng
    finally:
        eng.close()


def test_import_apkg_returns_summary(engine):
    summary = engine.import_apkg(str(FIXTURE))

    assert isinstance(summary, ImportSummary)
    assert summary.notes_imported == 12
    assert summary.cards_imported == 12
    # The card-bearing deck is the leaf; its name is preserved from the package.
    assert IMPORTED_DECK in summary.decks


def test_import_creates_deck_in_deck_list(engine):
    engine.import_apkg(str(FIXTURE))

    names = {e.name for e in engine.col.decks.all_names_and_ids(include_filtered=False)}
    assert IMPORTED_DECK in names


def test_imported_card_is_answerable_good(engine):
    engine.import_apkg(str(FIXTURE))

    card = engine.next_card(IMPORTED_DECK)
    assert card is not None
    assert card.deck == IMPORTED_DECK
    assert card.front_html

    result = engine.answer_card(card.card_id, 3)  # Good
    assert result.card_id == card.card_id
    assert result.rating == 3
    assert result.next_due_at > result.answered_at


def test_into_deck_hint_is_ignored_names_preserved(engine):
    # AnkiLibEngine always preserves the package's own deck names; ``into_deck``
    # is a no-op hint for this engine.
    summary = engine.import_apkg(str(FIXTURE), into_deck="Some Other Deck")
    assert IMPORTED_DECK in summary.decks
    names = {e.name for e in engine.col.decks.all_names_and_ids(include_filtered=False)}
    assert "Some Other Deck" not in names
