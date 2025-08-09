from fastapi import FastAPI
from fastapi.responses import JSONResponse
import json, os, random, re
import requests

app = FastAPI()

BUNNY_KEEP_URL = os.environ.get("BUNNY_KEEP_URL")

@app.get("/api/clip")
async def get_clip():
    """Return a random clip for demo tagging.

    If ``BUNNY_KEEP_URL`` is provided, attempt to fetch a random ``.mp4``
    from that folder. Falls back to the bundled sample clip and transcript
    when no remote video can be retrieved.
    """

    transcript_data = []

    if BUNNY_KEEP_URL:
        try:
            resp = requests.get(BUNNY_KEEP_URL, timeout=5)
            resp.raise_for_status()
            files = re.findall(r'href="([^"?]+\.mp4)"', resp.text)
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
