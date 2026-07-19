"""Pydantic request/response models for the REST contract (ARCHITECTURE §5)."""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


# ----- requests ---------------------------------------------------------
class AnswerRequest(BaseModel):
    review_id: str = Field(min_length=1)
    card_id: str = Field(min_length=1)
    rating: Literal[1, 2, 3, 4]


class SeedDemoRequest(BaseModel):
    deck: str = "DopaMine Demo"
    replace: bool = False


class SyncLoginRequest(BaseModel):
    model_config = {"extra": "forbid"}
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


class ConfigUpdate(BaseModel):
    """Only guardrail / settings fields may be updated."""

    model_config = {"extra": "forbid"}

    timezone: Optional[str] = None
    session_length_cap_minutes: Optional[int] = Field(default=None, ge=0)
    honest_streak_mode: Optional[bool] = None
    no_dark_pattern_mode: Optional[bool] = None
    sound_enabled: Optional[bool] = None
    haptics_enabled: Optional[bool] = None

    def updates(self) -> dict[str, Any]:
        return {k: v for k, v in self.model_dump().items() if v is not None}


# ----- responses --------------------------------------------------------
class CardModel(BaseModel):
    card_id: str
    note_id: str
    deck: str
    front_html: str
    back_html: str
    tags: list[str]
    due_at: Optional[str]


class NextCardResponse(BaseModel):
    card: Optional[CardModel]
    server_time: str


class SrsModel(BaseModel):
    card_id: str
    rating: int
    answered_at: str
    next_due_at: str
    interval_days: float


class RewardEventModel(BaseModel):
    event_id: str
    type: str
    payload: dict[str, Any]


class StateModel(BaseModel):
    total_xp: int
    level: int
    combo: int
    streak_days: int
    rare_pity: int
    legendary_pity: int
    inventory: dict[str, int]
    reviews_today: int
    session_started_at: Optional[str]
    session_review_count: int
    version: int


class AnswerResponse(BaseModel):
    review_id: str
    srs: SrsModel
    rewards: list[RewardEventModel]
    state: StateModel


class SrsStatsModel(BaseModel):
    due_now: int
    reviewed_today: int
    total_cards: int
    retention: Optional[float]


class StateResponse(BaseModel):
    state: StateModel
    guardrails: dict[str, Any]
    srs: SrsStatsModel


class DeckModel(BaseModel):
    name: str
    due_count: int
    total_count: int


class DecksResponse(BaseModel):
    decks: list[DeckModel]


class SeedDemoResponse(BaseModel):
    deck: str
    created: int
    existing: int
    card_ids: list[str]


class ConfigResponse(BaseModel):
    config: dict[str, Any]


class ErrorBody(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorBody
