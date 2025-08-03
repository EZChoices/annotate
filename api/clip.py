from fastapi import FastAPI
from fastapi.responses import JSONResponse
import json, os

app = FastAPI()

@app.get("/api/clip")
async def get_clip():
    # ✅ Test clip + JSON (later wire Supabase)
    sample_json = os.path.join(os.path.dirname(__file__), "..", "public", "sample.json")
    if not os.path.exists(sample_json):
        return JSONResponse({"error": "No sample JSON found."}, status_code=404)

    with open(sample_json, "r", encoding="utf-8") as f:
        transcript_data = json.load(f)

    return {"video_url": "/public/sample.mp4", "transcript": transcript_data}
