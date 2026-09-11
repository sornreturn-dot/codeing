var VERSION = 'deer-escape-2.1.0';
var SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/style.css?v=2.1.0',
  './assets/js/levels.js?v=2.1.0',
  './assets/js/game.js?v=2.1.0',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-32.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names.filter(function (name) {
          return name !== VERSION;
        }).map(function (name) {
          return caches.delete(name);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function cacheCopy(request, response) {
  if (!response || response.status !== 200) return response;
  var copy = response.clone();
  caches.open(VERSION).then(function (cache) { cache.put(request, copy); });
  return response;
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (response) { return cacheCopy(request, response); })
        .catch(function () {
          return caches.match('./index.html').then(function (hit) {
            return hit || caches.match('./');
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request)
        .then(function (response) { return cacheCopy(request, response); })
        .catch(function () { return hit; });
    })
  );
});
