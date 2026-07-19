from datetime import datetime, timezone

import pytest

from app.game.rewards import PlayerState, ReviewEvent, RewardConfig, level_for_xp, resolve_reward


def review(seed="seed", rating=3, day="2026-07-19", number=1):
    return ReviewEvent(f"r{number}", "c1", rating, datetime(2026, 7, 19, tzinfo=timezone.utc), day, seed)


def test_determinism_and_input_is_not_mutated() -> None:
    state = PlayerState(inventory={"spark": 1})
    first = resolve_reward(review(), state)
    second = resolve_reward(review(), state)
    assert first == second
    assert state == PlayerState(inventory={"spark": 1})


def test_combo_growth_and_again_reset() -> None:
    state, _ = resolve_reward(review(rating=3), PlayerState(combo=4))
    assert state.combo == 5
    state, _ = resolve_reward(review(rating=1), state)
    assert state.combo == 0


@pytest.mark.parametrize("xp, level", [(0, 1), (99, 1), (100, 2), (399, 2), (400, 3), (899, 3), (900, 4)])
def test_level_boundaries(xp, level) -> None:
    assert level_for_xp(xp) == level
    assert PlayerState(total_xp=xp).level == level


def test_streak_increment_same_day_and_gap_reset() -> None:
    state = PlayerState(streak_days=2, last_active_date="2026-07-18")
    state, events = resolve_reward(review(day="2026-07-19"), state)
    assert state.streak_days == 3
    assert [e.type for e in events].count("streak_changed") == 1
    state, events = resolve_reward(review(day="2026-07-19", number=2), state)
    assert state.streak_days == 3
    assert "streak_changed" not in [e.type for e in events]
    state, _ = resolve_reward(review(day="2026-07-22", number=3), state)
    assert state.streak_days == 1


def test_freeze_consumption_depends_on_honest_mode() -> None:
    initial = PlayerState(streak_days=5, last_active_date="2026-07-17", inventory={"streak_freeze": 1})
    honest, _ = resolve_reward(review(day="2026-07-19"), initial, RewardConfig(honest_streak_mode=True))
    assert (honest.streak_days, honest.inventory.get("streak_freeze")) == (1, 1)
    protected, events = resolve_reward(review(day="2026-07-19"), initial, RewardConfig(honest_streak_mode=False))
    assert (protected.streak_days, protected.inventory.get("streak_freeze", 0)) == (6, 0)
    assert next(e for e in events if e.type == "streak_changed").payload["freeze_consumed"] is True


def test_rare_and_legendary_pity_force_on_20th_and_100th() -> None:
    rare_state, rare_events = resolve_reward(review(), PlayerState(rare_pity=19))
    rare_loot = rare_events[-1]
    assert rare_loot.type == "loot_dropped"
    assert rare_loot.payload["tier"] in {"rare", "epic", "legendary"}
    assert rare_loot.payload["pity_forced"] is True
    assert rare_state.rare_pity == 0

    legendary_state, legendary_events = resolve_reward(review(), PlayerState(legendary_pity=99))
    assert legendary_events[-1].payload["tier"] == "legendary"
    assert legendary_state.legendary_pity == 0


def test_no_dark_pattern_never_emits_near_miss() -> None:
    for number in range(100):
        _, events = resolve_reward(review(seed=f"seed-{number}"), PlayerState(), RewardConfig(no_dark_pattern_mode=True))
        assert events[-1].type != "near_miss"


def test_xp_math_and_event_ordering() -> None:
    state, events = resolve_reward(review(rating=4), PlayerState(total_xp=90, combo=10))
    assert state.total_xp == 104
    assert events[0].type == "xp_awarded"
    assert events[0].payload == {"amount": 14, "multiplier": 1.2}
    assert events[1].type == "combo_changed"
    assert [event.event_index for event in events] == list(range(len(events)))
    assert events[-1].type in {"loot_dropped", "no_drop", "near_miss"}
