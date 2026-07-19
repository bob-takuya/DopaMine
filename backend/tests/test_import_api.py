"""API tests for ``POST /api/import`` via FastAPI TestClient.

The endpoint wiring and the 415 (unsupported media) path must pass regardless
of which engine's ``import_apkg`` is ready. The success path exercises the
active FSRS engine; if that engine's ``import_apkg`` is not implemented yet, the
engine-dependent assertions are skipped rather than failing the wiring test.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "jlpt_n5.apkg"
IMPORTED_DECK = "Imported::JLPT N5"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DOPAMINE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DOPAMINE_SRS_ENGINE", "fsrs")
    monkeypatch.setenv("DOPAMINE_SERVER_SECRET", "test-secret")

    from app.main import create_app

    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


def test_import_rejects_non_apkg_with_415(client):
    res = client.post(
        "/api/import",
        files={"file": ("notes.txt", b"not a package", "text/plain")},
    )
    assert res.status_code == 415
    assert res.json()["error"]["code"] == "UNSUPPORTED_MEDIA"


def test_import_apkg_success_and_deck_appears(client):
    with FIXTURE.open("rb") as fh:
        res = client.post(
            "/api/import",
            files={
                "file": (
                    "jlpt_n5.apkg",
                    fh.read(),
                    "application/octet-stream",
                )
            },
        )

    if res.status_code == 501:
        pytest.skip("active engine does not implement import_apkg yet")

    assert res.status_code == 200, res.text
    imported = res.json()["imported"]
    assert imported["notes"] == 12
    assert IMPORTED_DECK in imported["decks"]

    decks = client.get("/api/decks").json()["decks"]
    names = {d["name"] for d in decks}
    assert IMPORTED_DECK in names
