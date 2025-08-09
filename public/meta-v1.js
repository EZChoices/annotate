document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('video');
  loadSampleVideo(video);

  document.getElementById('submitBtn').addEventListener('click', async () => {
    const form = document.getElementById('metaForm');
    const payload = {};

    [
      'dialect', 'sub_dialect', 'gender', 'age', 'code_switch', 'topic',
      'environment', 'face_visible', 'lip_visible', 'gestures_visible'
    ].forEach(name => {
      payload[name] = form.elements[name].value || null;
    });

    payload.accent_notes = Array.from(form.querySelectorAll('input[name="accent_notes"]:checked')).map(cb => cb.value);
    payload.emotion = Array.from(form.querySelectorAll('input[name="emotion"]:checked')).map(cb => cb.value);

    payload.accent_other = form.elements['accent_other'].value;
    payload.emotion_other = form.elements['emotion_other'].value;
    payload.topic_other = form.elements['topic_other'].value;
    payload.environment_other = form.elements['environment_other'].value;
    payload.code_switch_other = form.elements['code_switch_other'].value;

    await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    alert('✅ Annotation submitted!');
  });

  document.getElementById('flagBtn').addEventListener('click', () => {
    alert('🚩 Clip flagged!');
  });
});
