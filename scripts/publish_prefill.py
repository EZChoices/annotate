#!/usr/bin/env python3
import os, json, glob, time, requests

# --- required env ---
SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
BUNNY_ZONE = os.environ["BUNNY_STORAGE_ZONE"]
BUNNY_PWD = os.environ["BUNNY_STORAGE_PASSWORD"]
BUNNY_KEEP_URL = os.environ["BUNNY_KEEP_URL"]  # e.g. https://your-pull.b-cdn.net/keep/
LOCAL_DD_WAV_DIR = os.environ["LOCAL_DD_WAV_DIR"]

# --- optional env (defaults align with CODEX plan) ---
PREFILL_FOLDER = os.environ.get("BUNNY_PREFILL_FOLDER", "prefill")
KEEP_TABLE = os.environ.get("SUPABASE_KEEP_TABLE", "keep")
FILE_COL = os.environ.get("SUPABASE_FILE_COL", "file_name")
MATCH_SUFFIX = os.environ.get("SUPABASE_KEEP_MATCH_SUFFIX", ".mp4")
TR_COL = os.environ.get("SUPABASE_KEEP_TR_VTT_COL", "transcript_vtt_url")
DIA_COL = os.environ.get("SUPABASE_KEEP_DIA_RTTM_COL", "diarization_rttm_url")

# --- helpers ---
def to_webvtt(segments):
    lines = ["WEBVTT", ""]
    for i, s in enumerate(segments, 1):
        start = s.get("start", 0.0)
        end = s.get("end", max(start + 0.01, start))
        speaker = s.get("speaker", "")
        text = (s.get("text") or "").strip()
        def fmt(t):
            h=int(t//3600); m=int((t%3600)//60); sec=t%60
            return f"{h:02d}:{m:02d}:{sec:06.3f}".replace(".", ",")
        lines += [f"{i}", f"{fmt(start)} --> {fmt(end)}", f"{speaker}: {text}", ""]
    return "\n".join(lines).encode("utf-8")

def to_rttm(segments, file_id):
    # NIST RTTM: SPEAKER <FILE> 1 <onset> <dur> <ortho> <stype> <name> <conf>
    rows=[]
    for s in segments:
        st=float(s.get("start",0.0)); en=float(s.get("end",st))
        dur=max(0.01, en-st); sp=(s.get("speaker") or "spk").replace(" ", "_")
        rows.append(f"SPEAKER {file_id} 1 {st:.3f} {dur:.3f} <NA> <NA> {sp} <NA>")
    return ("\n".join(rows)+"\n").encode("utf-8")

def bunny_put(path, data):
    url=f"https://storage.bunnycdn.com/{BUNNY_ZONE}/{path}"
    r=requests.put(url, data=data, headers={"AccessKey": BUNNY_PWD})
    r.raise_for_status()

def supabase_patch_by_filename(file_name, updates):
    # PATCH /rest/v1/<table>?<col>=eq.<value>
    url=f"{SUPABASE_URL}/rest/v1/{KEEP_TABLE}?{FILE_COL}=eq.{file_name}"
    r=requests.patch(url, json=updates, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates"
    })
    r.raise_for_status()
    return r.json()

# --- main ---
src = None
for candidate in ["transcripts_final", "transcripts"]:
    p=os.path.join(LOCAL_DD_WAV_DIR, candidate)
    if os.path.isdir(p): src=p; break
if not src:
    raise SystemExit("No transcripts_final/ or transcripts/ found under LOCAL_DD_WAV_DIR")

json_files = glob.glob(os.path.join(src, "*.json"))
uploaded=patched=0

for jf in json_files:
    file_id = os.path.splitext(os.path.basename(jf))[0]  # e.g., 6967...1041
    with open(jf,"r",encoding="utf-8") as f:
        obj=json.load(f)
    # Try common layouts
    segments = obj.get("segments") or obj.get("results") or obj.get("items") or []
    if not segments: continue

    vtt = to_webvtt(segments)
    rttm = to_rttm(segments, file_id)

    # upload to bunny
    vtt_path = f"{PREFILL_FOLDER}/vtt/{file_id}.vtt"
    rttm_path = f"{PREFILL_FOLDER}/rttm/{file_id}.rttm"
    bunny_put(vtt_path, vtt)
    bunny_put(rttm_path, rttm)
    uploaded+=1

    # compute public URLs
    tr_url = f"{BUNNY_KEEP_URL}{vtt_path}"
    dia_url = f"{BUNNY_KEEP_URL}{rttm_path}"

    # patch supabase keep row where file_name == <id>.mp4 (by default)
    target_name = f"{file_id}{MATCH_SUFFIX}"
    try:
        supabase_patch_by_filename(target_name, {TR_COL: tr_url, DIA_COL: dia_url})
        patched+=1
    except Exception as e:
        # row might not exist yet; skip
        pass

    if uploaded % 50 == 0:
        print(f"Progress: uploaded {uploaded}, patched {patched}…"); time.sleep(0.2)

print(f"Done. Uploaded {uploaded} VTT/RTTM, patched {patched} keep rows.")publish_prefill.py
