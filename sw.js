const CACHE_NAME = "lpg-pos-v9";
const APP_FILES = [
    "./",
    "./index.html",
    "./index.htm",
    "./dashboard.html",
    "./logout.html",
    "./logisticrecord.html",
    "./customers.html",
    "./invoices.html",
    "./product.html",
    "./purchases.html",
    "./reports.html",
    "./returns.html",
    "./sales.html",
    "./seller.html",
    "./settings.html",
    "./user.html",
    "./vendors.html",
    "./script.js",
    "./style.css"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_FILES))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    if (event.request.method !== "GET") return;

    if (event.request.mode === "navigate") {
        event.respondWith(
            fetch(event.request)
                .then(networkResponse => {
                    const responseCopy = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseCopy));
                    return networkResponse;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then(cachedResponse => cachedResponse || fetch(event.request)
                .then(networkResponse => {
                    const responseCopy = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseCopy));
                    return networkResponse;
                })
            )
    );
});
