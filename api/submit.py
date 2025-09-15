from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse
import os
import json
import requests
from datetime import datetime

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

    msg = "Annotation received and saved" if saved else "Annotation received"
    result = {"status": "ok", "message": msg}
    if error:
        result["warning"] = error
        print("[submit]", error)
    return JSONResponse(result)

