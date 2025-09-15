from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from typing import Any, Dict, List
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


def _supabase_headers() -> Dict[str, str]:
    return {
        "apikey": SUPABASE_KEY or "",
        "Authorization": f"Bearer {SUPABASE_KEY}" if SUPABASE_KEY else "",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


@app.post("/api/annotations")
async def post_annotation(req: Request):
    payload = await req.json()
    record = {
        "data": payload,
        "received_at": datetime.utcnow().isoformat(),
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
    return JSONResponse({"status": "ok", "saved": saved, "warning": warn})


@app.post("/api/annotations/batch")
async def post_annotations_batch(req: Request):
    body = await req.json()
    items: List[Dict[str, Any]] = body if isinstance(body, list) else body.get("items") or []
    saved = False
    warn = None
    if SUPABASE_URL and SUPABASE_KEY and items:
        try:
            endpoint = f"{SUPABASE_URL}/rest/v1/{TABLE_BATCH}"
            records = [{"data": it, "received_at": datetime.utcnow().isoformat()} for it in items]
            resp = requests.post(endpoint, headers=_supabase_headers(), json=records, timeout=30)
            saved = resp.status_code // 100 == 2
            if not saved:
                warn = f"Supabase batch insert failed: {resp.status_code}"
        except Exception as e:
            warn = f"Supabase exception: {repr(e)}"
    return JSONResponse({"status": "ok", "saved": saved, "count": len(items), "warning": warn})

