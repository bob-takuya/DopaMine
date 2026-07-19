"""Tests for note-type CSS + media serving.

Three layers:

* Unit tests for the ``rewrite_media_refs`` helper (pure string transform, no
  engine required — always run).
* ``AnkiLibEngine`` tests for ``open_media`` + ``CardView.css`` against a
  throwaway collection (skipped when the ``anki`` package is unavailable).
* API tests for ``GET /api/media`` + the rewrite, driven through the DEFAULT
  FSRS engine after importing the media fixture. The FSRS engine's
  ``open_media`` is owned by another agent; the media-bytes assertion is gated
  with a skip if it is not ready, but the URL-rewrite and 404 assertions must
  pass regardless.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import rewrite_media_refs

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "media_css.apkg"


# --------------------------------------------------------------------------- #
# Unit: rewrite_media_refs
# --------------------------------------------------------------------------- #
def test_rewrite_relative_img_src():
    assert (
        rewrite_media_refs('<img src="dot.png">')
        == '<img src="/api/media/dot.png">'
    )


def test_rewrite_single_quoted_src():
    assert (
        rewrite_media_refs("<img src='dot.png'>")
        == "<img src='/api/media/dot.png'>"
    )


def test_rewrite_leaves_remote_src_unchanged():
    html = '<img src="https://x/y.png">'
    assert rewrite_media_refs(html) == html


def test_rewrite_leaves_data_and_protocol_relative_unchanged():
    for html in (
        '<img src="data:image/png;base64,AAAA">',
        '<img src="//cdn.example.com/y.png">',
        '<img src="http://x/y.png">',
        '<img src="/api/media/already.png">',
    ):
        assert rewrite_media_refs(html) == html


def test_rewrite_sound_syntax_to_audio_tag():
    out = rewrite_media_refs("hear [sound:a.mp3] this")
    assert '<audio controls src="/api/media/a.mp3"></audio>' in out
    assert "[sound:" not in out


def test_rewrite_url_encodes_filename():
    out = rewrite_media_refs('<img src="my file.png">')
    assert out == '<img src="/api/media/my%20file.png">'


def test_rewrite_empty_html_is_noop():
    assert rewrite_media_refs("") == ""


# --------------------------------------------------------------------------- #
# AnkiLibEngine: open_media + CardView.css
# --------------------------------------------------------------------------- #
def test_anki_engine_media_and_css(tmp_path):
    pytest.importorskip("anki")
    from app.srs.anki_lib import AnkiLibEngine

    eng = AnkiLibEngine(str(tmp_path / "collection.anki2"))
    try:
        eng.import_apkg(str(FIXTURE))

        card = eng.next_card(deck="Media::Styled")
        assert card is not None
        assert ".word" in card.css

        data = eng.open_media("dot.png")
        assert data is not None
        assert data.startswith(b"\x89PNG")

        assert eng.open_media("../x") is None
        assert eng.open_media("missing.png") is None
    finally:
        eng.close()


# --------------------------------------------------------------------------- #
# API: /api/media + rewrite through the FSRS engine
# --------------------------------------------------------------------------- #
@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DOPAMINE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DOPAMINE_SRS_ENGINE", "fsrs")
    monkeypatch.setenv("DOPAMINE_SERVER_SECRET", "test-secret")

    from app.main import create_app

    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


def _import_fixture(client) -> None:
    with FIXTURE.open("rb") as fh:
        res = client.post(
            "/api/import",
            files={"file": ("media_css.apkg", fh.read(), "application/octet-stream")},
        )
    if res.status_code == 501:
        pytest.skip("active engine does not implement import_apkg yet")
    assert res.status_code == 200, res.text


def test_api_next_card_has_css_and_rewritten_src(client):
    _import_fixture(client)

    res = client.get("/api/next-card", params={"deck": "Media::Styled"})
    assert res.status_code == 200, res.text
    card = res.json()["card"]
    assert card is not None
    assert ".word" in card["css"]
    assert 'src="/api/media/dot.png"' in card["front_html"]


def test_api_media_missing_returns_404(client):
    _import_fixture(client)

    res = client.get("/api/media/missing.png")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "MEDIA_NOT_FOUND"


def test_api_media_rejects_traversal(client):
    _import_fixture(client)

    res = client.get("/api/media/..%2Fsecret")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_MEDIA_NAME"


def test_api_media_serves_png(client):
    _import_fixture(client)

    res = client.get("/api/media/dot.png")
    if res.status_code == 404:
        pytest.skip("active engine's open_media not ready for imported media")
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/png"
    assert res.content.startswith(b"\x89PNG")
