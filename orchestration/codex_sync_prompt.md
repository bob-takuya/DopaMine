You are Codex on the DopaMine team. Add AnkiWeb account SYNC so reviews done in DopaMine sync back to the
user's real Anki (AnkiWeb) and their other Anki apps. You own the BACKEND: backend/app/srs/anki_lib.py,
backend/app/repository.py, backend/app/main.py, backend/app/db.py (if needed), and new tests. Do NOT touch
fsrs_sqlite.py or frontend/*.

READ FIRST: orchestration/sync_api_notes.md (VERIFIED anki 26.5 sync API), backend/app/srs/anki_lib.py,
backend/app/repository.py (config get/set + CONFIG_KEYS allowlist), backend/app/main.py (routes, engine()/repo()/
coordinator(), ApiError, CORS).

Venv: ./.venv/bin/python (anki==26.5). Sync ONLY works with AnkiLibEngine (a real
collection); the FSRS fallback cannot sync — the endpoints must return 501 SYNC_UNSUPPORTED when the active engine
lacks the sync methods.

SECURITY (critical):
- The user's AnkiWeb password transits the login endpoint ONCE and is exchanged for a session token (hkey). NEVER
  persist or log the password. Persist ONLY the hkey + endpoint.
- Treat the hkey like a password: never return it in /api/state, /api/sync responses, or logs. It must NOT be
  settable/readable via PUT /api/config or GET /api/state (keep it out of the guardrail CONFIG_KEYS allowlist).
- Do not print hkey/password anywhere.

BACKEND — AnkiLibEngine (anki_lib.py), add methods that wrap the real API (see sync_api_notes.md):
- `sync_login(self, username, password) -> dict`: call `self.col.sync_login(username, password, None)` -> SyncAuth;
  return {"hkey": auth.hkey, "endpoint": auth.endpoint or ""}. Let anki.errors.SyncError propagate (the API maps it).
- `sync(self, hkey, endpoint) -> dict`: build `SyncAuth(hkey=hkey, endpoint=endpoint or None)` (from anki.sync_pb2),
  call `self.col.sync_collection(auth, sync_media=True)` -> SyncOutput. Inspect `.required` (an enum on the response;
  introspect the real enum values, e.g. NO_CHANGES / NORMAL_SYNC / FULL_SYNC / FULL_DOWNLOAD / FULL_UPLOAD). Return
  {"status": "ok"|"no_changes"|"full_sync_required", "required": <name>, "server_message": out.server_message,
   "media": "started"}. If a full sync is required, DO NOT auto-perform it (it is destructive/overwrites one side);
  just report "full_sync_required" with the direction so the user decides. Kick off media sync via
  `self.col.sync_media(auth)` best-effort (guard in try/except; media is non-fatal).
- `sync_status(self, hkey, endpoint) -> dict`: call `self.col.sync_status(auth)`; return {"required": <name>}.
- Introspect the actual SyncOutput / SyncStatus / required enum shapes in the venv against a throwaway collection to
  get field/enum names right. (You cannot do a real login without credentials — that's expected; wire it correctly.)

BACKEND — repository.py: add `set_sync_auth(hkey, endpoint)`, `get_sync_auth() -> dict|None`, `clear_sync_auth()`,
storing in the existing config table under reserved keys (e.g. "_ankiweb_hkey","_ankiweb_endpoint") that are NOT in
CONFIG_KEYS (so PUT /api/config can't touch them and get_config()/state never returns them). get_config() must
continue to expose ONLY the guardrail keys (verify reserved keys don't leak).

BACKEND — main.py routes (guard each: if not hasattr(engine(), "sync_login") -> 501 SYNC_UNSUPPORTED
{"error":{"code":"SYNC_UNSUPPORTED","message":"Sync requires the Anki engine (set DOPAMINE_SRS_ENGINE=anki)."}}):
- `POST /api/sync/login`  body {username, password} (pydantic model in schemas.py): under coordinator().lock call
  engine().sync_login(...); on success repo().set_sync_auth(hkey, endpoint) and return {"ok": true, "endpoint": ...}
  (NO hkey in the response). Map anki SyncError -> 401 {"error":{"code":"SYNC_AUTH_FAILED","message": str(e)}}.
- `POST /api/sync`: load stored auth via repo().get_sync_auth(); if none -> 401 SYNC_NOT_LOGGED_IN. Under the lock call
  engine().sync(hkey, endpoint); if the returned "endpoint" changed persist it. Return the sync result dict
  (never the hkey). Map SyncError -> 502 SYNC_FAILED.
- `GET /api/sync/status`: {"logged_in": bool} from whether auth is stored; if logged in and cheap, include the
  engine().sync_status result's "required". Never include hkey.
- `POST /api/sync/logout`: repo().clear_sync_auth(); {"ok": true}.
Add the request pydantic models to backend/app/schemas.py. Keep CORS working.

TESTS — backend/tests/test_sync_api.py (fastapi TestClient):
- With the DEFAULT fsrs engine: POST /api/sync/login and POST /api/sync and GET /api/sync/status behave — login/sync
  return 501 SYNC_UNSUPPORTED (fsrs lacks the methods); status returns {"logged_in": false} (or 501 — your choice,
  but be consistent and assert it). Assert no hkey ever appears.
- With a FAKE engine that has sync_login/sync (monkeypatch app.state.engine to a stub returning canned dicts, or use
  a small fake): POST /api/sync/login stores auth and returns {"ok":true} WITHOUT hkey; a subsequent POST /api/sync
  returns the stub's result; GET /api/state and GET /api/sync/status never expose the hkey; a stub raising an
  auth-error maps to 401. Assert repo().get_config() does NOT contain the reserved sync keys.
- If anki is importable, a light AnkiLibEngine test that sync_login with obviously-bad creds raises/maps to an error
  (network permitting; if it can't reach AnkiWeb, skip that one).

RUN: ./.venv/bin/python -m pytest backend/tests/test_sync_api.py -q then FULL
backend/tests/ -q. Fix until green. Report: the real SyncOutput/required enum you found, the endpoints, how the hkey
is protected, and pytest output.
