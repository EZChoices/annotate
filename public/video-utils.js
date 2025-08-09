// Utility to attach the sample video with a remote fallback
function loadSampleVideo(video, local = '/public/sample.mp4', remote = 'https://raw.githubusercontent.com/EZChoices/annotate/main/public/sample.mp4') {
  if (!video) return;
  video.src = local;
  video.addEventListener('error', () => {
    video.src = remote;
  }, { once: true });
}

// Expose globally
window.loadSampleVideo = loadSampleVideo;
