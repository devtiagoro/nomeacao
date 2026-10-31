// NOMEIA — service worker.
// Guarda apenas a "casca" do app (HTML/CSS/JS/ícones) para abrir rápido e mostrar a tela offline.
// NUNCA armazena dados do Firebase nem enfileira votos: o banco é a única autoridade.
// Caminhos relativos ao escopo: funciona em subpastas (GitHub Pages).

const CACHE = 'nomeia-shell-v4';
const SHELL = [
  'index.html',
  'votar.html',
  'apresentacao.html',
  'offline.html',
  'css/style.css',
  'css/votar.css',
  'css/apresentacao.css',
  'js/firebase-config.js',
  'js/db.js',
  'js/domain.js',
  'js/common.js',
  'js/index.js',
  'js/votar.js',
  'js/apresentacao.js',
  'js/offline.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

const scoped = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map(scoped)))
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
  if (url.origin !== self.location.origin) return; // Firebase, SDK e CDN: sempre rede, nunca cache
  if (url.pathname.endsWith('admin.html') || url.pathname.includes('js/admin')) return; // painel: sempre rede

  if (req.mode === 'navigate') {
    // Rede primeiro: sempre a versão mais nova da página; offline mostra tela amigável.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(url.origin + url.pathname, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(scoped('offline.html'))) || Response.error()),
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
