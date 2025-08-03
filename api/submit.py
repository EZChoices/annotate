from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import json

app = FastAPI()

@app.post("/api/submit")
async def submit_annotations(req: Request):
    data = await req.json()
    print("✅ Annotation submitted:", data)
    # 🚀 LATER: Save to Supabase here
    return JSONResponse({"status": "ok", "message": "Annotation received"})
