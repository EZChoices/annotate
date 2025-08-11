### 🏗 Repo Structure (for Vercel)

```
annotate/
│  vercel.json               # Vercel routes + build settings
│  requirements.txt          # Python deps (FastAPI, Uvicorn)
│
├─ api/                      # Serverless API functions
│    ├─ clip.py               # GET a clip + transcript
│    ├─ submit.py             # POST annotation/meta to Supabase (later)
│    └─ _utils.py             # shared helpers (load JSON, etc.)
│
├─ public/                   # Static assets served as-is
│    ├─ styles.css
│    ├─ video-utils.js       # shared video loader with fallback
│    ├─ meta.js             # tag-selection helpers
│    ├─ config.js           # loads runtime env vars
│    ├─ env.example.js      # template for env settings
│    └─ sample.mp4          # test clip
│
└─ index.html               # Metadata tagging interface
```

Legacy `meta-v1` and `meta-v2` pages have been removed; the metadata UI now lives at the root `index.html`.

---

### 📄 vercel.json

```json
{
  "version": 2,
  "builds": [
    { "src": "api/*.py", "use": "@vercel/python" },
    { "src": "index.html", "use": "@vercel/static" },
    { "src": "public/**/*", "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "/api/$1.py" },
    { "src": "/(.*)", "dest": "/index.html" }
  ]
}
```

---

### Bunny CDN configuration

`public/app.js` builds clip URLs using `window.BUNNY_BASE`. At runtime this value is loaded from `public/env.js`:

1. Copy `public/env.example.js` to `public/env.js`.
2. Set `BUNNY_BASE` to your Bunny pull zone, e.g. `https://MY_PULL_ZONE.b-cdn.net/keep/`.

If not provided, the app warns in the console and falls back to local sample media.

---

### 📄 requirements.txt

```
fastapi
uvicorn
python-multipart
requests
```

---

### 📄 api/clip.py

```python
from fastapi import FastAPI
import json, os, random, re, requests

app = FastAPI()
BUNNY_KEEP_URL = os.environ.get("BUNNY_KEEP_URL")

@app.get("/api/clip")
async def get_clip():
    """Return demo clip metadata with Bunny CDN fallback."""
    transcript = []

    if BUNNY_KEEP_URL:
        try:
            resp = requests.get(BUNNY_KEEP_URL, timeout=5)
            resp.raise_for_status()
            files = re.findall(r'href="([^"?]+\.mp4)"', resp.text)
            if files:
                choice = random.choice(files)
                url = choice if choice.startswith("http") else BUNNY_KEEP_URL.rstrip("/") + "/" + choice
                return {"video_url": url, "transcript": transcript}
        except Exception:
            pass

    sample_json = os.path.join(os.path.dirname(__file__), "..", "public", "sample.json")
    if os.path.exists(sample_json):
        with open(sample_json, "r", encoding="utf-8") as f:
            transcript = json.load(f)
    return {"video_url": "/public/sample.mp4", "transcript": transcript}
```

---

### 📄 api/submit.py

```python
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
```

---

### 📄 index.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Metadata Tagging</title>
  <link rel="stylesheet" href="/public/styles.css">
</head>
<body>
  <!-- Tagging UI omitted for brevity -->
  <script src="/public/video-utils.js"></script>
  <script src="/public/meta.js"></script>
</body>
</html>
```

---

### 📄 public/meta.js

```js
const tags = {
  accent_notes: [],
  emotion: []
};

function setTag(key, value, btn){
  tags[key] = value;
  document.querySelectorAll(`[data-set-tag="${key}"]`).forEach(b => {
    b.classList.toggle('selected', b === btn);
  });
}

// additional helpers handle multi-select toggles and submission
```

---

### ✅ Instructions for Codex

1️⃣ **Create `vercel.json`** exactly as above.  
2️⃣ **Move all Flask code to `/api` folder** (replace Flask with FastAPI).  
3️⃣ **Move current JS/CSS to `/public`**.  
4️⃣ **Update all API calls in the JS** to use `/api/clip` & `/api/submit`.
5️⃣ **Delete Flask backend** – Vercel will now run `api/*.py` serverless.  
6️⃣ **Ensure `requirements.txt`** lists FastAPI.
7️⃣ Commit + push → Vercel auto-builds → live test link ready.

---

✅ **After Codex push, you just:**
- Run `vercel` (or connect repo to Vercel dashboard)
- Annotators can hit `meta.dialectdata.com` → instantly live updates
