let tags = { dialect: null, gender: null, accent: null };

function setTag(type, value) {
  tags[type] = value;
  console.log(`✅ ${type} set to`, value);
}

async function loadClip() {
  const res = await fetch('http://localhost:5000/clip');
  const data = await res.json();

  if (data.error) {
    alert(data.error);
    return;
  }

  document.getElementById('audioPlayer').src = 'http://localhost:5000' + data.audio_url;
  document.getElementById('transcriptBox').value = JSON.stringify(data.transcript, null, 2);
}

async function submitAnnotation() {
  const transcriptText = document.getElementById('transcriptBox').value;
  const payload = { transcript: transcriptText, tags };

  await fetch('http://localhost:5000/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  alert('✅ Annotation submitted!');
}

document.getElementById('submitBtn').addEventListener('click', submitAnnotation);
document.getElementById('flagBtn').addEventListener('click', () => { alert('🚩 Clip flagged!'); });

loadClip();
