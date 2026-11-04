/* Offline shell for the Dealer Credit Ledger (FR-086).
   Caches the app page, its script, icons and fonts so the app opens without signal.
   Ledger data is never cached here: shim.js keeps the collector's data in IndexedDB
   and queues offline payments. Signing out clears this cache. */
"use strict";
const SHELL = "dcl-shell-v5";
const STATIC = ["/shim.js", "/fonts.js", "/credit.js", "/app.js", "/ops.js", "/app.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(STATIC)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", (e) => {
  if (e.data === "clear") e.waitUntil(caches.delete(SHELL));
});

async function networkFirst(req, key) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    // A redirect to /login means signed out: forget the cached app page.
    if (res.redirected || !res.ok) { if (key === "/" && res.redirected) await cache.delete("/"); return res; }
    await cache.put(key || req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key || req);
    if (hit) return hit;
    if (req.mode === "navigate") return new Response('<!doctype html><meta name="viewport" content="width=device-width"><title>Offline</title><body style="font:16px system-ui;padding:24px"><h1>You\'re offline</h1><p>Open the ledger once while connected, then it will work without signal.</p></body>', { headers: { "Content-Type": "text/html; charset=utf-8" } });
    throw err;
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_blob/") || url.pathname === "/sw.js") return;
    if (req.mode === "navigate" && url.pathname === "/") return e.respondWith(networkFirst(req, "/"));
    if (STATIC.includes(url.pathname)) return e.respondWith(networkFirst(req));
    return;
  }
  // Fonts: use the cached copy, refresh it in the background.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(req);
      const fresh = fetch(req).then((res) => { if (res.ok || res.type === "opaque") cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || fresh;
    }));
  }
});

/* Phone notifications. The message is generic; the app shows the details once opened. */
self.addEventListener("push", (e) => {
  let m = {}; try { m = e.data.json(); } catch (err) { /* empty message */ }
  e.waitUntil(self.registration.showNotification(m.title || "Dealer Credit Ledger", { body: m.body || "", icon: "/icon-192.png", badge: "/icon-192.png", data: { url: m.url || "/" } }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow(e.notification.data.url))));
});
