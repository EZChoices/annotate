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
│    ├─ app.js
│
└─ index.html                # Meta tagging UI entrypoint
```

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

### 📄 requirements.txt

```
fastapi
uvicorn
python-multipart
```

---

### 📄 api/clip.py

```python
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

    return {"video_url": "https://test.b-cdn.net/bunny.mp4", "transcript": transcript_data}
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
<html lang='en'>
<head>
  <meta name='viewport' content='width=device-width, initial-scale=1.0'>
  <title>Dialect Data Annotator</title>
  <link rel='stylesheet' href='public/styles.css'>
</head>
<body>
  <div class='container'>
    <h2>Dialect Data Meta Tagging</h2>
    <video id='videoPlayer' src='/sample.mp4' controls autoplay loop muted></video>
    <h3>Transcript Segments</h3>
    <div id='segmentsList'></div>
    <button id='flagBtn' class='flag'>🚩 Flag Clip</button>
    <button id='submitBtn' class='submit'>✅ Save & Next</button>
  </div>
  <script src='public/app.js'></script>
</body>
</html>
```

---

### 📄 public/app.js

```js
let tags = { dialect: null, gender: null, accent: null };
let transcriptSegments = [];

function setTag(type, value) {
  tags[type] = value;
  console.log(`✅ ${type} set to`, value);
}

async function loadClip() {
  const res = await fetch('/api/clip');
  const data = await res.json();

  if (data.error) {
    alert(data.error);
    return;
  }

  document.getElementById('videoPlayer').src = data.video_url;
  transcriptSegments = data.transcript.segments || [];
}

async function submitAnnotation() {
  const payload = { transcript: transcriptSegments, tags };
  await fetch('/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  alert('✅ Annotation submitted!');
}

document.getElementById('submitBtn').addEventListener('click', submitAnnotation);
document.getElementById('flagBtn').addEventListener('click', () => { alert('🚩 Clip flagged!'); });

loadClip();
```

---

### ✅ Instructions for Codex

1️⃣ **Create `vercel.json`** exactly as above.  
2️⃣ **Move all Flask code to `/api` folder** (replace Flask with FastAPI).  
3️⃣ **Move current JS/CSS to `/public`**.  
4️⃣ **Update all API calls in `app.js`** to use `/api/clip` & `/api/submit`.  
5️⃣ **Delete Flask backend** – Vercel will now run `api/*.py` serverless.  
6️⃣ **Ensure `requirements.txt`** lists FastAPI.
7️⃣ Commit + push → Vercel auto-builds → live test link ready.

---

✅ **After Codex push, you just:**
- Run `vercel` (or connect repo to Vercel dashboard)
- Annotators can hit `meta.dialectdata.com` → instantly live updates
