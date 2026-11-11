// Keeps the officer dashboard available with no internet (data itself is saved on-device and synced later).
const CACHE = "forest-shell-v4";
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => fetch("/forest-dashboard.html", { cache: "no-store" })
    .then(r => { if (r.ok && !r.redirected) return c.put("/forest-dashboard.html", r); }).catch(() => { })).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname !== "/forest-dashboard.html") return;
  e.respondWith(
    fetch(e.request).then(r => {
      // do not cache the login redirect (user not logged in)
      if (r.ok && !r.redirected) { const c = r.clone(); caches.open(CACHE).then(x => x.put("/forest-dashboard.html", c)); }
      return r;
    }).catch(() => caches.match("/forest-dashboard.html").then(r => r || Response.error()))
  );
});
