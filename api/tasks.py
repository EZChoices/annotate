from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from typing import Dict, Any, List, Optional, Tuple
from pathlib import Path
import json
import os
import random
from datetime import timedelta
from urllib.parse import quote

import requests
from datetime import datetime, timezone

def _stamp():
    return datetime.utcnow().replace(tzinfo=timezone.utc).isoformat()

def _dbg(msg, **kw):
    safe = {k: ("<hidden>" if k.lower().endswith("key") else v) for k, v in kw.items()}
    print(f"[tasks] {_stamp()} :: {msg} :: {safe}")

from api.coverage import (
    CoverageSnapshotInvalid,
    CoverageSnapshotNotFound,
    load_coverage_snapshot,
)

app = FastAPI()

# Env: Supabase and Bunny (flexible names)
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_SERVICE_KEY")
    or os.environ.get("SUPABASE_ANON_KEY")
)
KEEP_TABLE = os.environ.get("SUPABASE_KEEP_TABLE", "keep")
FILE_COL = os.environ.get("SUPABASE_FILE_COL", "file_name")
DECISION_COL = os.environ.get("SUPABASE_DECISION_COL", "decision")
KEEP_VALUE = os.environ.get("SUPABASE_KEEP_VALUE", "keep")
# Optional prefill column names in the keep table
PREFILL_DIA = os.environ.get("SUPABASE_KEEP_DIA_RTTM_COL")
PREFILL_TR_VTT = os.environ.get("SUPABASE_KEEP_TR_VTT_COL")
PREFILL_TR_CTM = os.environ.get("SUPABASE_KEEP_TR_CTM_COL")
PREFILL_TL_VTT = os.environ.get("SUPABASE_KEEP_TL_VTT_COL")
PREFILL_CS_VTT = os.environ.get("SUPABASE_KEEP_CS_VTT_COL")

# Provide default column names if env vars are missing
if not PREFILL_DIA:
    PREFILL_DIA = "diarization_rttm_url"
if not PREFILL_TR_VTT:
    PREFILL_TR_VTT = "transcript_vtt_url"
if not PREFILL_TL_VTT:
    PREFILL_TL_VTT = "translation_vtt_url"
if not PREFILL_CS_VTT:
    PREFILL_CS_VTT = "code_switch_vtt_url"

# Stage2 assignment tracking (to avoid duplicates across annotators)
ASSIGN2_TABLE = os.environ.get("SUPABASE_ASSIGN_STAGE2_TABLE", "clip_assignments_stage2")
ASSIGN2_FILE_COL = os.environ.get("SUPABASE_ASSIGN_STAGE2_FILE_COL", "file_name")
ASSIGN2_USER_COL = os.environ.get("SUPABASE_ASSIGN_STAGE2_USER_COL", "assigned_to")
ASSIGN2_TIME_COL = os.environ.get("SUPABASE_ASSIGN_STAGE2_TIME_COL", "assigned_at")
BUNNY_KEEP_URL = os.environ.get("BUNNY_KEEP_URL") or os.environ.get("BUNNY_BASE") or os.environ.get("BUNNY_PULL_BASE")
KEEP_AUDIO_COL = os.environ.get("SUPABASE_KEEP_AUDIO_COL")

# Optional static audio proxy builder if column not present
AUDIO_PROXY_BASE = os.environ.get("AUDIO_PROXY_BASE")
AUDIO_PROXY_EXT = os.environ.get("AUDIO_PROXY_EXT", ".opus")

# Gold injection (optional)
GOLD_RATE = float(os.environ.get("GOLD_INJECTION_RATE", "0") or 0)
GOLD_TABLE = os.environ.get("SUPABASE_GOLD_TABLE")
GOLD_FILE_COL = os.environ.get("SUPABASE_GOLD_FILE_COL", FILE_COL)


ALLOCATOR_ALPHA = 2.0
UNKNOWN_CELL_KEY = "unknown:unknown:unknown:unknown"

DIALECT_KEYS = [
    "dialect_family",
    "dialectFamily",
    "dialect_family_code",
    "dialect_family_label",
    "dialect",
    "family",
]

SUBREGION_KEYS = [
    "dialect_subregion",
    "dialectSubregion",
    "dialect_region",
    "subregion",
    "region",
    "province",
]

GENDER_KEYS = [
    "apparent_gender",
    "apparentGender",
    "gender",
    "gender_norm",
    "speaker_gender",
]

AGE_KEYS = [
    "apparent_age_band",
    "apparentAgeBand",
    "age_band",
    "ageBand",
    "age",
    "age_group",
    "ageGroup",
]


STAGE2_OUTPUT_DIR = Path(os.environ.get("STAGE2_OUTPUT_DIR", "data/stage2_output"))

DOUBLE_PASS_BASE_PROB = float(os.environ.get("STAGE2_DOUBLE_PASS_BASE_PROB", "0.15"))
DOUBLE_PASS_MAX_PROB = float(os.environ.get("STAGE2_DOUBLE_PASS_MAX_PROB", "0.40"))
DOUBLE_PASS_MULTIPLIER = 1.5
DOUBLE_PASS_QA_F1_THRESHOLD = 0.80
DOUBLE_PASS_QA_CUES_THRESHOLD = 0.85
DOUBLE_PASS_LOOKBACK_HOURS = int(os.environ.get("STAGE2_DOUBLE_PASS_LOOKBACK_HOURS", "24") or 24)
DOUBLE_PASS_ANNOTATOR_CAP = float(os.environ.get("STAGE2_DOUBLE_PASS_ANNOTATOR_CAP", "0.20"))
MAX_PASSES_PER_ASSET = 2
ASSIGNMENT_ACTIVE_HOURS = int(os.environ.get("STAGE2_ASSIGNMENT_ACTIVE_HOURS", "6") or 6)

CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
}
_SEED_CLIP_ID = "synthetic_long_clip"
_SEED_PASS_DIR = "pass_1"
_SEED_MEDIA_URL = "/sample.mp4"
_SEED_PREFILL_BASE_URL = f"/data/stage2_output/{_SEED_CLIP_ID}/{_SEED_PASS_DIR}"
_SEED_META_PATH = (
    Path(__file__).resolve().parent.parent
    / "public"
    / "data"
    / "stage2_output"
    / _SEED_CLIP_ID
    / "item_meta.json"
)


def _seed_manifest(annotator_id: str, stage: int) -> Dict[str, Any]:
    meta_data: Dict[str, Any] = {}
    try:
        meta_text = _SEED_META_PATH.read_text(encoding="utf-8")
        meta_data = json.loads(meta_text)
    except Exception:
        meta_data = {}

    asset_id = meta_data.get("asset_id") or _SEED_CLIP_ID
    assigned_cell = meta_data.get("cell") or UNKNOWN_CELL_KEY
    previous_annotators: List[str] = []
    assignments = meta_data.get("assignments")
    if isinstance(assignments, list):
        for entry in assignments:
            if not isinstance(entry, dict):
                continue
            annot = entry.get("annotator_id")
            if annot and annot not in previous_annotators:
                previous_annotators.append(annot)

    manifest_item = {
        "asset_id": asset_id,
        "media": {
            "audio_proxy_url": _SEED_MEDIA_URL,
            "video_hls_url": None,
            "poster_url": None,
        },
        "prefill": {
            "diarization_rttm_url": f"{_SEED_PREFILL_BASE_URL}/diarization.rttm",
            "transcript_vtt_url": f"{_SEED_PREFILL_BASE_URL}/transcript.vtt",
            "transcript_ctm_url": None,
            "translation_vtt_url": f"{_SEED_PREFILL_BASE_URL}/translation.vtt",
            "code_switch_vtt_url": None,
            "events_vtt_url": f"{_SEED_PREFILL_BASE_URL}/events.vtt",
            "emotion_vtt_url": f"{_SEED_PREFILL_BASE_URL}/emotion.vtt",
            "code_switch_spans_url": f"{_SEED_PREFILL_BASE_URL}/code_switch_spans.json",
        },
        "stage0_status": "seed",
        "stage1_status": "seed",
        "language_hint": "ar",
        "notes": "seed manifest",
        "assigned_cell": assigned_cell,
        "double_pass_target": False,
        "pass_number": 1,
        "previous_annotators": previous_annotators,
    }
    return {
        "annotator_id": annotator_id,
        "stage": stage,
        "items": [manifest_item],
    }


def _prefill_local_url(fname: str, filename: str) -> Optional[str]:
    if not fname or not filename:
        return None
    base = Path("data/stage2_output")
    normalized = str(fname).strip().strip("/\\")
    candidates = []
    if normalized:
        candidates.append(normalized)
    stem = Path(normalized).stem if normalized else ""
    if stem and stem not in candidates:
        candidates.append(stem)
    for candidate in candidates:
        rel = Path(*candidate.split("/"))
        local_path = base / rel / "pass_1" / filename
        if local_path.exists():
            return "/" + local_path.as_posix()
    return None


def _resolve_prefill_url(row: Dict[str, Any], column: Optional[str], fname: str, fallback_filename: Optional[str]) -> Optional[str]:
    value = None
    if column:
        value = row.get(column)
    if value:
        return value
    if fallback_filename:
        return _prefill_local_url(fname, fallback_filename)
    return None

QA_F1_KEYS = [
    "rolling_median_code_switch_f1",
    "rolling_median_codeswitch_f1",
    "median_code_switch_f1",
    "median_codeswitch_f1",
    "codeswitch_f1_median",
    "code_switch_median_f1",
    "codeswitch_median_f1",
    "median_codeswitch",
]

QA_CUES_KEYS = [
    "pct_cues_in_bounds",
    "pct_cues_within_bounds",
    "percent_cues_in_bounds",
    "percentage_cues_in_bounds",
    "cues_pct_in_bounds",
    "cues_in_bounds_pct",
]

COVERAGE_PCT_KEYS = ["pct_of_target", "coverage_pct", "coverage_ratio"]
TARGET_KEYS = ["target", "target_hours", "target_count", "target_clips"]
COUNT_KEYS = ["count", "completed", "clips", "observed", "current"]


def _resolve_routing_config_path() -> Path:
    base_dir = Path(__file__).resolve().parent.parent
    raw_path = os.environ.get("ROUTING_CONFIG_PATH") or "config/routing.json"
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        candidate = (base_dir / candidate).resolve()
    return candidate


ROUTING_CONFIG_PATH = _resolve_routing_config_path()

DEFAULT_ROUTING_CONFIG: Dict[str, float] = {
    "p_base": DOUBLE_PASS_BASE_PROB,
    "coverage_boost_threshold": 0.50,
    "coverage_boost_factor": DOUBLE_PASS_MULTIPLIER,
    "qa_boost_f1_threshold": DOUBLE_PASS_QA_F1_THRESHOLD,
    "qa_boost_cue_in_bounds_threshold": DOUBLE_PASS_QA_CUES_THRESHOLD,
    "qa_boost_factor": DOUBLE_PASS_MULTIPLIER,
    "p_max": DOUBLE_PASS_MAX_PROB,
    "annotator_daily_cap": DOUBLE_PASS_ANNOTATOR_CAP,
}


def _coerce_float(value: Any, fallback: float) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    if numeric != numeric:  # NaN guard
        return fallback
    return numeric


def _load_routing_config() -> Dict[str, float]:
    config = dict(DEFAULT_ROUTING_CONFIG)
    path = ROUTING_CONFIG_PATH
    try:
        with path.open("r", encoding="utf-8") as fp:
            data = json.load(fp)
    except FileNotFoundError:
        return config
    except json.JSONDecodeError as exc:
        print(f"[tasks] failed to parse routing config at {path}: {exc}")
        return config
    except OSError as exc:
        print(f"[tasks] unable to read routing config at {path}: {exc}")
        return config

    source = data
    if isinstance(source, dict) and "routing" in source and isinstance(source["routing"], dict):
        source = source["routing"]

    if isinstance(source, dict):
        for key, fallback in DEFAULT_ROUTING_CONFIG.items():
            if key in source:
                config[key] = _coerce_float(source.get(key), fallback)
    return config


def _normalize_probability(value: Any) -> Optional[float]:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if numeric != numeric:
        return None
    if numeric > 1.0:
        numeric = numeric / 100.0
    if numeric < 0.0:
        numeric = 0.0
    if numeric > 1.0:
        numeric = 1.0
    return numeric


def _supabase_headers() -> Dict[str, str]:
    return {
        "apikey": SUPABASE_KEY or "",
        "Authorization": f"Bearer {SUPABASE_KEY}" if SUPABASE_KEY else "",
        "Accept": "application/json",
    }


def _fetch_snapshot_via_endpoint() -> Optional[Dict[str, Any]]:
    endpoint = os.environ.get("COVERAGE_ENDPOINT_URL")
    if not endpoint:
        base_url = (
            os.environ.get("COVERAGE_BASE_URL")
            or os.environ.get("PUBLIC_BASE_URL")
            or os.environ.get("SITE_URL")
        )
        if base_url:
            endpoint = base_url.rstrip("/") + "/api/coverage"
    if not endpoint:
        return None
    try:
        resp = requests.get(endpoint, timeout=5)
        if resp.ok:
            return resp.json()
    except Exception as exc:
        print("[tasks] coverage endpoint fetch failed:", repr(exc))
    return None


def _load_allocator_snapshot() -> Optional[Dict[str, Any]]:
    snapshot = _fetch_snapshot_via_endpoint()
    if snapshot is not None:
        return snapshot
    try:
        return load_coverage_snapshot()
    except (CoverageSnapshotNotFound, CoverageSnapshotInvalid):
        return None


def _normalize_category(value: Any) -> str:
    if value is None:
        return "unknown"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value != value:  # NaN guard
            return "unknown"
        return str(value)
    text = str(value).strip().lower()
    return text or "unknown"


def _build_cell_key(
    dialect_family: Any = None,
    subregion: Any = None,
    gender: Any = None,
    age: Any = None,
) -> str:
    return ":".join(
        [
            _normalize_category(dialect_family),
            _normalize_category(subregion),
            _normalize_category(gender),
            _normalize_category(age),
        ]
    )


def _coerce_to_dicts(value: Any) -> List[Dict[str, Any]]:
    dicts: List[Dict[str, Any]] = []
    if value is None:
        return dicts
    if isinstance(value, dict):
        dicts.append(value)
        return dicts
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return dicts
        return _coerce_to_dicts(parsed)
    if isinstance(value, (list, tuple, set)):
        for item in value:
            dicts.extend(_coerce_to_dicts(item))
    return dicts


def _collect_metadata_dicts(row: Any) -> List[Dict[str, Any]]:
    if not isinstance(row, dict):
        return []
    dicts: List[Dict[str, Any]] = []
    for key in ("metadata", "meta", "clip_metadata", "extra_metadata", "data"):
        dicts.extend(_coerce_to_dicts(row.get(key)))
    return dicts


def _collect_profiles(row: Any) -> List[Dict[str, Any]]:
    profiles: List[Dict[str, Any]] = []
    sources: List[Dict[str, Any]] = []
    if isinstance(row, dict):
        sources.append(row)
        sources.extend(_collect_metadata_dicts(row))
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key in ("speaker_profiles", "speakerProfiles", "profiles", "speakers"):
            value = source.get(key)
            if not value:
                continue
            profiles.extend(_coerce_to_dicts(value))
    return profiles


def _first_defined(dicts: List[Dict[str, Any]], keys: List[str]) -> Any:
    for source in dicts:
        if not isinstance(source, dict):
            continue
        for key in keys:
            if key in source and source[key] not in (None, ""):
                value = source[key]
                if isinstance(value, str):
                    trimmed = value.strip()
                    if trimmed:
                        return value
                else:
                    return value
    return None


def _derive_cell_keys(row: Any) -> List[str]:
    contexts: List[Dict[str, Any]] = []
    if isinstance(row, dict):
        contexts.append(row)
        contexts.extend(_collect_metadata_dicts(row))

    profiles = _collect_profiles(row)
    cells: List[str] = []
    if profiles:
        for profile in profiles:
            if not isinstance(profile, dict):
                continue
            profile_contexts = [profile]
            profile_contexts.extend(_collect_metadata_dicts(profile))
            combined = profile_contexts + contexts
            dialect_family = _first_defined(combined, DIALECT_KEYS)
            subregion = _first_defined(combined, SUBREGION_KEYS)
            gender = _first_defined(combined, GENDER_KEYS)
            age = _first_defined(combined, AGE_KEYS)
            cells.append(_build_cell_key(dialect_family, subregion, gender, age))
    else:
        dialect_family = _first_defined(contexts, DIALECT_KEYS)
        subregion = _first_defined(contexts, SUBREGION_KEYS)
        gender = _first_defined(contexts, GENDER_KEYS)
        age = _first_defined(contexts, AGE_KEYS)
        cells.append(_build_cell_key(dialect_family, subregion, gender, age))

    if not cells:
        return [UNKNOWN_CELL_KEY]

    # Deduplicate while preserving order
    seen = set()
    ordered: List[str] = []
    for cell in cells:
        if cell in seen:
            continue
        seen.add(cell)
        ordered.append(cell)
    return ordered or [UNKNOWN_CELL_KEY]


def _derive_primary_cell(row: Any) -> str:
    keys = _derive_cell_keys(row)
    return keys[0] if keys else UNKNOWN_CELL_KEY


def _safe_asset_dirname(asset_id: str) -> str:
    text = str(asset_id or "asset").strip()
    if not text:
        text = "asset"
    safe = "".join(
        ch if ch.isalnum() or ch in {"_", "-", "."} else "_" for ch in text
    )
    return safe or "asset"


def _asset_output_dir(asset_id: str) -> Path:
    return STAGE2_OUTPUT_DIR / _safe_asset_dirname(asset_id)


def _load_meta_from_dir(path: Path) -> Optional[Dict[str, Any]]:
    meta_path = path / "item_meta.json"
    if not meta_path.is_file():
        return None
    try:
        with meta_path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _load_item_meta(asset_id: str, cache: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    if asset_id in cache:
        return cache[asset_id]
    meta_path = _asset_output_dir(asset_id) / "item_meta.json"
    data: Dict[str, Any] = {}
    if meta_path.is_file():
        try:
            with meta_path.open("r", encoding="utf-8") as fh:
                loaded = json.load(fh)
                if isinstance(loaded, dict):
                    data = loaded
        except Exception:
            data = {}
    cache[asset_id] = data
    return data


def _to_float(value: Any) -> Optional[float]:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if not (num == num and abs(num) != float("inf")):
        return None
    return num


def _extract_metric(containers: List[Dict[str, Any]], keys: List[str]) -> Optional[float]:
    for container in containers:
        if not isinstance(container, dict):
            continue
        for key in keys:
            if key not in container:
                continue
            num = _to_float(container.get(key))
            if num is not None:
                return num
    return None


def _collect_metric_containers(cell: Dict[str, Any]) -> List[Dict[str, Any]]:
    containers: List[Dict[str, Any]] = []
    if isinstance(cell, dict):
        containers.append(cell)
        for key in (
            "qa_metrics",
            "qa",
            "metrics",
            "quality",
            "recent_metrics",
            "qa_summary",
        ):
            value = cell.get(key)
            if isinstance(value, dict):
                containers.append(value)
    return containers


def _build_cell_metric_lookup(snapshot: Optional[Dict[str, Any]]) -> Dict[str, Dict[str, Optional[float]]]:
    if not isinstance(snapshot, dict):
        return {}
    cells = snapshot.get("cells")
    if not isinstance(cells, list):
        return {}

    lookup: Dict[str, Dict[str, Optional[float]]] = {}
    for cell in cells:
        if not isinstance(cell, dict):
            continue
        key_raw = cell.get("cell_key") or cell.get("cellKey")
        cell_key = None
        if isinstance(key_raw, str) and key_raw.strip():
            cell_key = key_raw.strip().lower()
        if not cell_key:
            cell_key = _build_cell_key(
                cell.get("dialect_family"),
                cell.get("subregion") or cell.get("dialect_subregion"),
                cell.get("apparent_gender"),
                cell.get("apparent_age_band"),
            )
        containers = _collect_metric_containers(cell)
        coverage_pct = None
        for key in COVERAGE_PCT_KEYS:
            coverage_pct = _to_float(cell.get(key))
            if coverage_pct is not None:
                break
        if coverage_pct is None:
            target = None
            for key in TARGET_KEYS:
                target = _to_float(cell.get(key))
                if target is not None:
                    break
            count = None
            for key in COUNT_KEYS:
                count = _to_float(cell.get(key))
                if count is not None:
                    break
            if target and target > 0 and count is not None:
                coverage_pct = max(0.0, min(1.0, count / target))
        elif coverage_pct > 1.0 and coverage_pct <= 100.0:
            coverage_pct = coverage_pct / 100.0

        median_f1 = _extract_metric(containers, QA_F1_KEYS)
        cues_pct = _extract_metric(containers, QA_CUES_KEYS)
        if cues_pct is not None and cues_pct > 1.0 and cues_pct <= 100.0:
            cues_pct = cues_pct / 100.0

        lookup[cell_key] = {
            "coverage_pct": coverage_pct,
            "median_f1": median_f1,
            "cues_pct": cues_pct,
        }

    return lookup


def _parse_iso_datetime(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            dt = datetime.strptime(str(value), fmt)
            return dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _iter_all_item_metas(cache: Dict[str, Dict[str, Any]]) -> List[Tuple[str, Dict[str, Any]]]:
    records: List[Tuple[str, Dict[str, Any]]] = []
    if not STAGE2_OUTPUT_DIR.exists():
        return records
    try:
        dirs = [p for p in STAGE2_OUTPUT_DIR.iterdir() if p.is_dir()]
    except FileNotFoundError:
        return records
    for entry in dirs:
        meta = _load_meta_from_dir(entry)
        if not meta:
            continue
        asset_id = str(meta.get("asset_id") or entry.name)
        cache.setdefault(asset_id, meta)
        records.append((asset_id, meta))
    return records


def _compute_recent_double_pass_stats(
    annotator_id: str, cache: Dict[str, Dict[str, Any]]
) -> Tuple[int, int]:
    if not annotator_id:
        return (0, 0)
    records = _iter_all_item_metas(cache)
    if not records:
        return (0, 0)
    now = datetime.utcnow().replace(tzinfo=timezone.utc)
    cutoff = now - timedelta(hours=max(1, DOUBLE_PASS_LOOKBACK_HOURS))
    double_count = 0
    total_count = 0
    for _, meta in records:
        assignments = meta.get("assignments")
        if not isinstance(assignments, list):
            continue
        for assignment in assignments:
            if not isinstance(assignment, dict):
                continue
            if str(assignment.get("annotator_id") or "").strip() != annotator_id:
                continue
            submitted = _parse_iso_datetime(assignment.get("submitted_at"))
            if submitted is None or submitted < cutoff:
                continue
            total_count += 1
            try:
                pass_number = int(assignment.get("pass_number", 1))
            except (TypeError, ValueError):
                pass_number = 1
            if pass_number >= 2:
                double_count += 1
    return (double_count, total_count)


def _compute_effective_double_pass_probability(
    cell_key: str,
    lookup: Dict[str, Dict[str, Optional[float]]],
    routing_config: Optional[Dict[str, float]] = None,
) -> float:
    config = routing_config or _load_routing_config()
    base_prob = (
        _normalize_probability(config.get("p_base"))
        or _normalize_probability(DEFAULT_ROUTING_CONFIG["p_base"])
        or 0.0
    )
    p = base_prob

    info = lookup.get((cell_key or "").lower()) if lookup else None
    coverage_pct = None
    median_f1 = None
    cues_pct = None
    if isinstance(info, dict):
        coverage_pct = info.get("coverage_pct")
        median_f1 = info.get("median_f1")
        cues_pct = info.get("cues_pct")

    coverage_threshold = _normalize_probability(
        config.get("coverage_boost_threshold")
    ) or _normalize_probability(DEFAULT_ROUTING_CONFIG["coverage_boost_threshold"])
    coverage_factor = max(
        0.0,
        _coerce_float(
            config.get("coverage_boost_factor"),
            DEFAULT_ROUTING_CONFIG["coverage_boost_factor"],
        ),
    )
    coverage_ratio = _normalize_probability(coverage_pct)
    if (
        coverage_ratio is not None
        and coverage_threshold is not None
        and coverage_ratio < coverage_threshold
    ):
        p *= coverage_factor

    qa_factor = max(
        0.0,
        _coerce_float(
            config.get("qa_boost_factor"),
            DEFAULT_ROUTING_CONFIG["qa_boost_factor"],
        ),
    )
    qa_f1_threshold = _normalize_probability(config.get("qa_boost_f1_threshold"))
    if qa_f1_threshold is None:
        qa_f1_threshold = _normalize_probability(
            DEFAULT_ROUTING_CONFIG["qa_boost_f1_threshold"]
        )
    qa_cues_threshold = _normalize_probability(
        config.get("qa_boost_cue_in_bounds_threshold")
    )
    if qa_cues_threshold is None:
        qa_cues_threshold = _normalize_probability(
            DEFAULT_ROUTING_CONFIG["qa_boost_cue_in_bounds_threshold"]
        )

    quality_flag = False
    median_f1_ratio = _normalize_probability(median_f1)
    if (
        median_f1_ratio is not None
        and qa_f1_threshold is not None
        and median_f1_ratio < qa_f1_threshold
    ):
        quality_flag = True
    cues_ratio = _normalize_probability(cues_pct)
    if (
        cues_ratio is not None
        and qa_cues_threshold is not None
        and cues_ratio < qa_cues_threshold
    ):
        quality_flag = True

    if quality_flag:
        p *= qa_factor

    p = max(0.0, p)
    p_max = (
        _normalize_probability(config.get("p_max"))
        or _normalize_probability(DEFAULT_ROUTING_CONFIG["p_max"])
        or 1.0
    )
    return min(p, p_max)


def _compute_allocator_weights(snapshot: Dict[str, Any]) -> Dict[str, float]:
    cells = snapshot.get("cells") if isinstance(snapshot, dict) else None
    if not isinstance(cells, list):
        return {}

    weights: Dict[str, float] = {}
    total = 0.0
    for cell in cells:
        if not isinstance(cell, dict):
            continue
        cell_key_raw = cell.get("cell_key")
        resolved_key = None
        if isinstance(cell_key_raw, str) and cell_key_raw.strip():
            candidate = cell_key_raw.strip().lower()
            if candidate:
                resolved_key = candidate
        if not resolved_key:
            resolved_key = _build_cell_key(
                cell.get("dialect_family"),
                cell.get("subregion") or cell.get("dialect_subregion"),
                cell.get("apparent_gender"),
                cell.get("apparent_age_band"),
            )

        try:
            target = float(cell.get("target"))
        except (TypeError, ValueError):
            continue
        if target <= 0:
            continue

        try:
            count = float(cell.get("count", 0))
        except (TypeError, ValueError):
            count = 0.0
        pct = max(0.0, min(1.0, count / target if target > 0 else 0.0))
        score = pow(max(0.0, 1.0 - pct), ALLOCATOR_ALPHA)
        if score <= 0:
            continue

        if pct < 0.5:
            score *= 1.25

        try:
            deficit = float(cell.get("deficit"))
        except (TypeError, ValueError):
            deficit = None
        if deficit is not None and deficit >= 20:
            score *= 1.15

        weights[resolved_key] = weights.get(resolved_key, 0.0) + score
        total += score

    if total <= 0:
        return {key: 0.0 for key in weights.keys()}

    return {key: value / total for key, value in weights.items()}


def _normalize_weight_map(
    weights: Dict[str, float],
    availability: Dict[str, List[Dict[str, Any]]],
) -> Dict[str, float]:
    filtered: Dict[str, float] = {}
    for key, value in weights.items():
        if value <= 0:
            continue
        bucket = availability.get(key)
        if bucket:
            filtered[key] = value
    total = sum(filtered.values())
    if total <= 0:
        return {}
    return {key: value / total for key, value in filtered.items()}


def _pick_weighted_cell(weights: Dict[str, float]) -> str:
    total = sum(weights.values())
    if total <= 0:
        return ""
    roll = random.random() * total
    cumulative = 0.0
    last_key = ""
    for key, value in weights.items():
        cumulative += value
        last_key = key
        if roll <= cumulative:
            return key
    return last_key


def _select_with_allocator(
    rows: List[Dict[str, Any]],
    weights: Dict[str, float],
    limit: int,
) -> List[Dict[str, Any]]:
    if not weights or not rows or limit <= 0:
        return []

    availability: Dict[str, List[Dict[str, Any]]] = {}
    entries: List[Dict[str, Any]] = []
    for row in rows:
        cell_keys = _derive_cell_keys(row)
        entry = {"row": row, "cell_keys": cell_keys}
        entries.append(entry)
        for key in cell_keys:
            availability.setdefault(key, []).append(entry)

    raw_weights = dict(weights)
    selections: List[Dict[str, Any]] = []
    normalized = _normalize_weight_map(raw_weights, availability)

    while len(selections) < limit and normalized:
        cell_key = _pick_weighted_cell(normalized)
        if not cell_key:
            break
        bucket = availability.get(cell_key) or []
        bucket = [entry for entry in bucket if entry]
        if not bucket:
            raw_weights.pop(cell_key, None)
            normalized = _normalize_weight_map(raw_weights, availability)
            continue
        entry = random.choice(bucket)
        selections.append({"row": entry["row"], "cell": cell_key})
        for key in entry["cell_keys"]:
            cell_bucket = availability.get(key)
            if cell_bucket:
                availability[key] = [item for item in cell_bucket if item is not entry]
        normalized = _normalize_weight_map(raw_weights, availability)

    return selections


@app.get("/api/config")
async def get_config() -> JSONResponse:
    config = _load_routing_config()
    return JSONResponse(config)


@app.get("/api/tasks")
async def get_tasks(
    stage: int = Query(2),
    annotator_id: str = Query("anonymous"),
    limit: int = Query(10, ge=1, le=200),
    seed_fallback: bool = Query(True),
    use_seed: bool = Query(False),
):
    items: List[Dict[str, Any]] = []
    keep_rows_total: Optional[int] = None
    available_rows_total: Optional[int] = None
    selected_entries_count = 0
    skipped_missing_transcript = 0
    skipped_assets: List[str] = []
    selected_entries: List[Dict[str, Any]] = []
    assignment_rows: List[Dict[str, Any]] = []
    routing_config = _load_routing_config()
    annotator_cap = _normalize_probability(routing_config.get("annotator_daily_cap"))
    if annotator_cap is None:
        annotator_cap = (
            _normalize_probability(DEFAULT_ROUTING_CONFIG["annotator_daily_cap"]) or 1.0
        )

    if BUNNY_KEEP_URL and SUPABASE_URL and SUPABASE_KEY:
        try:
            keep_endpoint = f"{SUPABASE_URL}/rest/v1/{KEEP_TABLE}?{DECISION_COL}=eq.{KEEP_VALUE}&select={FILE_COL}"
            if PREFILL_DIA:
                keep_endpoint += f",{PREFILL_DIA}"
            if PREFILL_TR_VTT:
                keep_endpoint += f",{PREFILL_TR_VTT}"
            if PREFILL_TR_CTM:
                keep_endpoint += f",{PREFILL_TR_CTM}"
            if PREFILL_TL_VTT:
                keep_endpoint += f",{PREFILL_TL_VTT}"
            if PREFILL_CS_VTT:
                keep_endpoint += f",{PREFILL_CS_VTT}"
            if KEEP_AUDIO_COL:
                keep_endpoint += f",{KEEP_AUDIO_COL}"

            headers = _supabase_headers()
            _dbg("fetch.keep", endpoint=keep_endpoint)
            keep_resp = requests.get(keep_endpoint, headers=headers, timeout=20)
            _dbg("fetch.keep.done", status=keep_resp.status_code)
            keep_resp.raise_for_status()
            rows = keep_resp.json()
            keep_rows_total = len(rows) if isinstance(rows, list) else None

            assign_endpoint = (
                f"{SUPABASE_URL}/rest/v1/{ASSIGN2_TABLE}?select={ASSIGN2_FILE_COL},{ASSIGN2_USER_COL},{ASSIGN2_TIME_COL}"
            )
            _dbg("fetch.assignments", endpoint=assign_endpoint)
            assigned_resp = requests.get(assign_endpoint, headers=headers, timeout=20)
            _dbg("fetch.assignments.done", status=assigned_resp.status_code)
            assigned_resp.raise_for_status()
            assigned_rows = assigned_resp.json()
            active_cutoff = datetime.utcnow().replace(tzinfo=timezone.utc) - timedelta(
                hours=max(1, ASSIGNMENT_ACTIVE_HOURS)
            )
            active_assigned = set()
            for entry in assigned_rows:
                fname = entry.get(ASSIGN2_FILE_COL)
                if not fname:
                    continue
                assigned_at = _parse_iso_datetime(entry.get(ASSIGN2_TIME_COL))
                if assigned_at and assigned_at >= active_cutoff:
                    active_assigned.add(fname)

            available_rows = [
                r for r in rows if r and r.get(FILE_COL) and r.get(FILE_COL) not in active_assigned
            ]
            available_rows_total = len(available_rows)

            coverage_weights: Dict[str, float] = {}
            snapshot = _load_allocator_snapshot()
            if snapshot:
                coverage_weights = _compute_allocator_weights(snapshot)

            selected_entries = []
            if coverage_weights:
                selected_entries.extend(
                    _select_with_allocator(available_rows, coverage_weights, limit)
                )

            selected_files = {
                entry["row"].get(FILE_COL)
                for entry in selected_entries
                if entry["row"].get(FILE_COL)
            }

            for row in available_rows:
                if len(selected_entries) >= limit:
                    break
                fname = row.get(FILE_COL)
                if not fname or fname in selected_files:
                    continue
                selected_entries.append({"row": row, "cell": _derive_primary_cell(row)})
                selected_files.add(fname)

            if len(selected_entries) < limit and rows:
                pool = [
                    r
                    for r in rows
                    if all(r is not entry["row"] for entry in selected_entries)
                ]
                random.shuffle(pool)
                for row in pool[: max(0, limit - len(selected_entries))]:
                    selected_entries.append(
                        {"row": row, "cell": _derive_primary_cell(row)}
                    )


            gold_rows: List[Dict[str, Any]] = []
            if GOLD_TABLE and GOLD_RATE > 0:
                try:
                    gold_ep = f"{SUPABASE_URL}/rest/v1/{GOLD_TABLE}?select={GOLD_FILE_COL}&limit={max(1, limit)}"
                    gold_resp = requests.get(gold_ep, headers=headers, timeout=15)
                    if gold_resp.ok:
                        gold_rows = gold_resp.json()
                except Exception:
                    gold_rows = []

            candidate_entries = list(selected_entries)
            if limit and rows and len(candidate_entries) < limit * 2:
                existing_ids = {id(entry["row"]) for entry in candidate_entries}
                extras: List[Dict[str, Any]] = []
                for row in rows:
                    if not row or id(row) in existing_ids:
                        continue
                    extras.append({"row": row, "cell": _derive_primary_cell(row)})
                random.shuffle(extras)
                max_extras = max(limit * 3 - len(candidate_entries), 0)
                if max_extras:
                    candidate_entries.extend(extras[:max_extras])

            cell_lookup = _build_cell_metric_lookup(snapshot)
            meta_cache: Dict[str, Dict[str, Any]] = {}
            annot_double_count, annot_total_count = _compute_recent_double_pass_stats(
                annotator_id, meta_cache
            )
            assignment_rows = []
            seen_assets: set = set()
            base = BUNNY_KEEP_URL.rstrip("/")

            for entry in candidate_entries:
                if len(items) >= limit:
                    break
                row_ref = entry.get("row")
                if not isinstance(row_ref, dict):
                    continue
                r = row_ref
                is_gold = False
                if gold_rows and GOLD_RATE > 0:
                    try:
                        import random as _rnd

                        if _rnd.random() < GOLD_RATE:
                            gr = _rnd.choice(gold_rows)
                            if gr and gr.get(GOLD_FILE_COL):
                                r = {GOLD_FILE_COL: gr.get(GOLD_FILE_COL)}
                                is_gold = True
                    except Exception:
                        pass

                fname = r.get(FILE_COL)
                if not fname:
                    continue
                fname = str(fname)
                if fname in seen_assets:
                    continue

                assigned_cell = entry.get("cell") or _derive_primary_cell(row_ref)
                if is_gold:
                    assigned_cell = "gold:gold:gold:gold"

                meta = _load_item_meta(fname, meta_cache)
                if not isinstance(meta, dict):
                    meta = {}
                review_status = str(meta.get("review_status") or "").lower()
                if review_status == "locked":
                    continue

                assignments_meta = meta.get("assignments") if isinstance(meta.get("assignments"), list) else []
                normalized_assignments: List[Dict[str, Any]] = []
                previous_annotators: List[str] = []
                annotator_already_assigned = False
                second_pass_recorded = False
                for record in assignments_meta:
                    if not isinstance(record, dict):
                        continue
                    annot = str(record.get("annotator_id") or "").strip()
                    try:
                        pass_num = int(record.get("pass_number", 1))
                    except (TypeError, ValueError):
                        pass_num = 1
                    pass_num = max(1, pass_num)
                    if annot:
                        normalized_assignments.append(
                            {"annotator_id": annot, "pass_number": pass_num}
                        )
                        if annot == annotator_id:
                            annotator_already_assigned = True
                        elif annot not in previous_annotators:
                            previous_annotators.append(annot)
                    if pass_num >= 2:
                        second_pass_recorded = True

                if annotator_already_assigned:
                    continue
                if second_pass_recorded or len(normalized_assignments) >= MAX_PASSES_PER_ASSET:
                    continue

                eligible_for_second = bool(normalized_assignments) and not is_gold
                pass_number = 1
                double_pass_target = False

                if eligible_for_second:
                    prob_cell_key = assigned_cell if assigned_cell else UNKNOWN_CELL_KEY
                    probability = _compute_effective_double_pass_probability(
                        prob_cell_key, cell_lookup, routing_config
                    )
                    current_ratio = (
                        (annot_double_count / annot_total_count)
                        if annot_total_count
                        else 0.0
                    )
                    assign_second = False
                    if annot_total_count and current_ratio >= annotator_cap:
                        assign_second = False
                    else:
                        projected_total = annot_total_count + 1
                        projected_double = annot_double_count + 1
                        if (
                            projected_total > 0
                            and projected_double / projected_total > annotator_cap
                        ):
                            assign_second = False
                        else:
                            assign_second = random.random() < probability
                    if assign_second:
                        pass_number = min(
                            MAX_PASSES_PER_ASSET, len(normalized_assignments) + 1
                        )
                        double_pass_target = True
                    else:
                        continue

                annot_total_count += 1
                if double_pass_target:
                    annot_double_count += 1

                media_url = f"{base}/{fname.lstrip('/')}"
                audio_url = f"/api/proxy_audio?file={quote(fname)}"
                if KEEP_AUDIO_COL and r.get(KEEP_AUDIO_COL):
                    audio_url = r.get(KEEP_AUDIO_COL)
                elif AUDIO_PROXY_BASE:
                    name_no_ext = fname.rsplit('.', 1)[0]
                    audio_url = (
                        AUDIO_PROXY_BASE.rstrip("/")
                        + "/"
                        + name_no_ext
                        + (
                            AUDIO_PROXY_EXT
                            if AUDIO_PROXY_EXT.startswith(".")
                            else ("." + AUDIO_PROXY_EXT)
                        )
                    )

                manifest_item = {
                    "__prefill_source": {
                        "diar": bool(r.get(PREFILL_DIA)) if isinstance(r, dict) else False,
                        "tr_vtt": bool(r.get(PREFILL_TR_VTT)) if isinstance(r, dict) else False,
                        "tl_vtt": bool(r.get(PREFILL_TL_VTT)) if isinstance(r, dict) else False,
                        "cs_vtt": bool(r.get(PREFILL_CS_VTT)) if isinstance(r, dict) else False,
                    },
                    "asset_id": fname,
                    "media": {
                        "audio_proxy_url": audio_url or media_url,
                        "video_hls_url": media_url if media_url.endswith(".m3u8") else None,
                        "poster_url": None,
                    },
                    "prefill": {
                        "diarization_rttm_url": _resolve_prefill_url(r, PREFILL_DIA, fname, "diarization.rttm"),
                        "transcript_vtt_url": _resolve_prefill_url(r, PREFILL_TR_VTT, fname, "transcript.vtt"),
                        "transcript_ctm_url": _resolve_prefill_url(r, PREFILL_TR_CTM, fname, None),
                        "translation_vtt_url": _resolve_prefill_url(r, PREFILL_TL_VTT, fname, "translation.vtt"),
                        "code_switch_vtt_url": _resolve_prefill_url(r, PREFILL_CS_VTT, fname, "code_switch_spans.json"),
                        "events_vtt_url": _resolve_prefill_url(r, "events_vtt_url", fname, "events.vtt"),
                        "emotion_vtt_url": _resolve_prefill_url(r, "emotion_vtt_url", fname, "emotion.vtt"),
                    },
                    "is_gold": is_gold,
                    "stage0_status": "validated",
                    "stage1_status": "validated",
                    "language_hint": "ar",
                    "notes": None,
                    "assigned_cell": assigned_cell,
                    "double_pass_target": double_pass_target,
                    "pass_number": pass_number,
                    "previous_annotators": previous_annotators,
                }
                prefill_block = manifest_item.get("prefill") or {}
                has_transcript = bool(prefill_block.get("transcript_vtt_url")) or bool(prefill_block.get("translation_vtt_url"))
                if not has_transcript:
                    skipped_missing_transcript += 1
                    skipped_assets.append(fname)
                    continue

                items.append(manifest_item)
                seen_assets.add(fname)
                assignment_rows.append(
                    {
                        ASSIGN2_FILE_COL: fname,
                        ASSIGN2_USER_COL: annotator_id,
                        ASSIGN2_TIME_COL: datetime.utcnow().isoformat(),
                    }
                )

            if assignment_rows:
                try:
                    post_headers = dict(headers)
                    post_headers.update(
                        {
                            "Content-Type": "application/json",
                            "Prefer": "return=representation",
                        }
                    )
                    requests.post(
                        f"{SUPABASE_URL}/rest/v1/{ASSIGN2_TABLE}",
                        headers=post_headers,
                        json=assignment_rows,
                        timeout=20,
                    )
                except Exception as e:
                    print("[tasks] stage2 assignment insert failed:", repr(e))
        except Exception as e:
            error_info: Dict[str, Any] = {"message": repr(e)}
            resp = getattr(e, "response", None)
            if resp is not None:
                error_info["status_code"] = getattr(resp, "status_code", None)
                try:
                    error_info["body"] = resp.json()
                except Exception:
                    try:
                        error_info["text"] = resp.text
                    except Exception:
                        pass
            _dbg("supabase.fetch.error", error=error_info)
            return JSONResponse(
                {
                    "__diag": "supabase_error_fallback",
                    "error": error_info,
                    "manifest": _seed_manifest(annotator_id, stage),
                },
                headers=CACHE_HEADERS,
            )

    selected_entries_total = len(selected_entries)
    selected_entries_count = len(items)
    manifest_meta: Dict[str, Any] = {
        "keep_rows": keep_rows_total,
        "available_rows": available_rows_total,
        "selected_entries": selected_entries_total,
        "delivered": selected_entries_count,
        "skipped_missing_transcript": skipped_missing_transcript,
    }
    if skipped_assets:
        manifest_meta["skipped_assets"] = skipped_assets

    if not items and seed_fallback and not use_seed:
        _dbg("no_items_fallback", reason=manifest_meta)
        return JSONResponse(
            {
                "__diag": "no_items_fallback",
                "reason": manifest_meta,
                "manifest": _seed_manifest(annotator_id, stage),
            },
            headers=CACHE_HEADERS,
        )

    manifest: Dict[str, Any] = {"annotator_id": annotator_id, "stage": stage, "items": items}
    manifest["__meta"] = manifest_meta
    if use_seed:
        manifest["__seed"] = _seed_manifest(annotator_id, stage)
    return JSONResponse(manifest, headers=CACHE_HEADERS)


@app.get('/api/prefill_check')
async def prefill_check(file: str):
    if not all([SUPABASE_URL, SUPABASE_KEY, KEEP_TABLE, FILE_COL]):
        return JSONResponse({"ok": False, "error": "env_missing"})
    try:
        ep = f"{SUPABASE_URL}/rest/v1/{KEEP_TABLE}?{FILE_COL}=eq.{file}&select={FILE_COL},{PREFILL_TR_VTT},{PREFILL_TL_VTT},{PREFILL_CS_VTT},{PREFILL_DIA}"
        _dbg("probe.prefill", endpoint=ep)
        resp = requests.get(ep, headers=_supabase_headers(), timeout=20)
        data = resp.json() if resp.ok else None
        return JSONResponse({
            "ok": resp.ok,
            "status": resp.status_code,
            "rows": data if isinstance(data, list) else [],
            "env_present": {
                "TR_VTT": bool(PREFILL_TR_VTT),
                "TL_VTT": bool(PREFILL_TL_VTT),
                "CS_VTT": bool(PREFILL_CS_VTT),
                "DIA": bool(PREFILL_DIA)
            }
        })
    except Exception as e:
        _dbg("probe.prefill.error", error=repr(e))
        return JSONResponse({"ok": False, "error": repr(e)})


@app.get('/api/env_names')
async def env_names():
    return JSONResponse({
        "ok": True,
        "names": {
            "SUPABASE_URL": bool(SUPABASE_URL),
            "SUPABASE_KEY": bool(SUPABASE_KEY),
            "KEEP_TABLE": KEEP_TABLE,
            "FILE_COL": FILE_COL,
            "PREFILL_TR_VTT": PREFILL_TR_VTT,
            "PREFILL_TL_VTT": PREFILL_TL_VTT,
            "PREFILL_CS_VTT": PREFILL_CS_VTT,
            "PREFILL_DIA": PREFILL_DIA
        }
    })
