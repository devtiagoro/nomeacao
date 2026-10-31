// NOMEIA — service worker.
// Guarda apenas a "casca" do app (HTML/CSS/JS/ícones) para abrir rápido e mostrar a tela offline.
// NUNCA armazena respostas de /api nem enfileira votos: o servidor é a única autoridade.

const CACHE = 'nomeia-shell-v2';
const SHELL = [
  '/index.html',
  '/votar.html',
  '/apresentacao.html',
  '/offline.html',
  '/css/style.css',
  '/css/votar.css',
  '/css/apresentacao.css',
  '/js/common.js',
  '/js/index.js',
  '/js/votar.js',
  '/js/apresentacao.js',
  '/js/offline.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST (votos) sempre vai direto à rede.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return; // estado sempre do servidor
  if (url.pathname === '/admin.html' || url.pathname.startsWith('/js/admin')) return;

  if (req.mode === 'navigate') {
    // Rede primeiro: sempre a versão mais nova da página; offline mostra tela amigável.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(url.pathname, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match('/offline.html')) || Response.error()),
    );
    return;
  }

  // Arquivos estáticos: rede primeiro com fallback ao cache (evita versões antigas de JS).
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && url.search === '') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) || Response.error()),
  );
});
