# Deploy DopaMine (full app, reachable from your phone anywhere)

The container serves the **API + the SPA** from one origin over HTTPS, so once
deployed you just open the URL on your phone — no Wi-Fi tether, no CORS, no
separate frontend. All progress lives under `/data` (mount a volume to keep it).

There is **one image** (`Dockerfile`, multi-stage: builds the SPA, then a Python
runtime that serves everything). Default engine is `fsrs` (self-contained).

Set a real `DOPAMINE_SERVER_SECRET` (random string) in production — it seeds the
reward RNG/HMAC. Everything else has sane defaults.

---

## Option A — Fly.io (scales to zero; good for personal use)

```bash
# once: install flyctl + `fly auth login`
fly launch --no-deploy --copy-config --name dopamine-<you>   # reads fly.toml
fly volumes create dopamine_data --region nrt --size 1        # persist /data
fly secrets set DOPAMINE_SERVER_SECRET=$(openssl rand -hex 32)
fly deploy
```
→ `https://dopamine-<you>.fly.dev` — open on your phone. `fly.toml` is set to
Tokyo (`nrt`), 512 MB, HTTPS forced, and auto-stop/start (no cost while idle).

## Option B — Railway (simplest dashboard flow)

1. New Project → **Deploy from GitHub repo** (or `railway up` with the CLI).
   Railway detects the `Dockerfile` (`railway.json` pins it).
2. **Variables**: set
   - `DOPAMINE_SERVER_SECRET` = a random string
   - `DOPAMINE_SRS_ENGINE` = `anki` (needed for AnkiWeb sync) or `fsrs`
   - **`PORT` = `8000`**  ← IMPORTANT (see gotcha below)
   (`DOPAMINE_DATA_DIR=/data` is baked in.)
3. **Add a Volume** mounted at `/data` (Settings → Volumes) so progress persists.
4. Generate a domain → open the `https://…up.railway.app` URL on your phone.

### Two Railway gotchas we hit (both fixed / documented)
- **Volume permissions → "TLS ok but curl 000".** Railway mounts `/data`
  root-owned, so a non-root process can't create the SQLite files and uvicorn
  exits before listening. The image now **runs as root** (fixed in `Dockerfile`),
  so this is handled. (Alternative: set `RAILWAY_RUN_UID=0`.)
- **Domain target-port mismatch → also "curl 000".** Railway derives the public
  domain's *target port* from the Dockerfile `EXPOSE` (8000) but *injects* a
  different `PORT` (e.g. 8080); the app listens on the injected port, so the
  domain routes to a dead port and hangs. **Fix: set the service variable
  `PORT=8000`** so the app and the domain agree (or set the domain's target port
  to match the injected `PORT`). Verify in the deploy logs:
  `Uvicorn running on http://0.0.0.0:8000`.

## Option C — any Docker host / your own box

```bash
docker compose up --build            # http://localhost:8000 (+ http://<lan-ip>:8000)
# or:
docker build -t dopamine .
docker run -p 8000:8000 -v dopamine_data:/data \
  -e DOPAMINE_SERVER_SECRET=$(openssl rand -hex 32) dopamine
```
Put it behind a reverse proxy (Caddy/Traefik/Cloudflare Tunnel) for HTTPS if you
expose it publicly.

---

## Using your real Anki cards on the hosted instance

Two ways to get your decks in:

1. **Import an `.apkg`** (works with either engine, recommended to bootstrap):
   open the app → **Import .apkg** → upload your deck. It persists on the volume.
2. **AnkiWeb sync** (`DOPAMINE_SRS_ENGINE=anki`): the ☁ Sync panel logs in and
   pushes/pulls **incremental** changes. Note: a *fresh, empty* hosted collection
   needs a **full download** to seed from AnkiWeb, which DopaMine reports but does
   **not** auto-perform (it never overwrites data silently). So seed once via
   `.apkg` import (or the Anki desktop app), then use Sync to stay in step.

To run the Anki engine on the host, set `DOPAMINE_SRS_ENGINE=anki` (the collection
is created at `/data/collection.anki2`).

## Security notes
- Set `DOPAMINE_SERVER_SECRET`. Serve over HTTPS (Fly/Railway do this for you).
- AnkiWeb: only a session token (hkey) is stored server-side, never your password.
- This is a personal-use build (no user accounts/auth on the app itself). If you
  expose it publicly, put an auth proxy in front, or keep the URL private.
