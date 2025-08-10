// Kept minimal for backward compat; primary player now in hls-player.js
function loadSampleVideo(video, local='/public/sample.mp4', remote='https://raw.githubusercontent.com/EZChoices/annotate/main/public/sample.mp4'){
  if(!video) return;
  video.src = local;
  video.addEventListener('error', ()=>{ video.src = remote; }, { once:true });
}
window.loadSampleVideo = loadSampleVideo;
