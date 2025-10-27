from fastapi import FastAPI, Query
from fastapi.responses import StreamingResponse, JSONResponse
import io, json, zipfile, os, requests
from datetime import datetime
from collections import defaultdict
from pathlib import Path

app = FastAPI()

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_SERVICE_KEY")
    or os.environ.get("SUPABASE_ANON_KEY")
)
STAGE2_TABLE = os.environ.get("SUPABASE_STAGE2_TABLE", "annotations_stage2")
STAGE2_OUTPUT_DIR = Path(os.environ.get("STAGE2_OUTPUT_DIR", "data/stage2_output"))
if not STAGE2_OUTPUT_DIR.is_absolute():
    STAGE2_OUTPUT_DIR = Path(__file__).resolve().parent.parent / STAGE2_OUTPUT_DIR

def _compute_stage2_summary(root: Path) -> Dict[str, int]:
    clips = 0
    double_passes = 0
    if not root.exists():
        return {"clips": clips, "double_passes": double_passes}

    for clip_dir in root.iterdir():
        if not clip_dir.is_dir():
            continue
        has_artifacts = False
        passes_found = set()

        for child in clip_dir.iterdir():
            if child.is_dir() and child.name.lower().startswith("pass_"):
                passes_found.add(child.name.lower())
                if not has_artifacts:
                    for artifact in child.rglob("*"):
                        if artifact.is_file() and artifact.suffix.lower() in {".vtt", ".json"}:
                            has_artifacts = True
                            break
            elif child.is_file() and child.suffix.lower() in {".vtt", ".json"}:
                has_artifacts = True

            if has_artifacts and any(name != "pass_1" for name in passes_found):
                # Enough information gathered; stop scanning this clip.
                break

        if has_artifacts:
            clips += 1
        if any(name != "pass_1" for name in passes_found):
            double_passes += 1

    return {"clips": clips, "double_passes": double_passes}


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
    review_counts = {
        "total": 0,
        "accepted": 0,
        "corrected": 0,
        "rejected": 0,
        "pending": 0,
        "locked": 0,
    }
    annotator_groups = defaultdict(list)

    for entry in clip_entries:
        if not isinstance(entry, dict):
            continue
        clip_id = entry.get("clip_id") or entry.get("clipId") or data.get("asset_id")
        metrics = entry.get("metrics") or {}
        if not isinstance(metrics, dict):
            metrics = {}
        cues_metrics = metrics.get("cues") if isinstance(metrics.get("cues"), dict) else {}
        review_payload = entry.get("review") if isinstance(entry.get("review"), dict) else {}
        review_status = entry.get("review_status") or review_payload.get("status") or review_payload.get("review_status")
        locked_flag = entry.get("locked")
        if locked_flag is None:
            locked_flag = review_payload.get("locked")
        reviewer = entry.get("reviewer") or review_payload.get("reviewer")
        reviewed_at = entry.get("reviewed_at") or review_payload.get("updatedAt") or review_payload.get("reviewedAt")
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
            "translation_correctness": entry.get("translation_correctness"),
            "review_status": review_status,
            "locked": bool(locked_flag),
            "reviewer": reviewer,
            "reviewed_at": reviewed_at,
        }
        clips.append(qa_entry)
        annotator = qa_entry.get("annotator_id") or "anonymous"
        annotator_groups[annotator].append(qa_entry)
        review_counts["total"] += 1
        if qa_entry["locked"]:
            review_counts["locked"] += 1
        normalized_status = (review_status or "").lower()
        if normalized_status == "accepted":
            review_counts["accepted"] += 1
        elif normalized_status == "corrected":
            review_counts["corrected"] += 1
        elif normalized_status == "rejected":
            review_counts["rejected"] += 1

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
    review_counts["pending"] = max(
        0,
        review_counts["total"]
        - (review_counts["accepted"] + review_counts["corrected"] + review_counts["rejected"]),
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
        "clips": clips,
        "reviewSummary": review_counts,
    }


@app.get("/api/export/summary")
async def export_summary():
    summary = _compute_stage2_summary(STAGE2_OUTPUT_DIR)
    return JSONResponse(summary, headers={"Cache-Control": "no-store"})


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

