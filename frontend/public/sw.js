// CACHE_VERSION is replaced with a unique build id at build time (see the
// sw-version plugin in vite.config.ts). A new build yields a new cache name so
// the `activate` handler can purge every previous version's cache.
const CACHE_VERSION = "__BUILD_VERSION__";
const CACHE_NAME = `itransfer-${CACHE_VERSION}`;
// Only precache the app shell. Route-specific documents (e.g. /dashboard) are
// cached fresh on each successful navigation instead of being frozen here.
const PRECACHE_URLS = ["/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Skip non-GET, API calls, and chrome-extension requests
  if (
    request.method !== "GET" ||
    request.url.includes("/api/") ||
    request.url.startsWith("chrome-extension://")
  ) {
    return;
  }

  // Navigation requests: network-first with a stale-while-revalidate shell.
  // Refresh the cached shell on every successful navigation so offline visits
  // don't get stuck on an old bundle reference.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            event.waitUntil(
              caches.open(CACHE_NAME).then((cache) => cache.put("/", clone))
            );
          }
          return response;
        })
        .catch(async () => {
          const cachedShell = await caches.match("/");
          return cachedShell || new Response("Offline", { status: 503 });
        })
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache successful responses for static assets
        if (response.ok && request.url.match(/\.(js|css|png|svg|woff2?)$/)) {
          const clone = response.clone();
          event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
          );
        }
        return response;
      })
      .catch(async () => {
        // Serve from cache as fallback
        const cached = await caches.match(request);
        if (cached) return cached;
        return new Response("Offline", { status: 503 });
      })
  );
});
