(function(){
  var env = window.__env || {};
  if(!window.BUNNY_BASE && env.BUNNY_BASE){
    window.BUNNY_BASE = env.BUNNY_BASE;
  }
  if(!window.BUNNY_BASE){
    console.warn('BUNNY_BASE not configured; video playback may fail.');
  }
})();
