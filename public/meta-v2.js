let tags = {
  dialect: null,
  sub_dialect: null,
  accent_notes: [],
  accent_other: "",
  gender: null,
  age: null,
  emotion: [],
  emotion_other: "",
  code_switch: null,
  topic: null,
  topic_other: "",
  environment: null,
  environment_other: "",
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

function loadClip() {
  const video = document.getElementById('videoPlayer');
  video.src = '/public/sample.mp4';
  video.addEventListener('error', () => {
    video.src = 'https://raw.githubusercontent.com/EZChoices/annotate/main/public/sample.mp4';
  });
}

async function submitAnnotation() {
  const payload = { ...tags };
  payload.accent_other = document.getElementById('accentOtherBox').value;
  payload.emotion_other = document.getElementById('emotionOtherBox').value;
  payload.topic_other = document.getElementById('topicOtherBox').value;
  payload.environment_other = document.getElementById('environmentOtherBox').value;
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
