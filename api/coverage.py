"""Coverage snapshot API endpoint."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Iterable, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

COVERAGE_ENV_PATH = "COVERAGE_SNAPSHOT_PATH"
COVERAGE_ENV_DIR = "COVERAGE_SNAPSHOT_DIR"
ALERTS_ENV_PATH = "COVERAGE_ALERTS_PATH"
ALERTS_ENV_DIR = "COVERAGE_ALERTS_DIR"


def _candidate_paths(
    filename: str,
    env_path_var: Optional[str] = None,
    env_dir_var: Optional[str] = None,
) -> Iterable[Path]:
    """Yield possible paths for a coverage artefact."""

    if env_path_var:
        env_path = os.environ.get(env_path_var)
        if env_path:
            yield Path(env_path)

    if env_dir_var:
        env_dir = os.environ.get(env_dir_var)
        if env_dir:
            yield Path(env_dir) / filename

    base_dir = Path(__file__).resolve().parent.parent
    yield base_dir / filename
    yield base_dir / "public" / filename
    yield base_dir / "stage2" / "data" / filename


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

    for candidate in _candidate_paths(
        "coverage_snapshot.json",
        env_path_var=COVERAGE_ENV_PATH,
        env_dir_var=COVERAGE_ENV_DIR,
    ):
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


class CoverageAlertsNotFound(FileNotFoundError):
    """Raised when the alerts feed cannot be located."""


class CoverageAlertsInvalid(ValueError):
    """Raised when the alerts feed contains invalid JSON."""


def load_coverage_alerts() -> dict:
    """Load and return the persisted coverage alerts feed."""

    for candidate in _candidate_paths(
        "alerts.json",
        env_path_var=ALERTS_ENV_PATH,
        env_dir_var=ALERTS_ENV_DIR,
    ):
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
            raise CoverageAlertsInvalid(f"alerts feed at {path} is not valid JSON: {exc}") from exc
    raise CoverageAlertsNotFound("alerts.json not found")


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


@app.get("/api/coverage/alerts")
async def get_coverage_alerts() -> JSONResponse:
    """Serve the recent coverage alerts feed as JSON."""

    try:
        alerts = load_coverage_alerts()
    except CoverageAlertsNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except CoverageAlertsInvalid as exc:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return JSONResponse(
        alerts,
        headers={"Cache-Control": "no-store, no-cache, max-age=0, must-revalidate"},
    )


__all__ = [
    "load_coverage_snapshot",
    "CoverageSnapshotNotFound",
    "CoverageSnapshotInvalid",
    "load_coverage_alerts",
    "CoverageAlertsNotFound",
    "CoverageAlertsInvalid",
]
