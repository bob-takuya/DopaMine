"""Rich note-type rendering tests for the PRIMARY engine, ``AnkiLibEngine``.

Proves that after importing a real anki-generated ``.apkg`` the primary engine
renders rich note types correctly, because it delegates rendering to Anki's own
``card.question()`` / ``card.answer()``:

* multi-field custom note types (a 4-field Vocab type) render every field, and
* Cloze notes render a real cloze blank (never the raw ``{{c1::...}}`` markup),
  with the answer revealing the hidden text.

It also confirms the engine reads a *modern* zstd-compressed package with no
extra work.

All work happens against a throwaway collection under pytest's ``tmp_path`` — a
real user collection is never touched. Skipped when the heavy, platform-sensitive
``anki`` wheel is unavailable.

Observed rendered HTML (anki==26.5), for reference:

Vocab front:
    ...食べる<br><span class=read>taberu</span>
Vocab back:
    ...食べる<br><span class=read>taberu</span><hr id=answer>to eat<br><i>パンを食べる</i>

Cloze front:
    ...The capital of Japan is
    <span class="cloze" data-cloze="Tokyo" data-ordinal="1">[...]</span>.
Cloze back:
    ...The capital of Japan is
    <span class="cloze" data-ordinal="1">Tokyo</span>.<br>\nsince 1868
"""

from __future__ import annotations

from pathlib import Path

import pytest

# Skip the whole module if the real anki library is unavailable.
pytest.importorskip("anki")

from app.srs.anki_lib import AnkiLibEngine  # noqa: E402
from app.srs.base import CardView  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
RICH_LEGACY = FIXTURES / "rich_legacy.apkg"
MODERN_ZSTD = FIXTURES / "modern_zstd.apkg"


@pytest.fixture()
def engine(tmp_path):
    """A fresh throwaway collection, closed after the test."""
    eng = AnkiLibEngine(str(tmp_path / "collection.anki2"))
    try:
        yield eng
    finally:
        eng.close()


def _find_card(engine, deck: str, predicate, max_cards: int = 20) -> CardView | None:
    """Return the first card in ``deck`` whose rendered HTML satisfies ``predicate``.

    Walks the scheduler for the deck, answering each non-matching card ("Good")
    so the queue advances, until a match is found or the queue is exhausted.
    ``predicate(card)`` receives the ``CardView``.
    """
    for _ in range(max_cards):
        card = engine.next_card(deck)
        if card is None:
            return None
        if predicate(card):
            return card
        engine.answer_card(card.card_id, 3)  # Good — advance past it
    return None


# --------------------------------------------------------------------------- #
# rich_legacy.apkg
# --------------------------------------------------------------------------- #
def test_rich_legacy_imports_ten_notes(engine):
    summary = engine.import_apkg(str(RICH_LEGACY))
    assert summary.notes_imported == 10


def test_rich_legacy_deck_list_includes_custom_decks(engine):
    engine.import_apkg(str(RICH_LEGACY))
    names = {d.name for d in engine.deck_list()}
    assert "Rich::Vocab" in names
    assert "Rich::Cloze" in names


def test_vocab_multi_field_template_renders_all_fields(engine):
    """The custom 4-field Vocab note type renders Meaning AND Example.

    Front shows only Word/Reading; Meaning + Example live on the answer. Proving
    both appear (across front+back) shows the full template rendered, not just
    the first couple of fields.
    """
    engine.import_apkg(str(RICH_LEGACY))

    card = _find_card(
        engine,
        "Rich::Vocab",
        lambda c: "to eat" in (c.front_html + c.back_html)
        and "パンを食べる" in (c.front_html + c.back_html),
    )
    assert card is not None, "no Vocab card rendered both Meaning and Example"

    combined = card.front_html + card.back_html
    assert "to eat" in combined  # Meaning field
    assert "パンを食べる" in combined  # Example field


def test_cloze_renders_blank_not_raw_markup(engine):
    """A Cloze note renders a real blank on the front and the answer on the back.

    The front must NOT leak the raw ``{{c1::...}}`` markup, and Anki's rendered
    blank (a ``class="cloze"`` span containing ``[...]``) must be present. The
    answer side reveals the hidden text ("Tokyo").
    """
    engine.import_apkg(str(RICH_LEGACY))

    card = _find_card(
        engine,
        "Rich::Cloze",
        lambda c: "Tokyo" in c.back_html and 'class="cloze"' in c.front_html,
    )
    assert card is not None, "no rendered Cloze card found"

    # Front: no raw cloze markup, but a rendered blank.
    assert "{{c1::" not in card.front_html
    assert "{{c1::Tokyo" not in card.front_html
    assert 'class="cloze"' in card.front_html
    assert "[...]" in card.front_html  # Anki's rendered blank placeholder

    # Back: the hidden text is revealed.
    assert "Tokyo" in card.back_html


# --------------------------------------------------------------------------- #
# modern_zstd.apkg — modern zstd-compressed package, read natively by anki
# --------------------------------------------------------------------------- #
def test_modern_zstd_basic_card_renders(engine):
    """The primary engine reads a modern zstd package with no extra work."""
    engine.import_apkg(str(MODERN_ZSTD))

    card = _find_card(
        engine,
        "Modern::Basic",
        lambda c: "犬" in c.front_html and "dog" in c.back_html,
    )
    assert card is not None, "no Modern::Basic card rendered 犬 / dog"
    assert card.deck == "Modern::Basic"
    assert "犬" in card.front_html
    assert "dog" in card.back_html
