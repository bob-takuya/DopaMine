# Verified anki 26.5 AnkiWeb sync API (for the sync wave)

Sync ONLY works with AnkiLibEngine (a real Anki collection). The FSRS fallback cannot sync to AnkiWeb.

```python
# 1. Login (exchange credentials for a session token). endpoint=None -> default AnkiWeb.
auth = col.sync_login(username, password, None)   # -> SyncAuth(hkey, endpoint, io_timeout_secs)
#    Store ONLY auth.hkey + auth.endpoint (a session token). NEVER persist the password.

# 2. Check status (optional)
status = col.sync_status(auth)                      # -> SyncStatus (required/normal/no_changes)

# 3. Sync the collection (normal incremental)
out = col.sync_collection(auth, sync_media=True)    # -> SyncOutput
#    out.required indicates whether a FULL up/download is needed (schema/version change,
#    or first sync from a populated server). If a full sync is required, incremental sync
#    will not reconcile — handle by reporting to the user (and optionally col.full_upload_or_download).
#    out.server_message / out.new_endpoint / out.host_number carry server info.

# 4. Media sync (files) — separate call
col.sync_media(auth)                                # background media sync; poll col.media_sync_status()

col.abort_sync(); col.abort_media_sync()            # cancellation
```

Protobufs: `anki.sync_pb2` — SyncAuth(hkey, endpoint, io_timeout_secs), SyncLoginRequest(username, password, endpoint),
SyncCollectionResponse(host_number, server_message, required, new_endpoint, server_media_usn).

## Design for DopaMine
- AnkiLibEngine methods: `sync_login(user, pass) -> {"ok":..}` (stores SyncAuth in memory/DB), `sync() -> {status, message, required_full}`, `sync_status()`.
- API: `POST /api/sync/login {username,password}` (creds transit once, only hkey stored), `POST /api/sync`, `GET /api/sync/status`.
  Return 501 SYNC_UNSUPPORTED when the active engine is the FSRS fallback (hasattr guard).
- Store the hkey token in the config/DB (it is sensitive — treat like a password; do not log it).
- Frontend: a "Sync with AnkiWeb" panel (login form -> sync button, shows last-sync result / full-sync-required warning).
- Cannot be live-tested without real AnkiWeb credentials: unit-test the wiring, engine-missing 501 path, and error
  handling (bad creds -> surfaced error); document that a real account is needed for an end-to-end sync.
- Full-sync path is destructive (overwrites one side). MVP: detect required-full and REPORT it; do not auto-overwrite.
