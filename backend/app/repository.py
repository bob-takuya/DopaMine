"""Persistence layer over game.sqlite3.

Translates between the pure domain values (``PlayerState``, ``RewardEvent``,
``AnswerResult``) and their SQLite rows, owns config defaults, and provides the
pending -> complete review lifecycle plus recovery.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.db import get_conn
from app.game.rewards import PlayerState, RewardConfig, RewardEvent
from app.srs.base import AnswerResult

PLAYER_ID = "local"

DEFAULT_CONFIG: dict[str, Any] = {
    "timezone": "Asia/Tokyo",
    "session_length_cap_minutes": 20,
    "honest_streak_mode": True,
    "no_dark_pattern_mode": False,
    "sound_enabled": True,
    "haptics_enabled": False,
}

# Fields that PUT /api/config is allowed to mutate.
CONFIG_KEYS = tuple(DEFAULT_CONFIG.keys())

_SYNC_HKEY_KEY = "_ankiweb_hkey"
_SYNC_ENDPOINT_KEY = "_ankiweb_endpoint"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        raise ValueError("datetime must be timezone-aware")
    return value.astimezone(timezone.utc).isoformat()


def _dt(value: str | None) -> datetime | None:
    if value is None:
        return None
    return datetime.fromisoformat(value).astimezone(timezone.utc)


@dataclass(frozen=True)
class ReviewRow:
    review_id: str
    card_id: str
    rating: int
    answered_at: str
    local_date: str
    rng_seed: str
    status: str
    srs_result_json: str | None
    response_json: str | None


class Repository:
    def __init__(self, db_path: str | Path | None = None) -> None:
        self.db_path = db_path

    def _conn(self) -> sqlite3.Connection:
        return get_conn(self.db_path)

    # ----- player state --------------------------------------------------
    def load_state(self) -> PlayerState:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM player_state WHERE player_id = ?", (PLAYER_ID,)
            ).fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO player_state (player_id) VALUES (?)", (PLAYER_ID,)
                )
                row = conn.execute(
                    "SELECT * FROM player_state WHERE player_id = ?", (PLAYER_ID,)
                ).fetchone()
        return PlayerState(
            total_xp=row["total_xp"],
            combo=row["combo"],
            streak_days=row["streak_days"],
            last_active_date=row["last_active_date"],
            rare_pity=row["rare_pity"],
            legendary_pity=row["legendary_pity"],
            inventory=json.loads(row["inventory_json"]),
            session_started_at=_dt(row["session_started_at"]),
            session_review_count=row["session_review_count"],
            version=row["version"],
        )

    def save_state(self, state: PlayerState) -> None:
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO player_state (
                    player_id, total_xp, combo, streak_days, last_active_date,
                    rare_pity, legendary_pity, inventory_json,
                    session_started_at, session_review_count, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(player_id) DO UPDATE SET
                    total_xp=excluded.total_xp,
                    combo=excluded.combo,
                    streak_days=excluded.streak_days,
                    last_active_date=excluded.last_active_date,
                    rare_pity=excluded.rare_pity,
                    legendary_pity=excluded.legendary_pity,
                    inventory_json=excluded.inventory_json,
                    session_started_at=excluded.session_started_at,
                    session_review_count=excluded.session_review_count,
                    version=excluded.version
                """,
                (
                    PLAYER_ID,
                    state.total_xp,
                    state.combo,
                    state.streak_days,
                    state.last_active_date,
                    state.rare_pity,
                    state.legendary_pity,
                    json.dumps(state.inventory),
                    _iso(state.session_started_at),
                    state.session_review_count,
                    state.version,
                ),
            )

    # ----- config --------------------------------------------------------
    def get_config(self) -> dict[str, Any]:
        effective = dict(DEFAULT_CONFIG)
        with self._conn() as conn:
            rows = conn.execute("SELECT key, value_json FROM config").fetchall()
        for row in rows:
            if row["key"] in DEFAULT_CONFIG:
                effective[row["key"]] = json.loads(row["value_json"])
        return effective

    def set_config(self, updates: dict[str, Any]) -> dict[str, Any]:
        now = _now_iso()
        with self._conn() as conn:
            for key, value in updates.items():
                if key not in DEFAULT_CONFIG:
                    raise KeyError(f"unknown config key: {key}")
                conn.execute(
                    """
                    INSERT INTO config (key, value_json, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value_json=excluded.value_json,
                        updated_at=excluded.updated_at
                    """,
                    (key, json.dumps(value), now),
                )
        return self.get_config()

    def set_sync_auth(self, hkey: str, endpoint: str) -> None:
        now = _now_iso()
        with self._conn() as conn:
            for key, value in (
                (_SYNC_HKEY_KEY, hkey),
                (_SYNC_ENDPOINT_KEY, endpoint),
            ):
                conn.execute(
                    """
                    INSERT INTO config (key, value_json, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value_json=excluded.value_json,
                        updated_at=excluded.updated_at
                    """,
                    (key, json.dumps(value), now),
                )

    def get_sync_auth(self) -> dict[str, str] | None:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT key, value_json FROM config WHERE key IN (?, ?)",
                (_SYNC_HKEY_KEY, _SYNC_ENDPOINT_KEY),
            ).fetchall()
        values = {row["key"]: json.loads(row["value_json"]) for row in rows}
        hkey = values.get(_SYNC_HKEY_KEY)
        if not hkey:
            return None
        return {"hkey": hkey, "endpoint": values.get(_SYNC_ENDPOINT_KEY, "")}

    def clear_sync_auth(self) -> None:
        with self._conn() as conn:
            conn.execute(
                "DELETE FROM config WHERE key IN (?, ?)",
                (_SYNC_HKEY_KEY, _SYNC_ENDPOINT_KEY),
            )

    def reward_config(self) -> RewardConfig:
        cfg = self.get_config()
        return RewardConfig(
            honest_streak_mode=bool(cfg["honest_streak_mode"]),
            no_dark_pattern_mode=bool(cfg["no_dark_pattern_mode"]),
        )

    def reviews_today_count(self) -> int:
        """Reviews recorded on *today's* local calendar day (configured tz).

        Derived from the reviews table by ``local_date`` rather than a running
        session counter, so it stays correct across a local-date rollover.
        """
        from zoneinfo import ZoneInfo

        cfg = self.get_config()
        try:
            tz = ZoneInfo(cfg["timezone"])
        except Exception:
            tz = timezone.utc
        today = datetime.now(tz).date().isoformat()
        with self._conn() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM reviews WHERE local_date = ?", (today,)
            ).fetchone()
        return int(row["n"]) if row is not None else 0

    # ----- reviews -------------------------------------------------------
    def get_review(self, review_id: str) -> ReviewRow | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM reviews WHERE review_id = ?", (review_id,)
            ).fetchone()
        if row is None:
            return None
        return ReviewRow(**{k: row[k] for k in row.keys()})

    def insert_pending(
        self,
        review_id: str,
        card_id: str,
        rating: int,
        answered_at: datetime,
        local_date: str,
        rng_seed: str,
    ) -> None:
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO reviews (
                    review_id, card_id, rating, answered_at,
                    local_date, rng_seed, status
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
                """,
                (review_id, card_id, rating, _iso(answered_at), local_date, rng_seed),
            )

    def set_srs_result(self, review_id: str, result: AnswerResult) -> None:
        payload = {
            "card_id": result.card_id,
            "rating": result.rating,
            "answered_at": _iso(result.answered_at),
            "next_due_at": _iso(result.next_due_at),
            "interval_days": result.interval_days,
        }
        with self._conn() as conn:
            conn.execute(
                "UPDATE reviews SET srs_result_json = ?, answered_at = ? WHERE review_id = ?",
                (json.dumps(payload), _iso(result.answered_at), review_id),
            )

    @staticmethod
    def srs_result_from_json(raw: str) -> AnswerResult:
        data = json.loads(raw)
        return AnswerResult(
            card_id=data["card_id"],
            rating=data["rating"],
            answered_at=_dt(data["answered_at"]),
            next_due_at=_dt(data["next_due_at"]),
            interval_days=data["interval_days"],
        )

    def delete_review(self, review_id: str) -> None:
        with self._conn() as conn:
            conn.execute("DELETE FROM reward_events WHERE review_id = ?", (review_id,))
            conn.execute("DELETE FROM reviews WHERE review_id = ?", (review_id,))

    def finalize_review(
        self,
        review_id: str,
        state: PlayerState,
        events: list[RewardEvent],
        response: dict[str, Any],
    ) -> None:
        """Persist events, save state, and mark the review complete atomically."""
        now = _now_iso()
        with self._conn() as conn:
            for event in events:
                conn.execute(
                    """
                    INSERT INTO reward_events (
                        event_id, review_id, event_index, type, payload_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(review_id, event_index) DO NOTHING
                    """,
                    (
                        event.event_id,
                        review_id,
                        event.event_index,
                        event.type,
                        json.dumps(event.payload),
                        now,
                    ),
                )
            conn.execute(
                """
                INSERT INTO player_state (
                    player_id, total_xp, combo, streak_days, last_active_date,
                    rare_pity, legendary_pity, inventory_json,
                    session_started_at, session_review_count, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(player_id) DO UPDATE SET
                    total_xp=excluded.total_xp,
                    combo=excluded.combo,
                    streak_days=excluded.streak_days,
                    last_active_date=excluded.last_active_date,
                    rare_pity=excluded.rare_pity,
                    legendary_pity=excluded.legendary_pity,
                    inventory_json=excluded.inventory_json,
                    session_started_at=excluded.session_started_at,
                    session_review_count=excluded.session_review_count,
                    version=excluded.version
                """,
                (
                    PLAYER_ID,
                    state.total_xp,
                    state.combo,
                    state.streak_days,
                    state.last_active_date,
                    state.rare_pity,
                    state.legendary_pity,
                    json.dumps(state.inventory),
                    _iso(state.session_started_at),
                    state.session_review_count,
                    state.version,
                ),
            )
            conn.execute(
                "UPDATE reviews SET status = 'complete', response_json = ? WHERE review_id = ?",
                (json.dumps(response), review_id),
            )

    def pending_reviews(self) -> list[ReviewRow]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM reviews WHERE status = 'pending' ORDER BY answered_at"
            ).fetchall()
        return [ReviewRow(**{k: r[k] for k in r.keys()}) for r in rows]

    # ----- seed runs -----------------------------------------------------
    def get_seed_run(self, seed_name: str) -> dict[str, Any] | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM seed_runs WHERE seed_name = ?", (seed_name,)
            ).fetchone()
        if row is None:
            return None
        return {
            "seed_name": row["seed_name"],
            "seed_version": row["seed_version"],
            "note_ids": json.loads(row["note_ids_json"]),
            "applied_at": row["applied_at"],
        }

    def record_seed_run(
        self, seed_name: str, seed_version: int, card_ids: list[str]
    ) -> None:
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO seed_runs (seed_name, seed_version, note_ids_json, applied_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(seed_name) DO UPDATE SET
                    seed_version=excluded.seed_version,
                    note_ids_json=excluded.note_ids_json,
                    applied_at=excluded.applied_at
                """,
                (seed_name, seed_version, json.dumps(card_ids), _now_iso()),
            )
