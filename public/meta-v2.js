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
  document.getElementById('videoPlayer').src = data.video_url;
}

function submitAnnotation() {
  alert('📝 Demo mode – answers not saved');
}

document.getElementById('submitBtn').addEventListener('click', submitAnnotation);
document.getElementById('flagBtn').addEventListener('click', () => { alert('🚩 Clip flagged!'); });

loadClip();
