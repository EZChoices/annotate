# Annotate

Mobile-friendly annotation app for short social video clips. Frontend is static, backend runs as Vercel Python serverless functions with optional Supabase + Bunny CDN integration.

## Repo Structure

```
annotate/
  vercel.json               # Vercel routes + build settings
  requirements.txt          # Python deps (FastAPI, Uvicorn)

  api/                      # Serverless API functions
    clip.py                 # GET a clip + transcript
    submit.py               # POST annotation/meta to Supabase
    _utils.py               # shared helpers (load JSON, etc.)

  public/                   # Static assets served as-is
    styles.css
    video-utils.js          # shared video loader with fallback
    hls-player.js           # HLS support (not required for MP4)
    meta-v2.js              # Tagging UI logic
    config.js               # loads runtime env vars
    env.example.js          # template for env settings
    sample.mp4              # test clip
    playlist.json           # sample playlist fallback

  meta-v2/                  # UI shell (video + scrollable tags)
    index.html
```

`meta-v2` serves as the metadata UI and is exposed at the root path.

## vercel.json

```json
{
  "version": 2,
  "builds": [
    { "src": "api/*.py", "use": "@vercel/python" },
    { "src": "meta-v2/index.html", "use": "@vercel/static" },
    { "src": "public/**/*", "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "/api/$1.py" },
    { "src": "/public/(.*)", "dest": "/public/$1" },
    { "src": "/(.*)", "dest": "/meta-v2/index.html" }
  ]
}
```

## Bunny CDN configuration

The frontend looks for `window.BUNNY_BASE` when constructing clip URLs. The helper script `public/config.js` populates this value from `public/env.js` at runtime:

1. Copy `public/env.example.js` to `public/env.js`.
2. Set `BUNNY_BASE` to your Bunny pull zone, e.g. `https://MY_PULL_ZONE.b-cdn.net/keep/`.

If not provided, the app warns in the console and falls back to local sample media.

Backend also accepts Bunny base URL via any of:
- `BUNNY_KEEP_URL` (preferred)
- `BUNNY_BASE`
- `BUNNY_PULL_BASE`

## Requirements

```
fastapi
uvicorn
python-multipart
requests
```

## API Summary

### GET /api/clip

Returns a JSON payload with a playable `video_url` plus optional `transcript` array.

If Supabase is configured, the endpoint:
- Reads the `keep` table for file names (configurable via `SUPABASE_KEEP_TABLE` and `SUPABASE_FILE_COL`).
- Returns the first file not yet assigned to an annotator (tracked in `clip_assignments`).
- Records the assignment (annotator id + timestamp) before responding.

Fallbacks:
- If Supabase isn’t configured or fails, tries to scrape a Bunny directory listing.
- Else returns the bundled sample clip.

Environment variables:
- `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SERVICE_KEY` or `SUPABASE_ANON_KEY`
- `SUPABASE_KEEP_TABLE` (default `keep`)
- `SUPABASE_FILE_COL` (default `file_name`)
- `SUPABASE_ASSIGN_TABLE` (default `clip_assignments`)
- `SUPABASE_ASSIGN_FILE_COL` (default `file_name`)
- `SUPABASE_ASSIGN_USER_COL` (default `assigned_to`)
- `SUPABASE_ASSIGN_TIME_COL` (default `assigned_at`)
- `BUNNY_KEEP_URL` or `BUNNY_BASE` or `BUNNY_PULL_BASE`

Tip: Frontend now sends an `annotator` id, derived per-device, when requesting `/api/clip`.

### POST /api/submit

Accepts an annotation payload and persists to Supabase if configured. The table and JSON column can be configured via:
- `SUPABASE_SUBMIT_TABLE` (default `annotations`)
- `SUPABASE_SUBMIT_JSON_COL` (default `data`)

The request may include `?annotator=<id>` to attach to the record. The handler also tries to copy `clip_id` and `src` from the payload into their own columns if present.

Suggested schema:
- `annotations` table with columns:
  - `data` JSONB
  - `annotator` text (optional)
  - `received_at` timestamptz default now() (optional)
  - `clip_id` text (optional)
  - `video_url` text (optional)

## Deployment

1. Ensure `vercel.json` matches this repo.
2. Set environment variables in Vercel Project Settings.
3. Deploy via Vercel (CLI or dashboard).

After deploy:
- Annotators can visit the domain and get live updates.

## Scripts

- `scripts/download_keep_files.py` pulls file names from Supabase and downloads each from Bunny Storage. Requires: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `BUNNY_STORAGE_ZONE`, `BUNNY_STORAGE_PASSWORD`, and optional `FILTERED_FOLDER`.
- `scripts/split_segments.py` splits diarized JSON segments to target lengths (demo).

## Preventing duplicate clip assignments

Create a Supabase `clip_assignments` table with columns:

| column        | purpose                                     |
| ------------- | ------------------------------------------- |
| `file_name`   | name of the clip from the `keep` table      |
| `assigned_to` | identifier for the annotator                |
| `assigned_at` | timestamp of the assignment                 |

Requesting `/api/clip?annotator=alice` returns the first clip not yet assigned and records the assignment before responding.

