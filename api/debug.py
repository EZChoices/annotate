from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
import os
import requests

app = FastAPI()

@app.get("/api/debug")
async def debug(annotator: str = Query("anonymous")):
    info = {
        "env": {
            "BUNNY_KEEP_URL": bool(os.environ.get("BUNNY_KEEP_URL") or os.environ.get("BUNNY_BASE") or os.environ.get("BUNNY_PULL_BASE")),
            "SUPABASE_URL": bool(os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")),
            "SUPABASE_KEY": bool(os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY")),
        },
        "clip_endpoint": "/api/clip?annotator=...",
        "tasks_endpoint": "/api/tasks?stage=2&annotator_id=...",
    }
    return JSONResponse(info, headers={"Cache-Control": "no-store"})

