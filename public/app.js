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
