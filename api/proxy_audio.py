from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, Response
from urllib.parse import urlparse, quote
import os
import requests
from requests.utils import requote_uri

DEFAULT_UPSTREAM_HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "*/*"}

app = FastAPI()

BUNNY_KEEP_URL = os.environ.get("BUNNY_KEEP_URL") or os.environ.get("BUNNY_BASE") or os.environ.get("BUNNY_PULL_BASE")
ALLOWED_PROXY_HOSTS = os.environ.get("ALLOWED_PROXY_HOSTS", "")
FROM_EXT = os.environ.get("AUDIO_PROXY_FROM_EXT", ".mp4")
TO_EXT = os.environ.get("AUDIO_PROXY_EXT", ".opus")


def allowed_host(url: str, *, from_src: bool = False) -> bool:
    if from_src:
        return True
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    if host == "dialect-data-videos.b-cdn.net":
        return True
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


def build_bunny_url(path: str) -> tuple[str | None, str | None]:
    base = (BUNNY_KEEP_URL or "").rstrip("/")
    if not base:
        return None, None

    from_ext = FROM_EXT if FROM_EXT.startswith(".") else f".{FROM_EXT}"
    to_ext = TO_EXT if TO_EXT.startswith(".") else f".{TO_EXT}"
    remote_path = quote(path.lstrip("/"), safe="/:")
    remote_path_converted = remote_path

    fallback_src = None
    if remote_path_converted.endswith(from_ext):
        remote_path_converted = remote_path_converted[: -len(from_ext)] + to_ext
        fallback_src = f"{base}/{remote_path}"

    return f"{base}/{remote_path_converted}", fallback_src


def build_streaming_response(req: Request, url: str) -> Response:
    headers = dict(DEFAULT_UPSTREAM_HEADERS)
    if "range" in req.headers:
        headers["Range"] = req.headers["range"]

    try:
        upstream = requests.get(url, headers=headers, stream=True, timeout=30)
    except Exception:
        return Response(status_code=502, content=b"upstream error")

    status = upstream.status_code

    default_type = "application/octet-stream"
    lower_url = url.lower()
    if lower_url.endswith(".opus"):
        default_type = "audio/ogg"
    elif lower_url.endswith(".vtt"):
        default_type = "text/vtt"

    content_type = upstream.headers.get("content-type") or default_type
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


@app.get("/api/proxy_audio")
async def proxy_audio(req: Request, src: str | None = None, file: str | None = None):
    final_src = None
    fallback_src = None

    if file and not src:
        final_src, fallback_src = build_bunny_url(file)
    elif src:
        parsed = urlparse(src)
        if not parsed.scheme or not parsed.netloc:
            return Response(status_code=400, content=b"src must be absolute")
        final_src = requote_uri(src)

    if not final_src:
        return Response(status_code=400, content=b"missing src or file")

    if fallback_src and final_src:
        try:
            head_resp = requests.head(final_src, headers=dict(DEFAULT_UPSTREAM_HEADERS), timeout=10)
            if 400 <= head_resp.status_code < 500:
                final_src = fallback_src
        except Exception:
            pass

    from_src = bool(src)

    if not allowed_host(final_src, from_src=from_src):
        return Response(status_code=403, content=b"host not allowed")

    return build_streaming_response(req, final_src)
