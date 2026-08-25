const CACHE_NAME = "lpg-pos-v2";
const APP_FILES = [
    "./",
    "./index.html",
    "./login.html",
    "./logout.html",
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
