"use strict";
// Simple HLS player with fallback + PiP helper
window.HLSPlayer = {
  attach(videoEl, src, onError){
    if(!videoEl || !src){ return; }
    const isHls = src.endsWith(".m3u8");
    if(window.Hls && window.Hls.isSupported() && isHls){
      const hls = new window.Hls({ maxBufferLength: 15 });
      hls.loadSource(src);
      hls.attachMedia(videoEl);
      hls.on(window.Hls.Events.ERROR, (_, data)=>{
        if(data && data.fatal && onError) onError(data);
      });
      return ()=> hls.destroy();
    } else {
      // Safari or MP4 fallback
      videoEl.src = src;
      videoEl.addEventListener('error', ()=> onError && onError({fatal:true,type:'MEDIA_ERROR'}), {once:true});
      return ()=>{};
    }
  },
  async requestPiP(videoEl){
    if(!videoEl || !document.pictureInPictureEnabled || videoEl.disablePictureInPicture){ return; }
    try{
      if(document.pictureInPictureElement){
        await document.exitPictureInPicture();
      }else{
        await videoEl.requestPictureInPicture();
        videoEl.addEventListener('leavepictureinpicture', ()=>{
          if(document.pictureInPictureEnabled && !videoEl.paused){
            window.HLSPlayer.requestPiP(videoEl);
          }
        }, { once:true });
      }
    }catch{}
  }
};
