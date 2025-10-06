from fastapi import FastAPI, Query
from fastapi.responses import StreamingResponse, JSONResponse
import io, json, zipfile, os, requests
from datetime import datetime
from collections import defaultdict

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


def _average(values):
    vals = [v for v in values if isinstance(v, (int, float))]
    if not vals:
        return 0
    return sum(vals) / len(vals)


def _build_qa_report(data):
    qa_payload = data.get("qa") if isinstance(data, dict) else None
    if not qa_payload:
        return None

    clip_entries = qa_payload if isinstance(qa_payload, list) else [qa_payload]
    clips = []
    annotator_groups = defaultdict(list)

    for entry in clip_entries:
        if not isinstance(entry, dict):
            continue
        clip_id = entry.get("clip_id") or entry.get("clipId") or data.get("asset_id")
        metrics = entry.get("metrics") or {}
        if not isinstance(metrics, dict):
            metrics = {}
        cues_metrics = metrics.get("cues") if isinstance(metrics.get("cues"), dict) else {}
        qa_entry = {
            "clipId": clip_id,
            "annotator_id": entry.get("annotator_id"),
            "gold_target": entry.get("gold_target"),
            "gold_check": entry.get("gold_check"),
            "time_spent_sec": entry.get("time_spent_sec"),
            "codeswitch_f1": entry.get("codeswitch_f1"),
            "diarization_mae": entry.get("diarization_mae"),
            "cue_diff_sec": entry.get("cue_diff_sec") or cues_metrics.get("targetDiffSec"),
            "translation_completeness": entry.get("translation_completeness"),
            "translation_char_ratio": entry.get("translation_char_ratio") or cues_metrics.get("translationCompleteness"),
            "translation_correctness": entry.get("translation_correctness")
        }
        clips.append(qa_entry)
        annotator = qa_entry.get("annotator_id") or "anonymous"
        annotator_groups[annotator].append(qa_entry)

    if not clips:
        return None

    summary = {
        "totalGoldClips": sum(1 for clip in clips if clip.get("gold_target")),
        "reviewedClips": len(clips),
        "passCount": sum(1 for clip in clips if clip.get("gold_check") == "pass"),
        "averageCodeSwitchF1": _average([clip.get("codeswitch_f1") for clip in clips]),
        "averageDiarizationMAE": _average([clip.get("diarization_mae") for clip in clips]),
        "averageCueDiffSec": _average([clip.get("cue_diff_sec") for clip in clips]),
        "translationCompletenessAvg": _average([clip.get("translation_completeness") for clip in clips]),
        "translationCorrectnessAvg": _average([clip.get("translation_correctness") for clip in clips]),
        "translationCharRatioAvg": _average([clip.get("translation_char_ratio") for clip in clips])
    }
    summary["passRate"] = (
        summary["passCount"] / summary["reviewedClips"] if summary["reviewedClips"] else 0
    )

    per_annotator = []
    for annotator, items in annotator_groups.items():
        per_summary = {
            "annotator_id": annotator,
            "clips": len(items),
            "passRate": _average([1 if clip.get("gold_check") == "pass" else 0 for clip in items]),
            "averageCodeSwitchF1": _average([clip.get("codeswitch_f1") for clip in items]),
            "averageDiarizationMAE": _average([clip.get("diarization_mae") for clip in items]),
            "averageCueDiffSec": _average([clip.get("cue_diff_sec") for clip in items]),
            "translationCompletenessAvg": _average([clip.get("translation_completeness") for clip in items]),
            "translationCharRatioAvg": _average([clip.get("translation_char_ratio") for clip in items])
        }
        per_annotator.append(per_summary)

    return {
        "generatedAt": datetime.utcnow().isoformat() + "Z",
        "summary": summary,
        "perAnnotator": per_annotator,
        "clips": clips
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
        qa_report = _build_qa_report(data)
        if qa_report:
            z.writestr("qa_report.json", json.dumps(qa_report, ensure_ascii=False, indent=2))

    mem.seek(0)
    fname = f"export_{asset_id}_{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}.zip"
    return StreamingResponse(mem, media_type="application/zip", headers={
        "Content-Disposition": f"attachment; filename={fname}",
        "Cache-Control": "no-store"
    })

