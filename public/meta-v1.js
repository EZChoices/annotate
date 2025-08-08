document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('video');
  video.src = '/public/sample.mp4';
  video.addEventListener('error', () => {
    video.src = 'https://raw.githubusercontent.com/EZChoices/annotate/main/public/sample.mp4';
  });

  document.getElementById('submitBtn').addEventListener('click', () => {
    const form = document.getElementById('metaForm');
    const data = {};

    ['dialect', 'sub_dialect', 'gender', 'age', 'code_switch', 'topic', 'environment', 'face_visible', 'lip_visible', 'gestures_visible'].forEach(name => {
      data[name] = form.elements[name].value || null;
    });

    data.accent_notes = Array.from(form.querySelectorAll('input[name="accent_notes"]:checked')).map(cb => cb.value);
    data.emotion = Array.from(form.querySelectorAll('input[name="emotion"]:checked')).map(cb => cb.value);

    data.accent_other = form.elements['accent_other'].value;
    data.emotion_other = form.elements['emotion_other'].value;
    data.topic_other = form.elements['topic_other'].value;
    data.environment_other = form.elements['environment_other'].value;

    console.log('Submitted:', data);
    alert('✅ Annotation submitted!');
  });

  document.getElementById('flagBtn').addEventListener('click', () => {
    alert('🚩 Clip flagged!');
  });
});
