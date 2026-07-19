"""Answer coordinator: write-lock, idempotency, and pending->complete flow.

One application-level lock serializes the SRS answer and the game update. Because
the two SQLite files cannot share a transaction, the coordinator inserts a
``pending`` game review, commits the SRS answer, stores its result, then resolves
rewards and marks the review ``complete``. Startup recovery finalizes any pending
review from its stored SRS result without answering twice.
"""

from __future__ import annotations

import hashlib
import hmac
import threading
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from app.errors import ApiError
from app.game.rewards import PlayerState, ReviewEvent, RewardEvent, resolve_reward
from app.repository import Repository, ReviewRow
from app.srs.base import AnkiEngine, AnswerResult


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat()


def project_state(state: PlayerState, reviews_today: int | None = None) -> dict[str, Any]:
    """Project canonical player state into the API response shape.

    ``reviews_today`` is a local-date-accurate count supplied by the caller
    (from the reviews table); it falls back to the session counter only when a
    count is not available.
    """
    return {
        "total_xp": state.total_xp,
        "level": state.level,
        "combo": state.combo,
        "streak_days": state.streak_days,
        "rare_pity": state.rare_pity,
        "legendary_pity": state.legendary_pity,
        "inventory": dict(state.inventory),
        "reviews_today": state.session_review_count if reviews_today is None else reviews_today,
        "session_started_at": _iso(state.session_started_at),
        "session_review_count": state.session_review_count,
        "version": state.version,
    }


def _srs_dict(result: AnswerResult) -> dict[str, Any]:
    return {
        "card_id": result.card_id,
        "rating": result.rating,
        "answered_at": _iso(result.answered_at),
        "next_due_at": _iso(result.next_due_at),
        "interval_days": result.interval_days,
    }


def _rewards_list(events: list[RewardEvent]) -> list[dict[str, Any]]:
    return [
        {"event_id": e.event_id, "type": e.type, "payload": e.payload} for e in events
    ]


class ReviewCoordinator:
    def __init__(
        self, engine: AnkiEngine, repo: Repository, server_secret: str
    ) -> None:
        self.engine = engine
        self.repo = repo
        self.server_secret = server_secret.encode("utf-8")
        self.lock = threading.Lock()

    # ----- helpers -------------------------------------------------------
    def _rng_seed(self, review_id: str) -> str:
        return hmac.new(
            self.server_secret, review_id.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def _local_date(self, moment: datetime) -> str:
        cfg = self.repo.get_config()
        try:
            tz = ZoneInfo(cfg["timezone"])
        except Exception:
            tz = timezone.utc
        return moment.astimezone(tz).date().isoformat()

    def _build_response(
        self, review_id: str, result: AnswerResult, events: list[RewardEvent], state: PlayerState
    ) -> dict[str, Any]:
        return {
            "review_id": review_id,
            "srs": _srs_dict(result),
            "rewards": _rewards_list(events),
            "state": project_state(state, self.repo.reviews_today_count()),
        }

    def _stamp_events(self, review_id: str, events: list[RewardEvent]) -> list[RewardEvent]:
        now = datetime.now(timezone.utc)
        stamped: list[RewardEvent] = []
        for event in events:
            stamped.append(
                replace(
                    event,
                    event_id=f"{review_id}_{event.event_index:02d}",
                    created_at=now,
                )
            )
        return stamped

    def _finalize(self, review: ReviewRow) -> dict[str, Any]:
        """Resolve rewards for a review whose SRS result is already stored."""
        assert review.srs_result_json is not None
        result = Repository.srs_result_from_json(review.srs_result_json)
        state = self.repo.load_state()
        review_event = ReviewEvent(
            review_id=review.review_id,
            card_id=review.card_id,
            rating=review.rating,
            answered_at=result.answered_at,
            local_date=review.local_date,
            rng_seed=review.rng_seed,
        )
        new_state, events = resolve_reward(
            review_event, state, self.repo.reward_config()
        )
        events = self._stamp_events(review.review_id, events)
        response = self._build_response(review.review_id, result, events, new_state)
        self.repo.finalize_review(review.review_id, new_state, events, response)
        return response

    # ----- session cap ---------------------------------------------------
    def _check_session_cap(self, state: PlayerState) -> None:
        cfg = self.repo.get_config()
        cap = cfg.get("session_length_cap_minutes")
        if cap is None or state.session_started_at is None:
            return
        elapsed = datetime.now(timezone.utc) - state.session_started_at
        if elapsed.total_seconds() >= cap * 60:
            raise ApiError(
                429,
                "SESSION_CAP_REACHED",
                f"Session length cap of {cap} minutes reached. Start a new session to continue.",
            )

    # ----- public API ----------------------------------------------------
    def recover_pending(self) -> int:
        """Finalize/roll back pending reviews left by a crash. Returns count handled."""
        handled = 0
        with self.lock:
            for review in self.repo.pending_reviews():
                if review.srs_result_json is not None:
                    self._finalize(review)
                else:
                    # SRS answer never confirmed; roll back so the client can retry.
                    self.repo.delete_review(review.review_id)
                handled += 1
        return handled

    def answer(self, review_id: str, card_id: str, rating: int) -> dict[str, Any]:
        with self.lock:
            existing = self.repo.get_review(review_id)
            if existing is not None:
                if existing.card_id != card_id or existing.rating != rating:
                    raise ApiError(
                        409,
                        "REVIEW_ID_CONFLICT",
                        "review_id already used with a different card_id/rating.",
                    )
                if existing.status == "complete" and existing.response_json:
                    import json

                    return json.loads(existing.response_json)
                # Pending replay: finalize if we already have the SRS result.
                if existing.srs_result_json is not None:
                    return self._finalize(existing)
                # Otherwise fall through and re-run the SRS answer.
                self.repo.delete_review(review_id)

            state = self.repo.load_state()
            self._check_session_cap(state)

            answered_at = datetime.now(timezone.utc)
            local_date = self._local_date(answered_at)
            rng_seed = self._rng_seed(review_id)

            self.repo.insert_pending(
                review_id, card_id, rating, answered_at, local_date, rng_seed
            )

            try:
                result = self.engine.answer_card(card_id, rating)
            except KeyError:
                self.repo.delete_review(review_id)
                raise ApiError(
                    409, "CARD_NOT_FOUND", f"Card {card_id} does not exist."
                )
            except ValueError as exc:
                self.repo.delete_review(review_id)
                raise ApiError(409, "CARD_NOT_ANSWERABLE", str(exc))

            self.repo.set_srs_result(review_id, result)

            review_event = ReviewEvent(
                review_id=review_id,
                card_id=card_id,
                rating=rating,
                answered_at=result.answered_at,
                local_date=local_date,
                rng_seed=rng_seed,
            )
            new_state, events = resolve_reward(
                review_event, state, self.repo.reward_config()
            )
            events = self._stamp_events(review_id, events)
            response = self._build_response(review_id, result, events, new_state)
            self.repo.finalize_review(review_id, new_state, events, response)
            return response
