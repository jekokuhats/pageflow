// PageFlow Service Worker - v1.1
// Handles offline caching so the app works once installed

const CACHE_NAME = 'pageflow-v2';

// Core app shell files to cache for offline use
const CORE_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png',
    'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf_viewer.min.css'
];

// Install event: cache core assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing PageFlow Service Worker...');
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // Cache files one by one to not fail everything if one CDN is slow
            return Promise.allSettled(
                CORE_ASSETS.map(url => cache.add(url).catch(e => console.warn('[SW] Failed to cache:', url, e)))
            );
        }).then(() => {
            console.log('[SW] Core assets cached!');
            return self.skipWaiting();
        })
    );
});

// Activate event: clean old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating...');
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch event: serve from cache first, fallback to network
self.addEventListener('fetch', (event) => {
    // Skip for Firebase/API calls - always go live
    const url = event.request.url;
    if (
        url.includes('firebaseapp.com') ||
        url.includes('googleapis.com/identitytoolkit') ||
        url.includes('firestore.googleapis.com') ||
        url.includes('securetoken.googleapis.com')
    ) {
        return; // Let Firebase requests go to network always
    }

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                // Only cache successful GET requests
                if (response && response.status === 200 && event.request.method === 'GET') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                // Offline fallback for HTML pages
                if (event.request.destination === 'document') {
                    return caches.match('/index.html');
                }
            });
        })
    );
});
