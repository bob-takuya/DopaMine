"""Fixed demo deck: 10 bilingual brainrot Basic notes for POST /api/seed-demo."""

from __future__ import annotations

from typing import Any

from app.repository import Repository
from app.srs.base import AnkiEngine

SEED_NAME = "dopamine-demo"
SEED_VERSION = 1
DEMO_DECK = "DopaMine Demo"
DEMO_TAG = "dopamine-demo"

# (Front, Back) — a fun bilingual / internet-brainrot flashcard set.
DEMO_NOTES: list[tuple[str, str]] = [
    ("犬 (inu)", "dog 🐶"),
    ("猫 (neko)", "cat 🐱"),
    ("¿Qué significa 'rizz'?", "charisma / game (skibidi-tier social skill)"),
    ("Gato in Spanish means…", "cat 🐈"),
    ("water in Japanese (水)", "mizu 💧"),
    ("'sigma' energy translates to…", "lone-wolf main-character vibes"),
    ("Bonjour means…", "hello 👋 (French)"),
    ("火 (hi)", "fire 🔥 (also: 'this card is fire')"),
    ("'no cap' means…", "no lie / for real fr fr"),
    ("Danke means…", "thank you 🙏 (German)"),
]


def run_seed(
    engine: AnkiEngine,
    repo: Repository,
    deck: str = DEMO_DECK,
    replace: bool = False,
) -> dict[str, Any]:
    """Idempotently add the fixed demo notes; return a seed-demo response dict."""
    existing_run = repo.get_seed_run(SEED_NAME)
    if existing_run is not None and not replace:
        card_ids = existing_run["note_ids"]
        return {
            "deck": deck,
            "created": 0,
            "existing": len(card_ids),
            "card_ids": card_ids,
        }

    previously = len(existing_run["note_ids"]) if existing_run else 0
    card_ids: list[str] = []
    for front, back in DEMO_NOTES:
        created = engine.add_note(
            deck, {"Front": front, "Back": back}, tags=[DEMO_TAG], model="Basic"
        )
        card_ids.extend(created)

    repo.record_seed_run(SEED_NAME, SEED_VERSION, card_ids)
    return {
        "deck": deck,
        "created": len(card_ids),
        "existing": previously,
        "card_ids": card_ids,
    }
