"""Select and build the SRS engine from the environment.

``DOPAMINE_SRS_ENGINE`` chooses ``fsrs`` (default) or ``anki``. The Anki engine
is imported lazily so a missing/unbuildable ``anki_lib`` module only fails when
that engine is explicitly requested.
"""

from __future__ import annotations

import os

from app.db import data_dir
from app.srs.base import AnkiEngine


def build_engine() -> AnkiEngine:
    choice = os.environ.get("DOPAMINE_SRS_ENGINE", "fsrs").strip().lower()

    if choice == "fsrs":
        from app.srs.fsrs_sqlite import FsrsSqliteEngine

        return FsrsSqliteEngine(data_dir() / "srs.sqlite3")

    if choice == "anki":
        try:
            from app.srs.anki_lib import AnkiLibEngine  # type: ignore
        except Exception as exc:  # pragma: no cover - depends on optional module
            raise RuntimeError(
                "DOPAMINE_SRS_ENGINE=anki was requested but the Anki engine could "
                "not be loaded (backend/app/srs/anki_lib.py). Install/verify the "
                f"anki package or set DOPAMINE_SRS_ENGINE=fsrs. Root cause: {exc!r}"
            ) from exc
        return AnkiLibEngine(data_dir() / "collection.anki2")  # type: ignore[call-arg]

    raise RuntimeError(
        f"Unknown DOPAMINE_SRS_ENGINE={choice!r}; expected 'fsrs' or 'anki'."
    )
