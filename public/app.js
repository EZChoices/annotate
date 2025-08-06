let tags = {
  dialect: null,
  sub_dialect: null,
  accent_notes: [],
  gender: null,
  age: null,
  emotion: [],
  code_switch: null,
  topic: null,
  environment: null,
  face_visible: null,
  lip_visible: null,
  gestures_visible: null
};

function setTag(type, value) {
  tags[type] = value;
  console.log(`✅ ${type} set to`, value);
}

function toggleAccent(value) {
  if (tags.accent_notes.includes(value)) {
    tags.accent_notes = tags.accent_notes.filter(v => v !== value);
  } else {
    tags.accent_notes.push(value);
  }
  console.log('✅ Accent Notes:', tags.accent_notes);
}

function toggleEmotion(value) {
  if (tags.emotion.includes(value)) {
    tags.emotion = tags.emotion.filter(v => v !== value);
  } else {
    tags.emotion.push(value);
  }
  console.log('✅ Emotions:', tags.emotion);
}

function toggleDarkMode() {
  document.body.classList.toggle('dark');
}

async function loadClip() {
  const res = await fetch('/api/clip');
  const data = await res.json();

  if (data.error) {
    alert(data.error);
    return;
  }

  const video = document.getElementById('videoPlayer');
  const source = video.querySelector('source');
  if (source) {
    source.src = data.video_url;
    video.load();
  } else {
    video.src = data.video_url;
  }
}

async function submitAnnotation() {
  const payload = { ...tags };
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
