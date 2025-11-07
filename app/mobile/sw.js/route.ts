const SW_SOURCE = `
const SHELL_CACHE = "dd-shell-v1";
const AUDIO_CACHE = "dd-audio-v1";
const SUBMIT_QUEUE = "dd-submit";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(["/mobile"]))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => ![SHELL_CACHE, AUDIO_CACHE].includes(key))
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/mobile")) {
    return;
  }

  if (request.url.includes(".m3u8") || request.url.includes(".mp3") || request.url.includes(".aac")) {
    event.respondWith(cacheFirst(request, AUDIO_CACHE));
    return;
  }

  if (request.method === "GET") {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkFetch = fetch(request).then((response) => {
    cache.put(request, response.clone());
    return response;
  });
  return cached || networkFetch;
}

self.addEventListener("sync", (event) => {
  if (event.tag === SUBMIT_QUEUE) {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) =>
          client.postMessage({ type: "dd-sync" })
        );
      })
    );
  }
});
`;

export async function GET() {
  return new Response(SW_SOURCE, {
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-store",
    },
  });
}
