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
  const video = document.getElementById('videoPlayer') || document.getElementById('video');
  if (!video) return;
  try {
    const res = await fetch('/api/clip');
    const data = await res.json();
    if (data.error || !data.video_url) {
      loadSampleVideo(video);
    } else {
      video.src = data.video_url;
    }
  } catch (err) {
    loadSampleVideo(video);
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

function initApp() {
  document.querySelectorAll('[data-set-tag]').forEach(btn => {
    btn.addEventListener('click', () => setTag(btn.dataset.setTag, btn.dataset.value));
  });
  document.querySelectorAll('[data-toggle-accent]').forEach(btn => {
    btn.addEventListener('click', () => toggleAccent(btn.dataset.value));
  });
  document.querySelectorAll('[data-toggle-emotion]').forEach(btn => {
    btn.addEventListener('click', () => toggleEmotion(btn.dataset.value));
  });

  const dark = document.getElementById('darkModeBtn');
  if (dark) dark.addEventListener('click', toggleDarkMode);
  const submit = document.getElementById('submitBtn');
  if (submit) submit.addEventListener('click', submitAnnotation);
  const flag = document.getElementById('flagBtn');
  if (flag) flag.addEventListener('click', () => alert('🚩 Clip flagged!'));

  loadClip();
}

document.addEventListener('DOMContentLoaded', initApp);
