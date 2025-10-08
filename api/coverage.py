"""Coverage snapshot API endpoint."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Iterable

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

COVERAGE_ENV_PATH = "COVERAGE_SNAPSHOT_PATH"
COVERAGE_ENV_DIR = "COVERAGE_SNAPSHOT_DIR"


def _candidate_paths() -> Iterable[Path]:
    """Yield possible paths to the coverage snapshot file."""
    env_path = os.environ.get(COVERAGE_ENV_PATH)
    if env_path:
        yield Path(env_path)

    env_dir = os.environ.get(COVERAGE_ENV_DIR)
    if env_dir:
        yield Path(env_dir) / "coverage_snapshot.json"

    base_dir = Path(__file__).resolve().parent.parent
    yield base_dir / "coverage_snapshot.json"
    yield base_dir / "public" / "coverage_snapshot.json"


class CoverageSnapshotNotFound(FileNotFoundError):
    """Raised when no coverage snapshot can be located."""


class CoverageSnapshotInvalid(ValueError):
    """Raised when a coverage snapshot file contains invalid JSON."""


def load_coverage_snapshot() -> dict:
    """Load and return the latest coverage snapshot as a dict.

    The search order prioritises environment overrides before falling back to
    repository defaults. Raises ``CoverageSnapshotNotFound`` if no file is
    available and ``CoverageSnapshotInvalid`` when JSON parsing fails.
    """

    for candidate in _candidate_paths():
        try:
            path = candidate.resolve()
        except OSError:
            continue
        if not path.is_file():
            continue
        try:
            with path.open("r", encoding="utf-8") as fh:
                return json.load(fh)
        except json.JSONDecodeError as exc:  # pragma: no cover - defensive
            raise CoverageSnapshotInvalid(
                f"coverage snapshot at {path} is not valid JSON: {exc}"
            ) from exc
    raise CoverageSnapshotNotFound("coverage_snapshot.json not found")


@app.get("/api/coverage")
async def get_coverage_snapshot() -> JSONResponse:
    """Serve the most recent coverage snapshot as JSON."""

    try:
        snapshot = load_coverage_snapshot()
    except CoverageSnapshotNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except CoverageSnapshotInvalid as exc:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return JSONResponse(
        snapshot,
        headers={"Cache-Control": "no-store, no-cache, max-age=0, must-revalidate"},
    )


__all__ = ["load_coverage_snapshot", "CoverageSnapshotNotFound", "CoverageSnapshotInvalid"]
