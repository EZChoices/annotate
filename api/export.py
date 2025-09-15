from fastapi import FastAPI, Query
from fastapi.responses import StreamingResponse, JSONResponse
import io, json, zipfile, os, requests
from datetime import datetime

app = FastAPI()

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_SERVICE_KEY")
    or os.environ.get("SUPABASE_ANON_KEY")
)
STAGE2_TABLE = os.environ.get("SUPABASE_STAGE2_TABLE", "annotations_stage2")


def _headers():
    return {
        "apikey": SUPABASE_KEY or "",
        "Authorization": f"Bearer {SUPABASE_KEY}" if SUPABASE_KEY else "",
        "Accept": "application/json",
    }


@app.get("/api/export")
async def export_asset(asset_id: str = Query(...)):
    if not (SUPABASE_URL and SUPABASE_KEY):
        return JSONResponse({"error": "Supabase not configured"}, status_code=500)

    # Try to fetch the most recent row for this asset_id
    # PostgREST filter on JSON: data->>asset_id=eq.<id>
    try:
        ep = f"{SUPABASE_URL}/rest/v1/{STAGE2_TABLE}?select=data&id=not.is.null&data->>asset_id=eq.{asset_id}&order=id.desc&limit=1"
        resp = requests.get(ep, headers=_headers(), timeout=20)
        resp.raise_for_status()
        rows = resp.json()
        if not rows:
            return JSONResponse({"error": "not found"}, status_code=404)
        data = rows[0]["data"]
    except Exception as e:
        return JSONResponse({"error": f"fetch failed: {repr(e)}"}, status_code=500)

    files = data.get("files", {})
    mem = io.BytesIO()
    with zipfile.ZipFile(mem, mode="w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("annotation.json", json.dumps(data, ensure_ascii=False, indent=2))
        if files.get("transcript_vtt"):
            z.writestr("transcript.vtt", files.get("transcript_vtt"))
        if files.get("translation_vtt"):
            z.writestr("translation.vtt", files.get("translation_vtt"))
        if files.get("code_switch_vtt"):
            z.writestr("code_switch.vtt", files.get("code_switch_vtt"))
        if files.get("events_vtt"):
            z.writestr("events.vtt", files.get("events_vtt"))
        if files.get("diarization_rttm"):
            z.writestr("diarization.rttm", files.get("diarization_rttm"))
        if files.get("code_switch_spans_json"):
            z.writestr("code_switch_spans.json", files.get("code_switch_spans_json"))

    mem.seek(0)
    fname = f"export_{asset_id}_{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}.zip"
    return StreamingResponse(mem, media_type="application/zip", headers={
        "Content-Disposition": f"attachment; filename={fname}",
        "Cache-Control": "no-store"
    })

