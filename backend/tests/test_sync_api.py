"""API contract and secret-handling tests for AnkiWeb sync."""

from __future__ import annotations

import json

import pytest
from anki.errors import SyncError, SyncErrorKind
from fastapi.testclient import TestClient


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("DOPAMINE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DOPAMINE_SRS_ENGINE", "fsrs")
    monkeypatch.setenv("DOPAMINE_SERVER_SECRET", "test-secret")

    from app.main import create_app

    app = create_app()
    with TestClient(app) as client:
        yield app, client


def _assert_secret_absent(response, secret: str) -> None:
    assert secret not in response.text
    assert "hkey" not in response.text.lower()


def test_fsrs_sync_endpoints_are_consistently_unsupported(app_client):
    _app, client = app_client
    requests = (
        client.post(
            "/api/sync/login",
            json={"username": "user@example.test", "password": "secret"},
        ),
        client.post("/api/sync"),
        client.get("/api/sync/status"),
    )
    for response in requests:
        assert response.status_code == 501
        assert response.json()["error"]["code"] == "SYNC_UNSUPPORTED"
        _assert_secret_absent(response, "secret")


class FakeSyncEngine:
    token = "super-secret-session-token"

    def sync_login(self, username: str, password: str):
        assert username == "user@example.test"
        assert password == "one-time-password"
        return {"hkey": self.token, "endpoint": "https://sync.example.test"}

    def sync(self, hkey: str, endpoint: str):
        assert hkey == self.token
        assert endpoint == "https://sync.example.test"
        return {
            "status": "ok",
            "required": "NORMAL_SYNC",
            "server_message": "done",
            "media": "started",
        }

    def sync_status(self, hkey: str, endpoint: str):
        assert hkey == self.token
        return {"required": "NO_CHANGES"}


def test_login_sync_status_and_state_never_expose_hkey(app_client):
    app, client = app_client
    fake = FakeSyncEngine()
    app.state.engine = fake

    login = client.post(
        "/api/sync/login",
        json={
            "username": "user@example.test",
            "password": "one-time-password",
        },
    )
    assert login.status_code == 200
    assert login.json() == {"ok": True, "endpoint": "https://sync.example.test"}
    _assert_secret_absent(login, fake.token)
    assert app.state.repo.get_sync_auth() == {
        "hkey": fake.token,
        "endpoint": "https://sync.example.test",
    }

    synced = client.post("/api/sync")
    assert synced.status_code == 200
    assert synced.json()["required"] == "NORMAL_SYNC"
    _assert_secret_absent(synced, fake.token)

    status = client.get("/api/sync/status")
    assert status.json() == {"logged_in": True, "required": "NO_CHANGES"}
    _assert_secret_absent(status, fake.token)

    # The fake does not provide stats(), so briefly restore the real engine for
    # /api/state; persistence is independent of the active engine object.
    fake_engine = app.state.engine
    from app.engine_factory import build_engine

    app.state.engine = build_engine()
    state = client.get("/api/state")
    app.state.engine = fake_engine
    assert state.status_code == 200
    _assert_secret_absent(state, fake.token)
    config = app.state.repo.get_config()
    assert "_ankiweb_hkey" not in config
    assert "_ankiweb_endpoint" not in config
    assert fake.token not in json.dumps(config)

    logout = client.post("/api/sync/logout")
    assert logout.json() == {"ok": True}
    assert app.state.repo.get_sync_auth() is None


class FailingLoginEngine(FakeSyncEngine):
    def sync_login(self, username: str, password: str):
        raise SyncError("bad credentials", None, None, None, SyncErrorKind.AUTH)


def test_sync_auth_error_maps_to_401_without_secret(app_client):
    app, client = app_client
    app.state.engine = FailingLoginEngine()
    response = client.post(
        "/api/sync/login",
        json={"username": "user@example.test", "password": "do-not-leak"},
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "SYNC_AUTH_FAILED"
    _assert_secret_absent(response, "do-not-leak")
    assert app.state.repo.get_sync_auth() is None
