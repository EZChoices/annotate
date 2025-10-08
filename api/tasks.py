from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from typing import Dict, Any, List, Optional
import json
import os
import random
from datetime import datetime
from urllib.parse import quote

import requests

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


@app.get("/api/tasks")
async def get_tasks(
    stage: int = 2,
    annotator_id: str = "anonymous",
    limit: int = Query(10, ge=1, le=200),
):
    items: List[Dict[str, Any]] = []

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
            keep_resp = requests.get(keep_endpoint, headers=headers, timeout=20)
            keep_resp.raise_for_status()
            rows = keep_resp.json()

            assign_endpoint = f"{SUPABASE_URL}/rest/v1/{ASSIGN2_TABLE}?select={ASSIGN2_FILE_COL},{ASSIGN2_USER_COL}"
            assigned_resp = requests.get(assign_endpoint, headers=headers, timeout=20)
            assigned_resp.raise_for_status()
            assigned = {r.get(ASSIGN2_FILE_COL) for r in assigned_resp.json()}

            available_rows = [
                r
                for r in rows
                if r and r.get(FILE_COL) and r.get(FILE_COL) not in assigned
            ]

            coverage_weights: Dict[str, float] = {}
            snapshot = _load_allocator_snapshot()
            if snapshot:
                coverage_weights = _compute_allocator_weights(snapshot)

            selected_entries: List[Dict[str, Any]] = []
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


            assigned_cell_lookup = {
                id(entry["row"]): entry.get("cell", _derive_primary_cell(entry["row"]))
                for entry in selected_entries
            }

            gold_rows: List[Dict[str, Any]] = []
            if GOLD_TABLE and GOLD_RATE > 0:
                try:
                    gold_ep = f"{SUPABASE_URL}/rest/v1/{GOLD_TABLE}?select={GOLD_FILE_COL}&limit={max(1, limit)}"
                    gold_resp = requests.get(gold_ep, headers=headers, timeout=15)
                    if gold_resp.ok:
                        gold_rows = gold_resp.json()
                except Exception:
                    gold_rows = []

            if selected_entries:
                assign_rows = []
                for entry in selected_entries:
                    row = entry["row"]
                    fname = row.get(FILE_COL)
                    if not fname or fname in assigned:
                        continue
                    assign_rows.append(
                        {
                            ASSIGN2_FILE_COL: fname,
                            ASSIGN2_USER_COL: annotator_id,
                            ASSIGN2_TIME_COL: datetime.utcnow().isoformat(),
                        }
                    )
                if assign_rows:
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
                            json=assign_rows,
                            timeout=20,
                        )
                    except Exception as e:
                        print("[tasks] stage2 assignment insert failed:", repr(e))

            base = BUNNY_KEEP_URL.rstrip("/")
            for entry in selected_entries:
                r = entry["row"]
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
                assigned_cell = assigned_cell_lookup.get(id(entry["row"]), _derive_primary_cell(entry["row"]))
                if is_gold:
                    assigned_cell = "gold:gold:gold:gold"
                media_url = f"{base}/{str(fname).lstrip('/')}"
                audio_url = f"/api/proxy_audio?file={quote(str(fname))}"
                if KEEP_AUDIO_COL and r.get(KEEP_AUDIO_COL):
                    audio_url = r.get(KEEP_AUDIO_COL)
                elif AUDIO_PROXY_BASE:
                    name_no_ext = str(fname).rsplit('.', 1)[0]
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
                items.append(
                    {
                        "asset_id": fname,
                        "media": {
                            "audio_proxy_url": audio_url or media_url,
                            "video_hls_url": media_url if media_url.endswith(".m3u8") else None,
                            "poster_url": None,
                        },
                        "prefill": {
                            "diarization_rttm_url": r.get(PREFILL_DIA) if PREFILL_DIA else None,
                            "transcript_vtt_url": r.get(PREFILL_TR_VTT) if PREFILL_TR_VTT else None,
                            "transcript_ctm_url": r.get(PREFILL_TR_CTM) if PREFILL_TR_CTM else None,
                            "translation_vtt_url": r.get(PREFILL_TL_VTT) if PREFILL_TL_VTT else None,
                            "code_switch_vtt_url": r.get(PREFILL_CS_VTT) if PREFILL_CS_VTT else None,
                        },
                        "is_gold": is_gold,
                        "stage0_status": "validated",
                        "stage1_status": "validated",
                        "language_hint": "ar",
                        "notes": None,
                        "assigned_cell": assigned_cell,
                    }
                )
        except Exception as e:
            print("[tasks] Supabase keep fetch failed:", repr(e))

    if not items:
        media_url = "/public/sample.mp4"
        items = [
            {
                "asset_id": "sample-001",
                "media": {
                    "audio_proxy_url": media_url,
                    "video_hls_url": None,
                    "poster_url": None,
                },
                "prefill": {
                    "diarization_rttm_url": None,
                    "transcript_vtt_url": None,
                    "transcript_ctm_url": None,
                    "translation_vtt_url": None,
                    "code_switch_vtt_url": None,
                },
                "stage0_status": "validated",
                "stage1_status": "validated",
                "language_hint": "ar",
                "notes": None,
                "assigned_cell": UNKNOWN_CELL_KEY,
            }
        ]

    manifest: Dict[str, Any] = {"annotator_id": annotator_id, "stage": stage, "items": items}
    return JSONResponse(
        manifest,
        headers={"Cache-Control": "no-store, no-cache, max-age=0, must-revalidate"},
    )
