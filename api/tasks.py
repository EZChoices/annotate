from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse
from typing import Dict, Any, List
import os
import requests
import random
from datetime import datetime
from urllib.parse import quote

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


def _supabase_headers() -> Dict[str, str]:
    return {
        "apikey": SUPABASE_KEY or "",
        "Authorization": f"Bearer {SUPABASE_KEY}" if SUPABASE_KEY else "",
        "Accept": "application/json",
    }


@app.get("/api/tasks")
async def get_tasks(
    stage: int = 2,
    annotator_id: str = "anonymous",
    limit: int = Query(10, ge=1, le=200),
):
    # Build manifest from Supabase keep table, assigning items to annotator in stage2 assignments table
    items: List[Dict[str, Any]] = []

    if BUNNY_KEEP_URL and SUPABASE_URL and SUPABASE_KEY:
        try:
            keep_endpoint = f"{SUPABASE_URL}/rest/v1/{KEEP_TABLE}?select={FILE_COL}"
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

            # Fetch assigned files for stage2
            assign_endpoint = f"{SUPABASE_URL}/rest/v1/{ASSIGN2_TABLE}?select={ASSIGN2_FILE_COL},{ASSIGN2_USER_COL}"
            assigned_resp = requests.get(assign_endpoint, headers=headers, timeout=20)
            assigned_resp.raise_for_status()
            assigned = {r.get(ASSIGN2_FILE_COL) for r in assigned_resp.json()}

            chosen: List[Dict[str, Any]] = []
            for r in rows:
                if len(chosen) >= limit:
                    break
                fname = r.get(FILE_COL)
                if not fname:
                    continue
                if fname in assigned:
                    continue
                chosen.append(r)

            # If not enough unassigned, top up with random (may overlap) to fill the requested limit
            if len(chosen) < limit and rows:
                pool = [r for r in rows if r not in chosen]
                random.shuffle(pool)
                chosen.extend(pool[: max(0, limit - len(chosen))])

            # Record assignments for chosen
            if chosen:
                assign_rows = [
                    {
                        ASSIGN2_FILE_COL: r.get(FILE_COL),
                        ASSIGN2_USER_COL: annotator_id,
                        ASSIGN2_TIME_COL: datetime.utcnow().isoformat(),
                    }
                    for r in chosen
                    if r.get(FILE_COL)
                ]
                try:
                    post_headers = dict(headers)
                    post_headers.update({"Content-Type": "application/json", "Prefer": "return=representation"})
                    requests.post(f"{SUPABASE_URL}/rest/v1/{ASSIGN2_TABLE}", headers=post_headers, json=assign_rows, timeout=20)
                except Exception as e:
                    print("[tasks] stage2 assignment insert failed:", repr(e))

            base = BUNNY_KEEP_URL.rstrip("/")
            for r in chosen:
                fname = r.get(FILE_COL)
                if not fname:
                    continue
                media_url = f"{base}/{str(fname).lstrip('/')}"
                # Default to internal audio proxy so we control headers/caching
                audio_url = f"/api/proxy_audio?file={quote(str(fname))}"
                # If you insist on direct audio URL from table, uncomment below priority
                if KEEP_AUDIO_COL and r.get(KEEP_AUDIO_COL):
                    audio_url = r.get(KEEP_AUDIO_COL)
                elif AUDIO_PROXY_BASE:
                    name_no_ext = str(fname).rsplit('.', 1)[0]
                    audio_url = AUDIO_PROXY_BASE.rstrip('/') + '/' + name_no_ext + (AUDIO_PROXY_EXT if AUDIO_PROXY_EXT.startswith('.') else ('.' + AUDIO_PROXY_EXT))
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
                        "stage0_status": "validated",
                        "stage1_status": "validated",
                        "language_hint": "ar",
                        "notes": None,
                    }
                )
        except Exception as e:
            print("[tasks] Supabase keep fetch failed:", repr(e))

    if not items:
        # Local fallback: minimal sample
        media_url = "/public/sample.mp4"
        items = [
            {
                "asset_id": "sample-001",
                "media": {"audio_proxy_url": media_url, "video_hls_url": None, "poster_url": None},
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
            }
        ]

    manifest: Dict[str, Any] = {"annotator_id": annotator_id, "stage": stage, "items": items}
    return JSONResponse(manifest)
