"use strict";

const CACHE_NAME = 'ea-stage2-v1';
const STATIC_ASSETS = [
  '/',
  '/stage2',
  '/stage2/index.html',
  '/public/styles.css',
  '/public/idb.js',
  '/stage2/app.js'
];

self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open(CACHE_NAME).then(c=> c.addAll(STATIC_ASSETS)).then(()=> self.skipWaiting()));
});

self.addEventListener('activate', (e)=>{
  e.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(keys.filter(k=> k!==CACHE_NAME).map(k=> caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e)=>{
  const url = new URL(e.request.url);
  // Network-first for API
  if(url.pathname.startsWith('/api/')){
    e.respondWith(fetch(e.request).catch(()=> caches.match(e.request)));
    return;
  }
  // Static: stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then((cached)=>{
      const fetchPromise = fetch(e.request).then(res=>{
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c=> c.put(e.request, copy));
        return res;
      }).catch(()=> cached);
      return cached || fetchPromise;
    })
  );
});

self.addEventListener('sync', (e)=>{
  if(e.tag === 'ea-sync'){
    e.waitUntil((async()=>{
      const clientsList = await self.clients.matchAll({ includeUncontrolled:true });
      for(const cl of clientsList){ cl.postMessage({ type:'ea-sync' }); }
    })());
  }
});
