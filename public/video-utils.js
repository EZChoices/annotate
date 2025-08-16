// Kept minimal for backward compat; primary player now in hls-player.js
async function loadSampleVideo(
  video,
  local = '/public/sample.mp4',
  remote = 'https://raw.githubusercontent.com/EZChoices/annotate/main/public/sample.mp4'
){
  if(!video) return;
  try{
    // Cache-bust so the backend can serve a different clip each time
    const res = await fetch(`/api/clip?rand=${Date.now()}`, {cache:'no-store'});
    if(res.ok){
      const data = await res.json();
      // Only use clip if backend returned a real file, not the bundled sample
      if(data && data.video_url && !data.video_url.includes('sample.mp4')){
        // Append timestamp to bypass any CDN caching
        const sep = data.video_url.includes('?') ? '&' : '?';
        video.src = `${data.video_url}${sep}t=${Date.now()}`;
        return;
      }
    }
  }catch(e){ /* ignore and fall back */ }

  // Fallback: pick a random clip from local playlist if available
  try{
    const plist = await fetch('/public/playlist.json', {cache:'no-store'});
    if(plist.ok){
      const j = await plist.json();
      const clips = Array.isArray(j.clips) ? j.clips : [];
      if(clips.length){
        const choice = clips[Math.floor(Math.random()*clips.length)];
        if(choice && choice.src){
          // Bust cache for local files as well
          const sep = choice.src.includes('?') ? '&' : '?';
          video.src = `${choice.src}${sep}t=${Date.now()}`;
          return;
        }
      }
    }
  }catch(e){ /* ignore and fall back */ }

  video.src = local;
  video.addEventListener('error', ()=>{ video.src = remote; }, { once:true });
}
window.loadSampleVideo = loadSampleVideo;
