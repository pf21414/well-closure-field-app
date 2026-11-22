/* Offline support: keep the app and the well data on the device.
   Bump VERSION whenever app files or data change so phones pick up the new copy.
   App files (html, css, js) are network-first so an update shows on the next open with signal;
   the large well data in data/ is cache-first. Installs bypass the browser's HTTP cache. */
const VERSION = "wcfa-v0.3.1";
const FILES = ["./", "index.html", "app.css", "app.js", "checklists.js", "supabase.js", "sync.js", "manifest.webmanifest", "icon.svg",
  "data/wells_b64.txt", "data/wells_ids.txt", "data/wells_meta.json", "data/basemap.json"];
self.addEventListener("install", e => e.waitUntil(caches.open(VERSION)
  .then(c => c.addAll(FILES.map(f => new Request(f, {cache:"reload"}))))
  .then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys()
  .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
  .then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const put = r => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; };
  if (url.pathname.includes("/data/")) {
    e.respondWith(caches.match(req, {ignoreSearch:true}).then(hit => hit || fetch(req).then(put)));
  } else {
    e.respondWith(fetch(req, {cache:"no-cache"}).then(put).catch(() => caches.match(req, {ignoreSearch:true})));
  }
});
