/* ZT-ERP LITE service worker.
   Lets Chrome install the app. Pages always load fresh from the server, so
   staff never see stale data; when there is no internet the app shows a small
   "No internet" page instead of Chrome's error. API calls are never touched. */
const CACHE = "zt-erp-shell-v3";
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

/* Phone pop-up notifications (Web Push). The server sends { title, body, tag, url };
   tapping the pop-up opens the ERP (or brings it to the front) on the page the alert is about. */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "ZT-ERP", {
    body: d.body || "",
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: "/icon-192.png",
    badge: "/favicon.png",
    data: { url: d.url || "/" },
    vibrate: [120, 60, 120]
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins.find(c => new URL(c.url).origin === self.location.origin);
    if (w) { w.postMessage({ type: "zt-go", url }); return w.focus(); }
    return self.clients.openWindow(url);
  })());
});

/* the browser renewed this device's notification address: tell the ERP so alerts keep coming */
self.addEventListener("pushsubscriptionchange", e => {
  e.waitUntil((async () => {
    const old = e.oldSubscription, opts = old && old.options;
    if (!opts || !opts.applicationServerKey) return;
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: opts.applicationServerKey });
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    wins.forEach(c => c.postMessage({ type: "zt-resub", sub: sub.toJSON(), old: old.endpoint }));
  })());
});
