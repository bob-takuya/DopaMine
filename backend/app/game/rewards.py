"""Deterministic reward resolution with no I/O or ambient randomness."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta
import hashlib
import math
import random
from typing import Any, Literal

from app.srs.base import Rating

RewardType = Literal[
    "xp_awarded",
    "combo_changed",
    "streak_changed",
    "loot_dropped",
    "no_drop",
    "near_miss",
]


@dataclass(frozen=True)
class ReviewEvent:
    review_id: str
    card_id: str
    rating: Rating
    answered_at: datetime
    local_date: str
    rng_seed: str


@dataclass(frozen=True)
class PlayerState:
    total_xp: int = 0
    combo: int = 0
    streak_days: int = 0
    last_active_date: str | None = None
    rare_pity: int = 0
    legendary_pity: int = 0
    inventory: dict[str, int] = field(default_factory=dict)
    session_started_at: datetime | None = None
    session_review_count: int = 0
    version: int = 0

    @property
    def level(self) -> int:
        return level_for_xp(self.total_xp)


@dataclass(frozen=True)
class RewardConfig:
    honest_streak_mode: bool = True
    no_dark_pattern_mode: bool = False


@dataclass(frozen=True)
class RewardEvent:
    event_id: str | None
    review_id: str
    type: RewardType
    created_at: datetime | None
    payload: dict[str, Any]
    event_index: int


_BASE_XP = {1: 4, 2: 8, 3: 10, 4: 12}
_POOLS = {
    "common": ("spark", "slime"),
    "rare": ("neon_cat", "streak_freeze"),
    "epic": ("golden_brain", "glitch_aura"),
    "legendary": ("dopamine_crown",),
}
_TIER_RANK = {"common": 0, "rare": 1, "epic": 2, "legendary": 3}


def level_for_xp(total_xp: int) -> int:
    """Return the derived player level for a non-negative XP total."""
    if total_xp < 0:
        raise ValueError("total_xp must be non-negative")
    return math.isqrt(total_xp // 100) + 1


def _event(review_id: str, kind: RewardType, payload: dict[str, Any], index: int) -> RewardEvent:
    return RewardEvent(None, review_id, kind, None, payload, index)


def _loot_tier(rng: random.Random, rare_pity: int, legendary_pity: int) -> tuple[str | None, bool]:
    if legendary_pity >= 99:
        return "legendary", True

    roll = rng.random()
    if rare_pity >= 19:
        if roll < 0.05:
            return "legendary", True
        if roll < 0.25:
            return "epic", True
        return "rare", True

    # One roll, evaluated from the highest tier downward.
    if roll < 0.002:
        return "legendary", False
    if roll < 0.010:
        return "epic", False
    if roll < 0.040:
        return "rare", False
    if roll < 0.140:
        return "common", False
    return None, False


def resolve_reward(
    review_event: ReviewEvent,
    player_state: PlayerState,
    config: RewardConfig = RewardConfig(),
) -> tuple[PlayerState, list[RewardEvent]]:
    """Resolve one review into a new state and ordered presentation events."""
    if review_event.rating not in _BASE_XP:
        raise ValueError("rating must be one of 1, 2, 3, or 4")
    try:
        active_date = date.fromisoformat(review_event.local_date)
    except ValueError as exc:
        raise ValueError("local_date must be an ISO date (YYYY-MM-DD)") from exc

    seed = int.from_bytes(hashlib.sha256(review_event.rng_seed.encode("utf-8")).digest())
    rng = random.Random(seed)
    multiplier = min(2.0, 1.0 + 0.10 * (player_state.combo // 5))
    xp = math.floor(_BASE_XP[review_event.rating] * multiplier)
    combo = 0 if review_event.rating == 1 else player_state.combo + 1

    events = [
        _event(review_event.review_id, "xp_awarded", {"amount": xp, "multiplier": multiplier}, 0),
        _event(review_event.review_id, "combo_changed", {"combo": combo}, 1),
    ]

    inventory = dict(player_state.inventory)
    streak = player_state.streak_days
    last_active = player_state.last_active_date
    freeze_consumed = False
    streak_changed = False
    if last_active is None:
        streak, streak_changed = 1, True
    else:
        previous_date = date.fromisoformat(last_active)
        if active_date > previous_date:
            streak_changed = True
            if active_date == previous_date + timedelta(days=1):
                streak += 1
            elif not config.honest_streak_mode and inventory.get("streak_freeze", 0) > 0:
                inventory["streak_freeze"] -= 1
                if inventory["streak_freeze"] == 0:
                    del inventory["streak_freeze"]
                freeze_consumed = True
                # A freeze protects the existing streak; this study day continues it.
                streak += 1
            else:
                streak = 1
    if streak_changed:
        events.append(
            _event(
                review_event.review_id,
                "streak_changed",
                {"streak_days": streak, "freeze_consumed": freeze_consumed},
                len(events),
            )
        )

    tier, pity_forced = _loot_tier(rng, player_state.rare_pity, player_state.legendary_pity)
    rare_pity = 0 if tier is not None and _TIER_RANK[tier] >= _TIER_RANK["rare"] else player_state.rare_pity + 1
    legendary_pity = 0 if tier == "legendary" else player_state.legendary_pity + 1

    if tier is not None:
        pool = _POOLS[tier]
        item = pool[rng.randrange(len(pool))]
        awarded = not (item == "streak_freeze" and config.honest_streak_mode)
        if awarded:
            inventory[item] = inventory.get(item, 0) + 1
        events.append(
            _event(
                review_event.review_id,
                "loot_dropped",
                {"tier": tier, "item": item, "pity_forced": pity_forced, "awarded": awarded},
                len(events),
            )
        )
    else:
        near_miss_probability = min(0.25, 0.05 + 0.01 * rare_pity)
        if not config.no_dark_pattern_mode and rng.random() < near_miss_probability:
            kind: RewardType = "near_miss"
            payload = {"truth": "no_drop", "teased_tier": "rare"}
        else:
            kind = "no_drop"
            payload = {"truth": "no_drop"}
        events.append(_event(review_event.review_id, kind, payload, len(events)))

    new_state = replace(
        player_state,
        total_xp=player_state.total_xp + xp,
        combo=combo,
        streak_days=streak,
        last_active_date=review_event.local_date if last_active is None or active_date >= date.fromisoformat(last_active) else last_active,
        rare_pity=rare_pity,
        legendary_pity=legendary_pity,
        inventory=inventory,
        session_started_at=player_state.session_started_at or review_event.answered_at,
        session_review_count=player_state.session_review_count + 1,
        version=player_state.version + 1,
    )
    return new_state, events
