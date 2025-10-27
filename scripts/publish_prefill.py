#!/usr/bin/env python3
import os
import re
import json
import glob
import time
import requests

# --- required env ---
SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
BUNNY_ZONE = os.environ["BUNNY_STORAGE_ZONE"]
# Accept either password or access key env var name
BUNNY_ACCESS = os.environ.get("BUNNY_STORAGE_PASSWORD") or os.environ.get("BUNNY_STORAGE_ACCESS_KEY")
if not BUNNY_ACCESS:
    raise SystemExit("Set BUNNY_STORAGE_PASSWORD (or BUNNY_STORAGE_ACCESS_KEY) for Bunny Storage authentication.")
BUNNY_KEEP_URL = os.environ["BUNNY_KEEP_URL"]  # e.g. https://your-pull.b-cdn.net/keep/
# Optional: region-specific storage host override, e.g. ny.storage.bunnycdn.com
BUNNY_HOST = os.environ.get("BUNNY_STORAGE_HOST", "storage.bunnycdn.com")
LOCAL_DD_WAV_DIR = os.environ["LOCAL_DD_WAV_DIR"]

# --- optional env (defaults align with CODEX plan) ---
PREFILL_FOLDER = os.environ.get("BUNNY_PREFILL_FOLDER", "prefill")
KEEP_TABLE = os.environ.get("SUPABASE_KEEP_TABLE", "keep")
FILE_COL = os.environ.get("SUPABASE_FILE_COL", "file_name")
MATCH_SUFFIX = os.environ.get("SUPABASE_KEEP_MATCH_SUFFIX", ".mp4")
TR_COL = os.environ.get("SUPABASE_KEEP_TR_VTT_COL", "transcript_vtt_url")
DIA_COL = os.environ.get("SUPABASE_KEEP_DIA_RTTM_COL", "diarization_rttm_url")

# Controls
PATCH_ONLY = os.environ.get("PREFILL_PATCH_ONLY", "").strip().lower() in {"1", "true", "yes"}
LIMIT = int(os.environ.get("PREFILL_LIMIT", "0") or 0)

# --- helpers ---
def to_webvtt(segments):
    # WebVTT uses a dot for milliseconds (e.g., 00:00:01.234)
    lines = ["WEBVTT", ""]
    for i, s in enumerate(segments, 1):
        start = float(s.get("start", 0.0))
        end_val = s.get("end", None)
        end = float(end_val) if end_val is not None else start
        if end <= start:
            end = start + 0.01
        speaker = s.get("speaker", "")
        text = (s.get("text") or "").strip()

        def fmt(t):
            h = int(t // 3600)
            m = int((t % 3600) // 60)
            sec = t % 60
            return f"{h:02d}:{m:02d}:{sec:06.3f}"

        cue_text = f"{speaker}: {text}" if speaker else text
        lines += [f"{i}", f"{fmt(start)} --> {fmt(end)}", cue_text, ""]
    return "\n".join(lines).encode("utf-8")


def to_rttm(segments, file_id):
    # NIST RTTM: SPEAKER <FILE> 1 <onset> <dur> <ortho> <stype> <name> <conf>
    rows = []
    for s in segments:
        st = float(s.get("start", 0.0))
        en = float(s.get("end", st))
        dur = max(0.01, en - st)
        sp = (s.get("speaker") or "spk").replace(" ", "_")
        rows.append(f"SPEAKER {file_id} 1 {st:.3f} {dur:.3f} <NA> <NA> {sp} <NA>")
    return ("\n".join(rows) + "\n").encode("utf-8")


def bunny_put(path, data):
    url = f"https://{BUNNY_HOST}/{BUNNY_ZONE}/{path}"
    try:
        r = requests.put(
            url,
            data=data,
            headers={"AccessKey": BUNNY_ACCESS, "Content-Type": "application/octet-stream"},
            timeout=30,
        )
        r.raise_for_status()
    except requests.HTTPError as e:
        status = getattr(e.response, "status_code", None)
        body = None
        try:
            body = e.response.text[:500] if e.response is not None else None
        except Exception:
            body = None
        if status == 401:
            raise SystemExit(
                "Bunny Storage returned 401 Unauthorized. "
                "Verify BUNNY_STORAGE_ZONE matches your Storage Zone name and "
                "BUNNY_STORAGE_PASSWORD/BUNNY_STORAGE_ACCESS_KEY is the Storage Zone FTP & API password (not the account API key). "
                f"If your zone uses a region endpoint, set BUNNY_STORAGE_HOST (current: {BUNNY_HOST}).\n"
                f"Tried URL: {url}"
            ) from e
        raise SystemExit(f"Bunny upload failed: HTTP {status}. URL: {url}. Body: {body}") from e


def supabase_patch_by_filename(file_name, updates):
    # PATCH /rest/v1/<table>?<col>=eq.<value>
    url = f"{SUPABASE_URL}/rest/v1/{KEEP_TABLE}?{FILE_COL}=eq.{file_name}"
    r = requests.patch(
        url,
        json=updates,
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        },
        timeout=30,
    )
    r.raise_for_status()
    # Some PostgREST setups return 204 No Content for PATCH; do not assume JSON
    return True


def bunny_ensure_dir(dir_path: str):
    """Create a folder in Bunny Storage if it does not exist (PUT on trailing slash)."""
    url = f"https://{BUNNY_HOST}/{BUNNY_ZONE}/{dir_path.rstrip('/')}/"
    r = requests.put(url, data=b"", headers={"AccessKey": BUNNY_ACCESS}, timeout=15)
    # 201/200 on success, 409 if exists, 401 on bad key
    if r.status_code == 401:
        raise SystemExit(
            "Bunny Storage returned 401 when creating directory. Check credentials/host as above."
        )
    if r.status_code not in (200, 201, 204, 409):
        raise SystemExit(f"Failed to ensure Bunny folder {dir_path}: HTTP {r.status_code} - {r.text[:300]}")


def bunny_preflight():
    """Attempt a lightweight GET on the zone root to catch 401 early with a clear message."""
    url = f"https://{BUNNY_HOST}/{BUNNY_ZONE}/"
    r = requests.get(url, headers={"AccessKey": BUNNY_ACCESS}, timeout=15)
    if r.status_code == 401:
        hint = ""
        # Heuristic: Account API keys are often UUID-like with 4 hyphens
        if re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", BUNNY_ACCESS or ""):
            hint = (
                " It looks like your AccessKey matches an account API key format (UUID). "
                "Use the Storage Zone FTP & API Access password from the Storage Zone page."
            )
        raise SystemExit(
            "Bunny Storage preflight failed with 401 Unauthorized. "
            f"Zone: {BUNNY_ZONE}, Host: {BUNNY_HOST}. "
            "Ensure BUNNY_STORAGE_ZONE is your Storage Zone name and "
            "BUNNY_STORAGE_PASSWORD/BUNNY_STORAGE_ACCESS_KEY is the Storage Zone FTP & API password. "
            "If your zone uses a regional endpoint, set BUNNY_STORAGE_HOST (e.g., ny.storage.bunnycdn.com)." + hint
        )
    # 200/204/404 are acceptable depending on zone listing settings


# --- main ---
src = None
for candidate in ["transcripts_final", "transcripts"]:
    p = os.path.join(LOCAL_DD_WAV_DIR, candidate)
    if os.path.isdir(p):
        src = p
        break
if not src:
    raise SystemExit("No transcripts_final/ or transcripts/ found under LOCAL_DD_WAV_DIR")

json_files = glob.glob(os.path.join(src, "*.json"))
json_files = sorted(json_files)
if LIMIT > 0:
    json_files = json_files[:LIMIT]
uploaded = patched = 0

if not PATCH_ONLY:
    # Preflight Bunny auth to fail early with an actionable message
    bunny_preflight()
    # Ensure destination folders exist in Bunny (idempotent)
    bunny_ensure_dir(PREFILL_FOLDER)
    bunny_ensure_dir(f"{PREFILL_FOLDER}/vtt")
    bunny_ensure_dir(f"{PREFILL_FOLDER}/rttm")
else:
    print("Patch-only mode: skipping uploads to Bunny.")

for jf in json_files:
    file_id = os.path.splitext(os.path.basename(jf))[0]  # e.g., 6967...1041
    vtt_path = f"{PREFILL_FOLDER}/vtt/{file_id}.vtt"
    rttm_path = f"{PREFILL_FOLDER}/rttm/{file_id}.rttm"
    if not PATCH_ONLY:
        with open(jf, "r", encoding="utf-8") as f:
            obj = json.load(f)
        # Try common layouts
        segments = obj.get("segments") or obj.get("results") or obj.get("items") or []
        if not segments:
            continue
        vtt = to_webvtt(segments)
        rttm = to_rttm(segments, file_id)
        # upload to bunny
        bunny_put(vtt_path, vtt)
        bunny_put(rttm_path, rttm)
        uploaded += 1

    # compute public URLs
    base = BUNNY_KEEP_URL.rstrip("/") + "/"
    tr_url = f"{base}{vtt_path}"
    dia_url = f"{base}{rttm_path}"

    # patch supabase keep row where file_name == <id>.mp4 (by default)
    target_name = f"{file_id}{MATCH_SUFFIX}"
    try:
        supabase_patch_by_filename(target_name, {TR_COL: tr_url, DIA_COL: dia_url})
        patched += 1
    except Exception:
        # row might not exist yet; skip
        pass

    if ((uploaded if not PATCH_ONLY else patched) % 50) == 0 and (uploaded or patched):
        print(f"Progress: uploaded {uploaded}, patched {patched}...")
        time.sleep(0.1)

print(f"Done. Uploaded {uploaded} VTT/RTTM, patched {patched} keep rows.")
