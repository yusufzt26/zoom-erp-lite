/* ZT-ERP LITE service worker.
   Lets Chrome install the app. Pages always load fresh from the server, so
   staff never see stale data; when there is no internet the app shows a small
   "No internet" page instead of Chrome's error. API calls are never touched. */
const CACHE = "zt-erp-shell-v2";
const SHELL = ["/offline.html", "/icon-192.png", "/icon-512.png", "/favicon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.netlify/")) return;

  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
    return;
  }
  if (SHELL.includes(url.pathname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
  }
});
