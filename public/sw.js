// NOMEIA — o app não usa mais service worker.
// Este arquivo existe só para remover o service worker e o cache instalados por versões
// anteriores nos aparelhos que já abriram o site. Pode ser apagado depois de algumas reuniões.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister()),
  );
});
