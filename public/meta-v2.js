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

function toggleAccent(value, btn){
  const set = new Set(tags.accent_notes);
  if(set.has(value)){
    set.delete(value);
    btn.classList.remove('selected');
  } else {
    set.add(value);
    btn.classList.add('selected');
  }
  tags.accent_notes = Array.from(set);
}

function toggleEmotion(value, btn){
  const set = new Set(tags.emotion);
  if(set.has(value)){
    set.delete(value);
    btn.classList.remove('selected');
  } else {
    set.add(value);
    btn.classList.add('selected');
  }
  tags.emotion = Array.from(set);
}

async function submitAnnotation(){
  try{
    const res = await fetch('/api/submit', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ tags })
    });
    const data = await res.json();
    alert(data.message || 'Annotation submitted');
  }catch(e){
    alert('Failed to submit annotation');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('videoPlayer');
  if(video){
    video.muted = true;
    const startPlayback = () => { video.play().catch(()=>{}); };
    document.addEventListener('click', startPlayback, { once: true });
    document.addEventListener('touchstart', startPlayback, { once: true });
    loadSampleVideo(video);

    // Prevent mobile browsers from forcing fullscreen playback
    const keepInline = () => {
      if(document.fullscreenElement === video){
        document.exitFullscreen().catch(()=>{});
      }
      if(video.webkitDisplayingFullscreen){
        video.webkitExitFullscreen();
      }
    };
    video.addEventListener('fullscreenchange', keepInline);
    video.addEventListener('webkitbeginfullscreen', keepInline);
  }

  document.querySelectorAll('[data-set-tag]').forEach(btn => {
    btn.addEventListener('click', () => setTag(btn.dataset.setTag, btn.dataset.value, btn));
  });
  document.querySelectorAll('[data-toggle-accent]').forEach(btn => {
    btn.addEventListener('click', () => toggleAccent(btn.dataset.value, btn));
  });
  document.querySelectorAll('[data-toggle-emotion]').forEach(btn => {
    btn.addEventListener('click', () => toggleEmotion(btn.dataset.value, btn));
  });

  const accentOther = document.getElementById('accentOtherBox');
  if(accentOther) accentOther.addEventListener('input', e => { tags.accent_other = e.target.value; });
  const emotionOther = document.getElementById('emotionOtherBox');
  if(emotionOther) emotionOther.addEventListener('input', e => { tags.emotion_other = e.target.value; });
  const topicOther = document.getElementById('topicOtherBox');
  if(topicOther) topicOther.addEventListener('input', e => { tags.topic_other = e.target.value; });
  const envOther = document.getElementById('environmentOtherBox');
  if(envOther) envOther.addEventListener('input', e => { tags.environment_other = e.target.value; });

  const dark = document.getElementById('darkModeBtn');
  if(dark) dark.addEventListener('click', () => {
    document.documentElement.classList.toggle('dark');
    document.body.classList.toggle('dark');
  });
  const flag = document.getElementById('flagBtn');
  if(flag) flag.addEventListener('click', () => { tags.flagged = true; alert('🚩 Clip flagged'); });
  const submit = document.getElementById('submitBtn');
  if(submit) submit.addEventListener('click', submitAnnotation);

  const wrapper = document.getElementById('video-wrapper');
  const toggleBtn = document.getElementById('videoToggle');
  if(wrapper){
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if(entry.isIntersecting){
          wrapper.classList.remove('mini');
        } else {
          wrapper.classList.add('mini');
        }
      });
    });
    observer.observe(wrapper);
  }
  if(toggleBtn && wrapper){
    toggleBtn.addEventListener('click', () => {
      wrapper.classList.toggle('mini');
    });
  }
});
