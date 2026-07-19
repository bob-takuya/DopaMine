"""FastAPI application: routes, engine selection, write lock, guardrails."""

from __future__ import annotations

import mimetypes
import os
import re
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
class _NeverRaised(Exception):
    """Sentinel so sync error handlers are harmless when anki isn't installed."""


try:
    from anki.errors import NetworkError, SyncError, SyncErrorKind
except Exception:  # pragma: no cover - anki absent -> sync routes 501 before use
    SyncError = NetworkError = _NeverRaised  # type: ignore[assignment,misc]
    SyncErrorKind = None  # type: ignore[assignment]

from app.db import migrate
from app.demo import run_seed
from app.engine_factory import build_engine
from app.errors import ApiError
from app.repository import Repository
from app.schemas import (
    AnswerRequest,
    ConfigUpdate,
    SeedDemoRequest,
    SyncFullRequest,
    SyncLoginRequest,
)
from app.services.review import ReviewCoordinator, project_state
from app.srs.base import CardView, DeckInfo, SrsStats


_MAX_IMPORT_BYTES = 25 * 1024 * 1024  # 25 MB cap for uploaded packages


def _iso(value: datetime | None) -> Optional[str]:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat()


# Media references that already point somewhere absolute/external must not be
# rewritten: remote URLs, protocol-relative URLs, inline data URIs, and refs we
# have already rewritten to our own endpoint.
_SKIP_MEDIA_PREFIXES = ("http://", "https://", "data:", "//", "/api/media")

# `src="X"` / `src='X'` on any HTML tag (img/audio/video/source). Group 1 is the
# opening quote char, group 2 the referenced value. The leading lookbehind means
# we match the *src* attribute only — not `data-src`, `xlink:src`, etc.
_SRC_ATTR_RE = re.compile(r"""(?<![\w:-])src\s*=\s*(["'])(.*?)\1""", re.IGNORECASE)
# Anki's audio placeholder syntax: [sound:filename.mp3].
_SOUND_RE = re.compile(r"\[sound:([^\]]+)\]")


def _media_url(name: str) -> str:
    """Backend URL that serves a media file by (URL-encoded) filename."""
    return "/api/media/" + quote(name, safe="")


def _should_rewrite(value: str) -> bool:
    v = value.strip()
    if not v:
        return False
    # Root-relative refs (e.g. /assets/x.png) are app-absolute, not Anki media.
    if v.startswith("/"):
        return False
    return not v.lower().startswith(_SKIP_MEDIA_PREFIXES)


def rewrite_media_refs(html: str) -> str:
    """Rewrite relative media references in card HTML to /api/media/<name>.

    * ``src="dot.png"`` -> ``src="/api/media/dot.png"`` (img/audio/video/source).
    * ``[sound:a.mp3]`` -> ``<audio controls src="/api/media/a.mp3"></audio>``.

    Absolute/external/already-rewritten references (http(s)://, //, data:,
    /api/media) are left untouched. Filenames are URL-encoded in the output.
    """
    if not html:
        return html

    def _sub_src(m: re.Match) -> str:
        quote_char, value = m.group(1), m.group(2)
        if not _should_rewrite(value):
            return m.group(0)
        return f"src={quote_char}{_media_url(value)}{quote_char}"

    def _sub_sound(m: re.Match) -> str:
        value = m.group(1)
        if not _should_rewrite(value):
            return m.group(0)
        return f'<audio controls src="{_media_url(value)}"></audio>'

    html = _SRC_ATTR_RE.sub(_sub_src, html)
    html = _SOUND_RE.sub(_sub_sound, html)
    return html


def _card_dict(card: CardView) -> dict[str, Any]:
    return {
        "card_id": card.card_id,
        "note_id": card.note_id,
        "deck": card.deck,
        "front_html": rewrite_media_refs(card.front_html),
        "back_html": rewrite_media_refs(card.back_html),
        "css": card.css,
        "tags": list(card.tags),
        "due_at": _iso(card.due_at),
    }


def _deck_dict(deck: DeckInfo) -> dict[str, Any]:
    return {
        "name": deck.name,
        "due_count": deck.due_count,
        "total_count": deck.total_count,
    }


def _stats_dict(stats: SrsStats) -> dict[str, Any]:
    return {
        "due_now": stats.due_now,
        "reviewed_today": stats.reviewed_today,
        "total_cards": stats.total_cards,
        "retention": stats.retention,
    }


def _server_time() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        migrate()
        repo = Repository()
        engine = build_engine()
        secret = os.environ.get("DOPAMINE_SERVER_SECRET", "dopamine-dev-secret")
        coordinator = ReviewCoordinator(engine, repo, secret)
        app.state.repo = repo
        app.state.engine = engine
        app.state.coordinator = coordinator
        # Recover any pending reviews from a previous crash.
        coordinator.recover_pending()
        yield

    app = FastAPI(title="DopaMine API", lifespan=lifespan)

    frontend_origin = os.environ.get("DOPAMINE_FRONTEND_ORIGIN")
    origins = ["http://localhost:5173", "http://localhost:3000"]
    if frontend_origin and frontend_origin not in origins:
        origins.append(frontend_origin)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(ApiError)
    async def _api_error_handler(request: Request, exc: ApiError):
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message}},
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(request: Request, exc: RequestValidationError):
        return JSONResponse(
            status_code=422,
            content={
                "error": {"code": "VALIDATION_ERROR", "message": str(exc.errors())}
            },
        )

    def repo() -> Repository:
        return app.state.repo

    def engine():
        return app.state.engine

    def coordinator() -> ReviewCoordinator:
        return app.state.coordinator

    def require_sync_engine():
        eng = engine()
        # Require the full sync capability, not just login, so no route can hit
        # a missing method and 500.
        if not all(
            hasattr(eng, m)
            for m in ("sync_login", "sync", "sync_status", "sync_full")
        ):
            raise ApiError(
                501,
                "SYNC_UNSUPPORTED",
                "Sync requires the Anki engine (set DOPAMINE_SRS_ENGINE=anki).",
            )
        return eng

    # ----- routes --------------------------------------------------------
    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"status": "ok", "server_time": _server_time()}

    @app.get("/api/next-card")
    def next_card(deck: Optional[str] = None) -> dict[str, Any]:
        card = engine().next_card(deck)
        return {
            "card": _card_dict(card) if card is not None else None,
            "server_time": _server_time(),
        }

    @app.post("/api/answer")
    def answer(body: AnswerRequest) -> dict[str, Any]:
        return coordinator().answer(body.review_id, body.card_id, body.rating)

    @app.get("/api/state")
    def state() -> dict[str, Any]:
        player = repo().load_state()
        return {
            "state": project_state(player, repo().reviews_today_count()),
            "guardrails": repo().get_config(),
            "srs": _stats_dict(engine().stats()),
        }

    @app.get("/api/decks")
    def decks() -> dict[str, Any]:
        return {"decks": [_deck_dict(d) for d in engine().deck_list()]}

    @app.post("/api/seed-demo")
    def seed_demo(body: SeedDemoRequest) -> dict[str, Any]:
        with coordinator().lock:
            return run_seed(engine(), repo(), deck=body.deck, replace=body.replace)

    @app.post("/api/import")
    async def import_apkg(file: UploadFile = File(...)) -> dict[str, Any]:
        filename = file.filename or ""
        lowered = filename.lower()
        if not (lowered.endswith(".apkg") or lowered.endswith(".colpkg")):
            raise ApiError(
                415,
                "UNSUPPORTED_MEDIA",
                "Only .apkg/.colpkg Anki packages are supported.",
            )

        eng = engine()
        if not hasattr(eng, "import_apkg"):
            raise ApiError(
                501,
                "IMPORT_UNSUPPORTED",
                "The active SRS engine does not support package import.",
            )

        suffix = ".colpkg" if lowered.endswith(".colpkg") else ".apkg"
        fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix="dopamine-import-")
        try:
            # Stream to the temp file in fixed-size chunks, enforcing the cap as
            # we go so an oversized upload is never fully buffered in memory.
            total = 0
            with os.fdopen(fd, "wb") as tmp:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > _MAX_IMPORT_BYTES:
                        raise ApiError(
                            413,
                            "PAYLOAD_TOO_LARGE",
                            f"Package exceeds the {_MAX_IMPORT_BYTES // (1024 * 1024)} MB limit.",
                        )
                    tmp.write(chunk)
            with coordinator().lock:
                summary = eng.import_apkg(tmp_path)
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

        return {
            "imported": {
                "decks": list(summary.decks),
                "notes": summary.notes_imported,
                "cards": summary.cards_imported,
            }
        }

    @app.get("/api/media/{name:path}")
    def media(name: str) -> Response:
        # Reject obvious traversal / absolute paths before hitting the engine.
        if ".." in name or name.startswith("/") or "\\" in name:
            raise ApiError(400, "INVALID_MEDIA_NAME", "Invalid media name.")

        eng = engine()
        opener = getattr(eng, "open_media", None)
        if opener is None:
            raise ApiError(
                404, "MEDIA_NOT_FOUND", "The active SRS engine has no media."
            )

        data = opener(name)
        if data is None:
            raise ApiError(404, "MEDIA_NOT_FOUND", f"No media file named {name!r}.")

        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
        return Response(
            content=data,
            media_type=content_type,
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    @app.put("/api/config")
    def put_config(body: ConfigUpdate) -> dict[str, Any]:
        updates = body.updates()
        try:
            config = repo().set_config(updates)
        except KeyError as exc:
            raise ApiError(422, "INVALID_CONFIG", str(exc))
        return {"config": config}

    @app.post("/api/sync/login")
    def sync_login(body: SyncLoginRequest) -> dict[str, Any]:
        eng = require_sync_engine()
        try:
            with coordinator().lock:
                auth = eng.sync_login(body.username, body.password)
                repo().set_sync_auth(auth["hkey"], auth.get("endpoint", ""))
        except SyncError as exc:
            # Only genuine auth failures are 401; server/protocol sync errors are 502.
            if SyncErrorKind is not None and getattr(exc, "kind", None) == SyncErrorKind.AUTH:
                raise ApiError(401, "SYNC_AUTH_FAILED", str(exc)) from exc
            raise ApiError(502, "SYNC_FAILED", str(exc)) from exc
        except NetworkError as exc:
            raise ApiError(502, "SYNC_FAILED", str(exc)) from exc
        return {"ok": True, "endpoint": auth.get("endpoint", "")}

    @app.post("/api/sync")
    def sync_collection() -> dict[str, Any]:
        eng = require_sync_engine()
        auth = repo().get_sync_auth()
        if auth is None:
            raise ApiError(401, "SYNC_NOT_LOGGED_IN", "Log in to AnkiWeb first.")
        try:
            with coordinator().lock:
                result = eng.sync(auth["hkey"], auth["endpoint"])
                new_endpoint = result.get("endpoint")
                if new_endpoint and new_endpoint != auth["endpoint"]:
                    repo().set_sync_auth(auth["hkey"], new_endpoint)
        except (SyncError, NetworkError) as exc:
            raise ApiError(502, "SYNC_FAILED", str(exc)) from exc
        return result

    @app.post("/api/sync/full")
    def sync_full(body: SyncFullRequest) -> dict[str, Any]:
        # One-shot full sync that OVERWRITES one side. Used to bootstrap a fresh
        # DopaMine collection from an existing AnkiWeb account ("download"), or to
        # push local state up ("upload"). The client must confirm first.
        eng = require_sync_engine()
        auth = repo().get_sync_auth()
        if auth is None:
            raise ApiError(401, "SYNC_NOT_LOGGED_IN", "Log in to AnkiWeb first.")
        try:
            with coordinator().lock:
                result = eng.sync_full(auth["hkey"], auth["endpoint"], body.direction)
        except (SyncError, NetworkError) as exc:
            raise ApiError(502, "SYNC_FAILED", str(exc)) from exc
        return result

    @app.get("/api/sync/status")
    def sync_status() -> dict[str, Any]:
        eng = require_sync_engine()
        auth = repo().get_sync_auth()
        if auth is None:
            return {"logged_in": False}
        result: dict[str, Any] = {"logged_in": True}
        try:
            with coordinator().lock:
                result.update(eng.sync_status(auth["hkey"], auth["endpoint"]))
        except (SyncError, NetworkError) as exc:
            raise ApiError(502, "SYNC_FAILED", str(exc)) from exc
        return result

    @app.post("/api/sync/logout")
    def sync_logout() -> dict[str, bool]:
        require_sync_engine()
        repo().clear_sync_auth()
        return {"ok": True}

    # Serve the built SPA (frontend/dist) same-origin when it exists, so a single
    # `uvicorn --host 0.0.0.0 --port 8000` serves BOTH the API and the app — this
    # is what makes the app reachable from a phone on the LAN at http://<ip>:8000
    # with no separate frontend server, no proxy, and no CORS. Mounted last so the
    # explicit /api/* routes always win. Skips gracefully when unbuilt (dev uses
    # the vite dev server instead).
    dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if dist.is_dir() and (dist / "index.html").exists():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="spa")

    return app


app = create_app()
