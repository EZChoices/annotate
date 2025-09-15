from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from typing import Dict, Any
import os
import requests
import random

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
BUNNY_KEEP_URL = os.environ.get("BUNNY_KEEP_URL") or os.environ.get("BUNNY_BASE") or os.environ.get("BUNNY_PULL_BASE")


def _supabase_headers() -> Dict[str, str]:
    return {
        "apikey": SUPABASE_KEY or "",
        "Authorization": f"Bearer {SUPABASE_KEY}" if SUPABASE_KEY else "",
        "Accept": "application/json",
    }


@app.get("/api/tasks")
async def get_tasks(stage: int = 2, annotator_id: str = "anonymous"):
    # For now, return a simple manifest built from Supabase keep table or local sample
    items = []

    if BUNNY_KEEP_URL and SUPABASE_URL and SUPABASE_KEY:
        try:
            endpoint = f"{SUPABASE_URL}/rest/v1/{KEEP_TABLE}?select={FILE_COL}"
            resp = requests.get(endpoint, headers=_supabase_headers(), timeout=15)
            resp.raise_for_status()
            rows = resp.json()
            for r in rows[:25]:  # cap manifest for now
                fname = r.get(FILE_COL)
                if not fname:
                    continue
                base = BUNNY_KEEP_URL.rstrip("/")
                video_url = f"{base}/{fname.lstrip('/')}"
                # Stub: use the same URL as audio proxy until a real proxy exists
                items.append({
                    "asset_id": fname,
                    "media": {
                        "audio_proxy_url": video_url,
                        "video_hls_url": video_url if video_url.endswith('.m3u8') else None,
                        "poster_url": None
                    },
                    "prefill": {
                        "diarization_rttm_url": None,
                        "transcript_vtt_url": None,
                        "transcript_ctm_url": None,
                        "translation_vtt_url": None,
                        "code_switch_vtt_url": None
                    },
                    "stage0_status": "validated",
                    "stage1_status": "validated",
                    "language_hint": "ar",
                    "notes": None
                })
        except Exception as e:
            print("[tasks] Supabase keep fetch failed:", repr(e))

    if not items:
        # Local fallback: use playlist/sample
        video_url = "/public/sample.mp4"
        items = [{
            "asset_id": "sample-001",
            "media": {
                "audio_proxy_url": video_url,
                "video_hls_url": None,
                "poster_url": None
            },
            "prefill": {
                "diarization_rttm_url": None,
                "transcript_vtt_url": None,
                "transcript_ctm_url": None,
                "translation_vtt_url": None,
                "code_switch_vtt_url": None
            },
            "stage0_status": "validated",
            "stage1_status": "validated",
            "language_hint": "ar",
            "notes": None
        }]

    manifest: Dict[str, Any] = {
        "annotator_id": annotator_id,
        "stage": stage,
        "items": items,
    }
    return JSONResponse(manifest)

