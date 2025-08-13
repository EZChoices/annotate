// Kept minimal for backward compat; primary player now in hls-player.js
async function loadSampleVideo(
  video,
  local = '/public/sample.mp4',
  remote = 'https://raw.githubusercontent.com/EZChoices/annotate/main/public/sample.mp4'
){
  if(!video) return;
  try{
    const res = await fetch('/api/clip');
    if(res.ok){
      const data = await res.json();
      if(data && data.video_url){
        video.src = data.video_url;
        return;
      }
    }
  }catch(e){ /* ignore and fall back */ }
  video.src = local;
  video.addEventListener('error', ()=>{ video.src = remote; }, { once:true });
}
window.loadSampleVideo = loadSampleVideo;
