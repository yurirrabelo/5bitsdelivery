// Service worker: guarda só a casca do app (HTML, JS, CSS, ícones). Nunca toca em /api, /gps nem /ws.
const CACHE = 'entregador-casca-v1';
const CASCA = [
  '/entregador/',
  '/entregador/app.js',
  '/entregador/entregador.css',
  '/entregador/manifest.webmanifest',
  '/entregador/icone-192.png',
  '/comum/auth.js',
  '/comum/estilo.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CASCA)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (!CASCA.includes(url.pathname)) return; // qualquer outra coisa (API, GPS, WebSocket) vai direto para a rede
  // rede primeiro (pega a versão nova); sem rede, usa a casca guardada
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copia = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request)),
  );
});
