"""FastAPI application: routes, engine selection, write lock, guardrails."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.db import migrate
from app.demo import run_seed
from app.engine_factory import build_engine
from app.errors import ApiError
from app.repository import Repository
from app.schemas import (
    AnswerRequest,
    ConfigUpdate,
    SeedDemoRequest,
)
from app.services.review import ReviewCoordinator, project_state
from app.srs.base import CardView, DeckInfo, SrsStats


def _iso(value: datetime | None) -> Optional[str]:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat()


def _card_dict(card: CardView) -> dict[str, Any]:
    return {
        "card_id": card.card_id,
        "note_id": card.note_id,
        "deck": card.deck,
        "front_html": card.front_html,
        "back_html": card.back_html,
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

    @app.put("/api/config")
    def put_config(body: ConfigUpdate) -> dict[str, Any]:
        updates = body.updates()
        try:
            config = repo().set_config(updates)
        except KeyError as exc:
            raise ApiError(422, "INVALID_CONFIG", str(exc))
        return {"config": config}

    return app


app = create_app()
