from fastapi import FastAPI
from fastapi.responses import JSONResponse
import json, os, random, re
import requests

app = FastAPI()

BUNNY_KEEP_URL = os.environ.get("BUNNY_KEEP_URL")
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY")
SUPABASE_TABLE = os.environ.get("SUPABASE_KEEP_TABLE", "keep")
SUPABASE_FILE_COL = os.environ.get("SUPABASE_FILE_COL", "file_name")

@app.get("/api/clip")
async def get_clip():
    """Return a random clip for demo tagging.

    If ``BUNNY_KEEP_URL`` is provided, attempt to fetch a random ``.mp4``
    from that folder. Falls back to the bundled sample clip and transcript
    when no remote video can be retrieved.
    """

    transcript_data = []

    if BUNNY_KEEP_URL:
        # First try Supabase for a list of file names
        if SUPABASE_URL and SUPABASE_KEY:
            try:
                endpoint = f"{SUPABASE_URL}/rest/v1/{SUPABASE_TABLE}?select={SUPABASE_FILE_COL}"
                headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
                resp = requests.get(endpoint, headers=headers, timeout=5)
                resp.raise_for_status()
                rows = resp.json()
                if rows:
                    file_name = random.choice(rows).get(SUPABASE_FILE_COL)
                    if file_name:
                        video_url = BUNNY_KEEP_URL.rstrip("/") + "/" + file_name
                        return {"video_url": video_url, "transcript": transcript_data}
            except Exception:
                pass

        # Fallback: scrape directory listing
        try:
            resp = requests.get(BUNNY_KEEP_URL, timeout=5)
            resp.raise_for_status()
            # Bunny links may include query parameters (e.g. for security tokens).
            # Capture the entire URL up to the closing quote so we keep any
            # required query string instead of stripping it off.
            files = re.findall(r'href="([^" ]+\.mp4[^" ]*)"', resp.text)
            if files:
                choice = random.choice(files)
                if not choice.startswith("http"):
                    video_url = BUNNY_KEEP_URL.rstrip("/") + "/" + choice
                else:
                    video_url = choice
                return {"video_url": video_url, "transcript": transcript_data}
        except Exception:
            pass

    sample_json = os.path.join(os.path.dirname(__file__), "..", "public", "sample.json")
    if os.path.exists(sample_json):
        with open(sample_json, "r", encoding="utf-8") as f:
            transcript_data = json.load(f)
    return {"video_url": "/public/sample.mp4", "transcript": transcript_data}
