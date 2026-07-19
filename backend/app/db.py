"""SQLite persistence for gamification state (game.sqlite3).

Owns migrations for the tables defined in ARCHITECTURE.md §7. Foreign keys are
enabled on every connection. The data directory is taken from the
``DOPAMINE_DATA_DIR`` environment variable and defaults to ``backend/data``.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

_MIGRATIONS = """
CREATE TABLE IF NOT EXISTS player_state (
  player_id TEXT PRIMARY KEY,
  total_xp INTEGER NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
  combo INTEGER NOT NULL DEFAULT 0 CHECK (combo >= 0),
  streak_days INTEGER NOT NULL DEFAULT 0 CHECK (streak_days >= 0),
  last_active_date TEXT,
  rare_pity INTEGER NOT NULL DEFAULT 0,
  legendary_pity INTEGER NOT NULL DEFAULT 0,
  inventory_json TEXT NOT NULL DEFAULT '{}',
  session_started_at TEXT,
  session_review_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reviews (
  review_id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  answered_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  rng_seed TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  srs_result_json TEXT,
  response_json TEXT
);

CREATE TABLE IF NOT EXISTS reward_events (
  event_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  event_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (review_id, event_index)
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seed_runs (
  seed_name TEXT PRIMARY KEY,
  seed_version INTEGER NOT NULL,
  note_ids_json TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS reviews_status_idx ON reviews(status);
CREATE INDEX IF NOT EXISTS reviews_local_date_idx ON reviews(local_date);
"""


def data_dir() -> Path:
    """Return the resolved data directory, creating it if necessary."""
    raw = os.environ.get("DOPAMINE_DATA_DIR")
    if raw:
        path = Path(raw)
    else:
        path = Path(__file__).resolve().parents[1] / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def game_db_path() -> Path:
    return data_dir() / "game.sqlite3"


def get_conn(db_path: str | Path | None = None) -> sqlite3.Connection:
    """Open a connection to game.sqlite3 with row factory and FKs enabled."""
    path = Path(db_path) if db_path is not None else game_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def migrate(db_path: str | Path | None = None) -> None:
    """Create all tables if they do not exist."""
    with get_conn(db_path) as conn:
        conn.executescript(_MIGRATIONS)
