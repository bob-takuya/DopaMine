# DopaMine — single-image deploy: FastAPI backend serves the API AND the built
# SPA same-origin, so one container is the whole app (reachable over HTTPS on
# Fly/Railway → works from your phone anywhere, not just your home Wi-Fi).

# ---- Stage 1: build the frontend (SPA) -------------------------------------
FROM node:22-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Root base ("/") + same-origin API: the backend serves this at "/".
RUN npm run build

# ---- Stage 2: python runtime (API + static SPA) ----------------------------
FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DOPAMINE_DATA_DIR=/data \
    DOPAMINE_SRS_ENGINE=fsrs

# ca-certificates: TLS for AnkiWeb sync (and pip). No build tools needed — every
# dependency ships a wheel (anki is a cp310-abi3 manylinux wheel).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install python deps (kept in sync with backend/pyproject.toml).
RUN pip install \
      "anki>=25.0" \
      "fsrs>=6.0" \
      "fastapi>=0.110" \
      "python-multipart>=0.0.9" \
      "uvicorn[standard]>=0.29" \
      "pydantic>=2.6" \
      "httpx>=0.27" \
      "zstandard>=0.25.0"

WORKDIR /app
COPY backend/ /app/backend/
# main.py resolves the SPA at parents[2]/frontend/dist == /app/frontend/dist.
COPY --from=frontend /app/frontend/dist /app/frontend/dist

# Persistent data (game.sqlite3, srs.sqlite3, media, optional collection.anki2)
# lives here — mount a volume at /data on your host.
RUN mkdir -p /data

# Run as ROOT. Managed hosts (Railway, etc.) mount the persistent volume at /data
# ROOT-OWNED at runtime, which hides any build-time chown and makes a non-root
# process fail to create the SQLite/collection files — presenting as "TLS ok but
# the app never responds" (curl 000) because uvicorn exits before it listens.
# Running as root keeps /data writable everywhere. (Personal-use deployment.)
WORKDIR /app/backend
EXPOSE 8000
# Shell form: honour a host-injected $PORT (Railway) else 8000 (Fly/local). The
# `test -w /data` guard fails FAST with a clear error if the volume isn't
# writable, instead of hanging.
CMD ["sh", "-ec", "mkdir -p /data; test -w /data; exec uvicorn app.main:app --host 0.0.0.0 --port \"${PORT:-8000}\""]
