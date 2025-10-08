from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse
from typing import Any, Dict, List, Optional
from pathlib import Path
import json
import os
import requests
from datetime import datetime

app = FastAPI()

# Supabase config (flexible names)
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_SERVICE_KEY")
    or os.environ.get("SUPABASE_ANON_KEY")
)

TABLE_SINGLE = os.environ.get("SUPABASE_STAGE2_TABLE", "annotations_stage2")
TABLE_BATCH = os.environ.get("SUPABASE_STAGE2_BATCH_TABLE", TABLE_SINGLE)

STAGE2_OUTPUT_DIR = Path(os.environ.get("STAGE2_OUTPUT_DIR", "data/stage2_output"))


FILE_OUTPUT_MAP = {
    "transcript_vtt": "transcript.vtt",
    "translation_vtt": "translation.vtt",
    "code_switch_vtt": "code_switch.vtt",
    "code_switch_spans_json": "code_switch_spans.json",
    "diarization_rttm": "diarization.rttm",
}

OPTIONAL_FILE_MAP = {
    "events_vtt": "events.vtt",
    "emotion_vtt": "emotion.vtt",
    "speaker_profiles_json": "speaker_profiles.json",
    "transcript_ctm": "transcript.ctm",
}


def _sanitize_annotator_id(value: Optional[str]) -> str:
    text = str(value or "anonymous").strip()
    if not text:
        text = "anonymous"
    safe = "".join(
        ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in text
    ).lower()
    return safe or "anonymous"


def _safe_asset_dirname(asset_id: str) -> str:
    text = str(asset_id or "asset").strip()
    if not text:
        text = "asset"
    safe = "".join(
        ch if ch.isalnum() or ch in {"_", "-", "."} else "_" for ch in text
    )
    return safe or "asset"


def _asset_output_dir(asset_id: str) -> Path:
    safe_name = _safe_asset_dirname(asset_id)
    return STAGE2_OUTPUT_DIR / safe_name


def _write_text_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _persist_annotation_files(
    payload: Dict[str, Any],
    annotator: str,
) -> Optional[datetime]:
    asset_id = payload.get("asset_id")
    files = payload.get("files") if isinstance(payload.get("files"), dict) else {}
    if not asset_id or not isinstance(files, dict):
        return None

    annotator_id = _sanitize_annotator_id(annotator)
    asset_dir = _asset_output_dir(asset_id)
    annotator_dir = asset_dir / annotator_id
    annotator_dir.mkdir(parents=True, exist_ok=True)

    for key, filename in FILE_OUTPUT_MAP.items():
        value = files.get(key)
        if isinstance(value, str):
            _write_text_file(annotator_dir / filename, value)

    for key, filename in OPTIONAL_FILE_MAP.items():
        value = files.get(key)
        if isinstance(value, str) and value.strip():
            _write_text_file(annotator_dir / filename, value)

    qa_payload = payload.get("qa") if isinstance(payload.get("qa"), dict) else {}
    qa_record = dict(qa_payload)
    if payload.get("summary"):
        qa_record.setdefault("summary", payload.get("summary"))
    if payload.get("double_pass_target") is not None:
        qa_record.setdefault("double_pass_target", bool(payload.get("double_pass_target")))
    if payload.get("pass_number") is not None:
        try:
            qa_record.setdefault("pass_number", int(payload.get("pass_number")))
        except (TypeError, ValueError):
            pass
    submitted_at = datetime.utcnow()
    qa_record["submitted_at"] = submitted_at.isoformat() + "Z"
    _write_text_file(
        annotator_dir / "qa_result.json",
        json.dumps(qa_record, ensure_ascii=False, indent=2),
    )

    annotation_path = annotator_dir / "annotation.json"
    _write_text_file(
        annotation_path,
        json.dumps(payload, ensure_ascii=False, indent=2),
    )

    _update_item_meta(asset_dir, asset_id, annotator_id, submitted_at, payload)
    return submitted_at


def _load_item_meta(meta_path: Path) -> Dict[str, Any]:
    if not meta_path.is_file():
        return {}
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _update_item_meta(
    asset_dir: Path,
    asset_id: str,
    annotator_id: str,
    submitted_at: datetime,
    payload: Dict[str, Any],
) -> None:
    meta_path = asset_dir / "item_meta.json"
    meta = _load_item_meta(meta_path)

    meta["asset_id"] = asset_id
    if "double_pass_target" in payload:
        meta["double_pass_target"] = bool(payload.get("double_pass_target"))
    elif "double_pass_target" not in meta and payload.get("pass_number"):
        try:
            meta["double_pass_target"] = int(payload.get("pass_number")) >= 2
        except (TypeError, ValueError):
            meta.setdefault("double_pass_target", False)

    assigned_cell = payload.get("assigned_cell")
    if isinstance(assigned_cell, str) and assigned_cell:
        meta["assigned_cell"] = assigned_cell
    elif "assigned_cell" not in meta:
        meta["assigned_cell"] = "unknown:unknown:unknown:unknown"

    review_status = payload.get("review_status")
    if isinstance(review_status, str) and review_status:
        meta["review_status"] = review_status
    else:
        meta.setdefault("review_status", "pending")

    assignments = meta.get("assignments")
    if not isinstance(assignments, list):
        assignments = []

    try:
        pass_number = int(payload.get("pass_number", 1))
    except (TypeError, ValueError):
        pass_number = 1
    if pass_number >= 2:
        meta["double_pass_target"] = True

    assignments.append(
        {
            "annotator_id": annotator_id,
            "pass_number": pass_number,
            "submitted_at": submitted_at.isoformat() + "Z",
        }
    )
    meta["assignments"] = assignments

    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def _supabase_headers() -> Dict[str, str]:
    return {
        "apikey": SUPABASE_KEY or "",
        "Authorization": f"Bearer {SUPABASE_KEY}" if SUPABASE_KEY else "",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


@app.post("/api/annotations")
async def post_annotation(req: Request, annotator: str = Query("anonymous")):
    payload = await req.json()
    # Minimal validation
    errors = []
    if not isinstance(payload, dict):
        errors.append("payload must be an object")
    else:
        if not payload.get("asset_id"):
            errors.append("asset_id required")
        files = payload.get("files")
        if not isinstance(files, dict):
            errors.append("files must be an object")
        else:
            # Stage2 file expectations (strings, may be empty)
            for k in [
                "transcript_vtt",
                "translation_vtt",
                "code_switch_vtt",
                "code_switch_spans_json",
            ]:
                if k not in files:
                    errors.append(f"files.{k} missing")
            for k in [
                "diarization_rttm",
                "transcript_ctm",
                "events_vtt",
            ]:
                if k in files and files[k] is not None and not isinstance(files[k], str):
                    errors.append(f"files.{k} must be string or null")
        qa = payload.get("qa")
        if not isinstance(qa, dict):
            errors.append("qa must be an object")
        else:
            if not qa.get("annotator_id"):
                errors.append("qa.annotator_id required")
            if qa.get("gold_check") not in ("pass", "fail", None):
                errors.append("qa.gold_check must be 'pass' or 'fail'")

    record = {
        "data": payload,
        "received_at": datetime.utcnow().isoformat(),
        "annotator": annotator,
    }
    saved = False
    warn = None
    if SUPABASE_URL and SUPABASE_KEY:
        try:
            endpoint = f"{SUPABASE_URL}/rest/v1/{TABLE_SINGLE}"
            resp = requests.post(endpoint, headers=_supabase_headers(), json=record, timeout=15)
            saved = resp.status_code // 100 == 2
            if not saved:
                warn = f"Supabase insert failed: {resp.status_code}"
        except Exception as e:
            warn = f"Supabase exception: {repr(e)}"
    try:
        _persist_annotation_files(payload, annotator)
    except Exception as exc:
        if warn:
            warn = f"{warn}; file_persist_error={repr(exc)}"
        else:
            warn = f"file_persist_error={repr(exc)}"
    return JSONResponse({"status": "ok", "saved": saved, "warning": warn, "validation_errors": errors})


@app.post("/api/annotations/batch")
async def post_annotations_batch(req: Request, annotator: str = Query("anonymous")):
    body = await req.json()
    items: List[Dict[str, Any]] = body if isinstance(body, list) else body.get("items") or []
    saved = False
    warn = None
    if SUPABASE_URL and SUPABASE_KEY and items:
        try:
            endpoint = f"{SUPABASE_URL}/rest/v1/{TABLE_BATCH}"
            records = [
                {"data": it, "received_at": datetime.utcnow().isoformat(), "annotator": annotator}
                for it in items
            ]
            resp = requests.post(endpoint, headers=_supabase_headers(), json=records, timeout=30)
            saved = resp.status_code // 100 == 2
            if not saved:
                warn = f"Supabase batch insert failed: {resp.status_code}"
        except Exception as e:
            warn = f"Supabase exception: {repr(e)}"
    for item in items:
        try:
            _persist_annotation_files(item, annotator)
        except Exception as exc:
            note = f"file_persist_error={repr(exc)}"
            warn = f"{warn}; {note}" if warn else note
    return JSONResponse({"status": "ok", "saved": saved, "count": len(items), "warning": warn})
