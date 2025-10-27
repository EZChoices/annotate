from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse
import os
import json
import requests
from datetime import datetime
from pathlib import Path

app = FastAPI()

# Env config for Supabase persistence (optional)
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_SERVICE_KEY")
    or os.environ.get("SUPABASE_ANON_KEY")
)
SUBMIT_TABLE = os.environ.get("SUPABASE_SUBMIT_TABLE", "annotations")
SUBMIT_JSON_COL = os.environ.get("SUPABASE_SUBMIT_JSON_COL", "data")
META_V2_OUTPUT_DIR = Path(os.environ.get("META_V2_OUTPUT_DIR", "data/meta_v2_output"))
if not META_V2_OUTPUT_DIR.is_absolute():
    META_V2_OUTPUT_DIR = Path(__file__).resolve().parent.parent / META_V2_OUTPUT_DIR


def _slugify(value: str, fallback: str) -> str:
    text = str(value or "").strip()
    if not text:
        text = fallback
    safe = "".join(ch for ch in text if ch.isalnum() or ch in ("-", "_"))
    return safe or fallback


def _resolve_clip_id(payload: dict) -> str:
    if isinstance(payload, dict):
        preferred_keys = ("clip_id", "clipId", "asset_id", "assetId", "clip")
        tags = payload.get("tags")
        if isinstance(tags, dict):
            for key in preferred_keys:
                value = tags.get(key)
                if value:
                    return str(value)
        for key in preferred_keys:
            value = payload.get(key)
            if value:
                return str(value)
    return "clip"


def _persist_locally(payload: dict, annotator: str) -> Path:
    annot_slug = _slugify(annotator, "anonymous")
    clip_slug = _slugify(_resolve_clip_id(payload), "clip")
    timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    target_dir = META_V2_OUTPUT_DIR / annot_slug
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"{clip_slug}_{timestamp}.json"
    target_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return target_path


@app.post("/api/submit")
async def submit_annotations(req: Request, annotator: str = Query("anonymous")):
    payload = await req.json()
    print("[submit] Annotation submitted:", payload)

    saved = False
    error = None

    if SUPABASE_URL and SUPABASE_KEY:
        try:
            headers = {
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=representation",
            }
            record = {
                SUBMIT_JSON_COL: payload,
                "annotator": annotator,
                "received_at": datetime.utcnow().isoformat(),
            }

            # Try to pull out optional identifiers if present
            try:
                tags = payload.get("tags") if isinstance(payload, dict) else None
                if isinstance(tags, dict):
                    if "clip_id" in tags:
                        record["clip_id"] = tags.get("clip_id")
                    if "src" in tags:
                        record["video_url"] = tags.get("src")
            except Exception:
                pass

            endpoint = f"{SUPABASE_URL}/rest/v1/{SUBMIT_TABLE}"
            resp = requests.post(endpoint, headers=headers, json=record, timeout=10)
            if resp.status_code // 100 == 2:
                saved = True
            else:
                # Fallback: try submitting only the JSON column if schema is narrower
                slim_record = {SUBMIT_JSON_COL: payload}
                resp2 = requests.post(endpoint, headers=headers, json=slim_record, timeout=10)
                saved = resp2.status_code // 100 == 2
                if not saved:
                    error = f"Supabase insert failed: {resp.status_code} / {resp2.status_code}"
        except Exception as e:
            error = f"Supabase insert exception: {repr(e)}"

    local_path = None
    if not saved:
        try:
            local_path = _persist_locally(payload if isinstance(payload, dict) else {"data": payload}, annotator)
            saved = True
            print(f"[submit] Saved annotation locally at {local_path}")
        except Exception as local_err:
            local_msg = f"Local save failed: {repr(local_err)}"
            error = f"{error}; {local_msg}" if error else local_msg
            print("[submit]", local_msg)

    result = {"status": "ok", "message": "Annotation received and saved"}
    if error:
        result["warning"] = error
        print("[submit]", error)
    return JSONResponse(result)

