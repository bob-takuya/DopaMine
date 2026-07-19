"""API integration tests using FastAPI TestClient against the fsrs engine."""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DOPAMINE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DOPAMINE_SRS_ENGINE", "fsrs")
    monkeypatch.setenv("DOPAMINE_SERVER_SECRET", "test-secret")

    from app.main import create_app

    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


def _new_id() -> str:
    return str(uuid.uuid4())


def test_seed_demo_creates_ten_and_is_idempotent(client):
    res = client.post("/api/seed-demo", json={"deck": "DopaMine Demo"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["deck"] == "DopaMine Demo"
    assert body["created"] == 10
    assert body["existing"] == 0
    assert len(body["card_ids"]) == 10

    # Re-seeding is idempotent.
    again = client.post("/api/seed-demo", json={"deck": "DopaMine Demo"}).json()
    assert again["created"] == 0
    assert again["existing"] == 10


def test_decks_shows_demo_deck(client):
    client.post("/api/seed-demo", json={"deck": "DopaMine Demo"})
    decks = client.get("/api/decks").json()["decks"]
    demo = next(d for d in decks if d["name"] == "DopaMine Demo")
    assert demo["total_count"] == 10
    assert demo["due_count"] == 10


def test_next_card_returns_a_card(client):
    client.post("/api/seed-demo", json={"deck": "DopaMine Demo"})
    res = client.get("/api/next-card", params={"deck": "DopaMine Demo"}).json()
    assert res["card"] is not None
    assert res["card"]["deck"] == "DopaMine Demo"
    assert res["card"]["front_html"]
    assert "server_time" in res


def test_next_card_none_when_no_cards(client):
    res = client.get("/api/next-card").json()
    assert res["card"] is None


def test_answer_grades_and_returns_srs_rewards_state(client):
    client.post("/api/seed-demo", json={"deck": "DopaMine Demo"})
    card = client.get("/api/next-card", params={"deck": "DopaMine Demo"}).json()["card"]
    review_id = _new_id()

    res = client.post(
        "/api/answer",
        json={"review_id": review_id, "card_id": card["card_id"], "rating": 3},
    )
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["review_id"] == review_id
    assert body["srs"]["card_id"] == card["card_id"]
    assert body["srs"]["rating"] == 3
    assert body["srs"]["next_due_at"] > body["srs"]["answered_at"]

    types = [e["type"] for e in body["rewards"]]
    assert types[0] == "xp_awarded"
    assert types[1] == "combo_changed"
    assert types[-1] in {"loot_dropped", "no_drop", "near_miss"}
    for event in body["rewards"]:
        assert event["event_id"]
        assert "payload" in event

    state = body["state"]
    assert state["total_xp"] >= 4
    assert state["combo"] == 1
    assert state["version"] == 1
    assert "level" in state
    assert "reviews_today" in state


def test_answer_is_idempotent_on_replay(client):
    client.post("/api/seed-demo", json={"deck": "DopaMine Demo"})
    card = client.get("/api/next-card", params={"deck": "DopaMine Demo"}).json()["card"]
    review_id = _new_id()
    payload = {"review_id": review_id, "card_id": card["card_id"], "rating": 3}

    first = client.post("/api/answer", json=payload).json()
    second = client.post("/api/answer", json=payload).json()
    assert first == second


def test_answer_conflict_on_same_id_different_rating(client):
    client.post("/api/seed-demo", json={"deck": "DopaMine Demo"})
    card = client.get("/api/next-card", params={"deck": "DopaMine Demo"}).json()["card"]
    review_id = _new_id()

    client.post(
        "/api/answer",
        json={"review_id": review_id, "card_id": card["card_id"], "rating": 3},
    )
    conflict = client.post(
        "/api/answer",
        json={"review_id": review_id, "card_id": card["card_id"], "rating": 4},
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "REVIEW_ID_CONFLICT"


def test_invalid_rating_returns_422(client):
    client.post("/api/seed-demo", json={"deck": "DopaMine Demo"})
    res = client.post(
        "/api/answer",
        json={"review_id": _new_id(), "card_id": "x", "rating": 5},
    )
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "VALIDATION_ERROR"


def test_state_returns_state_guardrails_and_srs(client):
    client.post("/api/seed-demo", json={"deck": "DopaMine Demo"})
    res = client.get("/api/state").json()
    assert set(res.keys()) == {"state", "guardrails", "srs"}
    assert "total_xp" in res["state"]
    assert "inventory" in res["state"]
    assert res["guardrails"]["timezone"] == "Asia/Tokyo"
    assert res["guardrails"]["honest_streak_mode"] is True
    assert res["srs"]["total_cards"] == 10


def test_config_toggles_honest_streak_mode(client):
    res = client.put("/api/config", json={"honest_streak_mode": False})
    assert res.status_code == 200
    assert res.json()["config"]["honest_streak_mode"] is False
    # Persisted and reflected in /api/state guardrails.
    guardrails = client.get("/api/state").json()["guardrails"]
    assert guardrails["honest_streak_mode"] is False


def test_config_rejects_unknown_field(client):
    res = client.put("/api/config", json={"nonsense": True})
    assert res.status_code == 422
