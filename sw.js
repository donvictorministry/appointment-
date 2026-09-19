"use strict";

// Appointment Chat — Service Worker (dv build)
// - Precaches the app shell (same-origin).
// - Explicitly does NOT restrict fetch handling to same-origin, so profile
//   photos or other images hosted on a different domain (e.g. your photo
//   host, a CDN) are still fetched and cached — cross-origin image
//   responses are typically "opaque" (status unreadable to JS) but remain
//   perfectly cacheable and displayable, so we cache them as-is.
// - Network-first for the GAS API calls (never serve stale chat data from
//   cache); cache-first for the app shell and images.

var DV_CACHE_NAME = "dv-cache-v3";
var DV_SHELL_FILES = [
  "./index.html",
  "./manifest.json",
  "./styles.css",
  "./scripts.js"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(DV_CACHE_NAME).then(function (cache) {
      return cache.addAll(DV_SHELL_FILES);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== DV_CACHE_NAME; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

function dvIsImageRequest(request) {
  if (request.destination === "image") return true;
  var url = request.url.toLowerCase();
  return /\.(png|jpg|jpeg|gif|webp|svg|ico)(\?.*)?$/.test(url);
}

function dvIsApiRequest(request) {
  // Any POST (Apps Script calls) or a request whose URL contains
  // "script.google.com" — never served from cache.
  return request.method === "POST" || request.url.indexOf("script.google.com") !== -1;
}

self.addEventListener("fetch", function (event) {
  var request = event.request;

  // Never intercept non-GET (POST bodies aren't cacheable / must always hit network)
  if (request.method !== "GET") return;

  // API traffic: always network, never cached, works for cross-origin GAS calls too.
  if (dvIsApiRequest(request)) {
    event.respondWith(fetch(request).catch(function () {
      return new Response(JSON.stringify({ ok: false, error: "Offline." }), {
        headers: { "Content-Type": "application/json" }
      });
    }));
    return;
  }

  // Images (same-origin OR cross-origin/different host): cache-first,
  // fall back to network, cache whatever comes back — including opaque
  // cross-origin responses. No origin check here on purpose.
  if (dvIsImageRequest(request)) {
    event.respondWith(
      caches.match(request).then(function (cached) {
        if (cached) return cached;
        return fetch(request).then(function (response) {
          // response may be "opaque" for cross-origin images (status 0) —
          // still cacheable and still usable as an <img> src.
          var copy = response.clone();
          caches.open(DV_CACHE_NAME).then(function (cache) { cache.put(request, copy); });
          return response;
        }).catch(function () { return cached; });
      })
    );
    return;
  }

  // App shell / everything else: cache-first, network fallback, update cache in background.
  event.respondWith(
    caches.match(request).then(function (cached) {
      var networkFetch = fetch(request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(DV_CACHE_NAME).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () { return cached; });
      return cached || networkFetch;
    })
  );
});
