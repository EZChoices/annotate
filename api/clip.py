from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
import json, os, random, re
from datetime import datetime
import requests

app = FastAPI()

# Accept multiple env var names for flexibility
BUNNY_KEEP_URL = (
    os.environ.get("BUNNY_KEEP_URL")
    or os.environ.get("BUNNY_BASE")
    or os.environ.get("BUNNY_PULL_BASE")
)
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_SERVICE_KEY")
    or os.environ.get("SUPABASE_ANON_KEY")
)
SUPABASE_TABLE = os.environ.get("SUPABASE_KEEP_TABLE", "keep")
SUPABASE_FILE_COL = os.environ.get("SUPABASE_FILE_COL", "file_name")
ASSIGN_TABLE = os.environ.get("SUPABASE_ASSIGN_TABLE", "clip_assignments")
ASSIGN_FILE_COL = os.environ.get("SUPABASE_ASSIGN_FILE_COL", "file_name")
ASSIGN_USER_COL = os.environ.get("SUPABASE_ASSIGN_USER_COL", "assigned_to")
ASSIGN_TIME_COL = os.environ.get("SUPABASE_ASSIGN_TIME_COL", "assigned_at")

@app.get("/api/clip")
async def get_clip(annotator: str = Query("anonymous")):
    """Return a clip for tagging.

    If Supabase is configured, the endpoint looks for the first clip in
    ``SUPABASE_TABLE`` that has not been assigned in ``ASSIGN_TABLE``.
    The selection is recorded to prevent two annotators from getting the
    same file. When Supabase is unavailable, fall back to a random file
    or the bundled sample clip.
    """

    transcript_data = []

    if BUNNY_KEEP_URL:
        if SUPABASE_URL and SUPABASE_KEY:
            headers = {
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Accept": "application/json",
            }
            keep_endpoint = f"{SUPABASE_URL}/rest/v1/{SUPABASE_TABLE}?select={SUPABASE_FILE_COL}"

            try:
                keep_resp = requests.get(keep_endpoint, headers=headers, timeout=10)
                keep_resp.raise_for_status()
                keep_rows = keep_resp.json()
            except Exception as e:
                print("[clip] Supabase keep fetch failed:", repr(e))
                keep_rows = []

            # Try to find first unassigned clip
            if keep_rows:
                try:
                    assign_endpoint = f"{SUPABASE_URL}/rest/v1/{ASSIGN_TABLE}?select={ASSIGN_FILE_COL}"
                    assign_resp = requests.get(assign_endpoint, headers=headers, timeout=10)
                    assign_resp.raise_for_status()
                    assigned = {r.get(ASSIGN_FILE_COL) for r in assign_resp.json()}

                    chosen = None
                    for row in keep_rows:
                        fname = row.get(SUPABASE_FILE_COL)
                        if fname and fname not in assigned:
                            chosen = fname
                            break

                    if not chosen and keep_rows:
                        # if all appear assigned, pick a random one
                        chosen = random.choice(keep_rows).get(SUPABASE_FILE_COL)

                    if chosen:
                        video_url = BUNNY_KEEP_URL.rstrip("/") + "/" + str(chosen).lstrip("/")
                        payload = {
                            ASSIGN_FILE_COL: chosen,
                            ASSIGN_USER_COL: annotator,
                            ASSIGN_TIME_COL: datetime.utcnow().isoformat(),
                        }
                        try:
                            post_headers = dict(headers)
                            post_headers.update({"Prefer": "return=representation", "Content-Type": "application/json"})
                            requests.post(assign_endpoint, headers=post_headers, json=payload, timeout=10)
                        except Exception as e:
                            print("[clip] Supabase assignment insert failed:", repr(e))
                        return {"video_url": video_url, "transcript": transcript_data}
                except Exception as e:
                    print("[clip] Supabase assignment check failed:", repr(e))

            # Fall back to random selection from keep table
            if keep_rows:
                file_name = random.choice(keep_rows).get(SUPABASE_FILE_COL)
                if file_name:
                    video_url = BUNNY_KEEP_URL.rstrip("/") + "/" + str(file_name).lstrip("/")
                    return {"video_url": video_url, "transcript": transcript_data}

        # Fallback: scrape directory listing
        try:
            resp = requests.get(BUNNY_KEEP_URL, timeout=10)
            resp.raise_for_status()
            # Bunny links may include query parameters (e.g. for security tokens).
            # Capture the entire URL up to the closing quote so we keep any
            # required query string instead of stripping it off.
            files = re.findall(r'href="([^" ]+\.mp4[^" ]*)"', resp.text)
            if files:
                choice = random.choice(files)
                if not choice.startswith("http"):
                    video_url = BUNNY_KEEP_URL.rstrip("/") + "/" + choice.lstrip("/")
                else:
                    video_url = choice
                return {"video_url": video_url, "transcript": transcript_data}
        except Exception as e:
            print("[clip] Bunny listing scrape failed:", repr(e))

    sample_json = os.path.join(os.path.dirname(__file__), "..", "public", "sample.json")
    if os.path.exists(sample_json):
        with open(sample_json, "r", encoding="utf-8") as f:
            transcript_data = json.load(f)
    # discourage caching at the edge
    return JSONResponse(
        {"video_url": "/public/sample.mp4", "transcript": transcript_data},
        headers={"Cache-Control": "no-store, no-cache, max-age=0, must-revalidate"},
    )
