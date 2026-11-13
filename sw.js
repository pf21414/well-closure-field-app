/* Offline support: keep the app and the well data on the device.
   Bump VERSION whenever app files or data change so phones pick up the new copy. */
const VERSION = "wcfa-v0.2.0";
const FILES = ["./", "index.html", "app.css", "app.js", "checklists.js", "manifest.webmanifest", "icon.svg",
  "data/wells_b64.txt", "data/wells_ids.txt", "data/wells_meta.json", "data/basemap.json"];
self.addEventListener("install", e => e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, {ignoreSearch:true}).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok && new URL(e.request.url).origin === location.origin) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => hit)));
});
