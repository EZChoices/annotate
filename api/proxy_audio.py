from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, Response
from urllib.parse import urlparse, quote
import os
import requests

app = FastAPI()

BUNNY_KEEP_URL = os.environ.get("BUNNY_KEEP_URL") or os.environ.get("BUNNY_BASE") or os.environ.get("BUNNY_PULL_BASE")
ALLOWED_PROXY_HOSTS = os.environ.get("ALLOWED_PROXY_HOSTS", "")
FROM_EXT = os.environ.get("AUDIO_PROXY_FROM_EXT", ".mp4")
TO_EXT = os.environ.get("AUDIO_PROXY_EXT", ".opus")


def allowed_host(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    allowed = set([h.strip().lower() for h in (ALLOWED_PROXY_HOSTS or "").split(",") if h.strip()])
    bunny_host = None
    if BUNNY_KEEP_URL:
        try:
            bunny_host = (urlparse(BUNNY_KEEP_URL).hostname or "").lower()
        except Exception:
            bunny_host = None
    # Default: if no explicit allowlist provided, restrict to Bunny host only (if available)
    if not allowed:
        if bunny_host:
            allowed.add(bunny_host)
        else:
            return False
    return host in allowed


@app.get("/api/proxy_audio")
async def proxy_audio(req: Request, src: str | None = None, file: str | None = None):
    # Build upstream URL
    fallback_src = None
    if not src and file:
        base = (BUNNY_KEEP_URL or "").rstrip("/")
        from_ext = FROM_EXT if FROM_EXT.startswith(".") else f".{FROM_EXT}"
        to_ext = TO_EXT if TO_EXT.startswith(".") else f".{TO_EXT}"
        remote_path = file.lstrip("/")
        remote_path_converted = remote_path
        if remote_path_converted.endswith(from_ext):
            remote_path_converted = remote_path_converted[: -len(from_ext)] + to_ext
            fallback_src = f"{base}/{remote_path}"
        src = f"{base}/{remote_path_converted}"

    final_src = src

    if fallback_src and src:
        try:
            head_resp = requests.head(src, timeout=10)
            if 400 <= head_resp.status_code < 500:
                final_src = fallback_src
        except Exception:
            pass
    elif not src:
        final_src = None

    if not final_src:
        return Response(status_code=400, content=b"missing src or file")

    if not allowed_host(final_src):
        return Response(status_code=403, content=b"host not allowed")

    # Forward Range header if present
    headers = {}
    if "range" in req.headers:
        headers["Range"] = req.headers["range"]

    try:
        upstream = requests.get(final_src, headers=headers, stream=True, timeout=30)
    except Exception:
        return Response(status_code=502, content=b"upstream error")

    status = upstream.status_code
    # Default content-type for opus
    content_type = upstream.headers.get("content-type") or (
        "audio/ogg" if final_src.lower().endswith(".opus") else "application/octet-stream"
    )
    content_length = upstream.headers.get("content-length")
    content_range = upstream.headers.get("content-range")

    def gen():
        for chunk in upstream.iter_content(chunk_size=64 * 1024):
            if chunk:
                yield chunk

    resp = StreamingResponse(gen(), media_type=content_type, status_code=status)
    if content_length:
        resp.headers["Content-Length"] = content_length
    if content_range:
        resp.headers["Content-Range"] = content_range
    resp.headers["Accept-Ranges"] = "bytes"
    resp.headers["Cache-Control"] = "public, max-age=60"
    return resp
