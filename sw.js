/* Guarda la app en el dispositivo para que abra rápido y funcione sin conexión
   (salvo leer fotos por primera vez, que necesita descargar el idioma). */
const CACHE = 'leemelo-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const lib = /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|tessdata/.test(url.host + url.pathname);
  if (url.origin !== location.origin && !lib) return;
  // Red primero (para recibir mejoras); si no hay conexión, lo guardado
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r && (r.ok || r.type === 'opaque')) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match('index.html')))
  );
});
