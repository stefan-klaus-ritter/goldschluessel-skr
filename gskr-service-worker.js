/**
 * GSKR Service Worker — PWA-Offline-Schicht
 * v1.7.0-SHOCK · 06.06.2026
 *
 * Strategie:
 *  - Cache-First für Apps + statische Assets (offline-fähig)
 *  - Network-First für Nextcloud-WebDAV (immer aktuell, wenn möglich)
 *  - Background Sync für PUT-Uploads (laufen weiter wenn Browser geschlossen)
 *  - Push-Benachrichtigungen für „Gutachten fertig"
 *  - Auto-Update mit skipWaiting beim Versions-Bump
 */
const VERSION = 'gskr-v1.7.0-SHOCK';
const APP_CACHE   = 'gskr-app-'    + VERSION;
const DATA_CACHE  = 'gskr-data-'   + VERSION;

const PRECACHE = [
  './',
  './BaudokuXtremFinally_v1.7-SHOCK.html',
  './App1_Kaeufer_v4.7-SHOCK.html',
  './App2_SV_v4.7-SHOCK.html',
  './App3_Goldschluessel_v3.2-SHOCK.html',
  './gskr-nextcloud.js',
  './gskr-apollon.js',
  './gskr-crypto.js',
  './gskr-manifest.json'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(APP_CACHE).then(c => c.addAll(PRECACHE.map(u => new Request(u, {cache: 'reload'}))))
      .catch(err => console.warn('[SW] precache partial:', err))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== APP_CACHE && k !== DATA_CACHE && k.startsWith('gskr-'))
          .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Nextcloud-WebDAV-Requests → Network-First mit Cache-Fallback
  if (url.pathname.includes('/public.php/webdav') || url.pathname.includes('/remote.php/dav')) {
    e.respondWith(
      fetch(e.request.clone())
        .then(resp => {
          if (e.request.method === 'GET' && resp.ok) {
            const respClone = resp.clone();
            caches.open(DATA_CACHE).then(c => c.put(e.request, respClone));
          }
          return resp;
        })
        .catch(() => caches.match(e.request).then(cached => {
          if (cached) return cached;
          return new Response(JSON.stringify({ offline: true, error: 'no-cache' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } });
        }))
    );
    return;
  }

  // Statische Assets → Cache-First
  if (e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) {
          // Stale-while-revalidate
          fetch(e.request).then(resp => {
            if (resp.ok) caches.open(APP_CACHE).then(c => c.put(e.request, resp.clone()));
          }).catch(() => {});
          return cached;
        }
        return fetch(e.request).then(resp => {
          if (resp.ok && url.origin === location.origin) {
            const respClone = resp.clone();
            caches.open(APP_CACHE).then(c => c.put(e.request, respClone));
          }
          return resp;
        }).catch(() => new Response('Offline', { status: 503 }));
      })
    );
  }
});

// ── Background Sync ──────────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'gskr-nextcloud-sync') {
    e.waitUntil(syncPendingUploads());
  }
});

async function syncPendingUploads() {
  const db = await openSWDB();
  const tx = db.transaction('uploads', 'readonly');
  const all = await new Promise(res => {
    const req = tx.objectStore('uploads').getAll();
    req.onsuccess = () => res(req.result || []);
  });
  for (const u of all) {
    try {
      const headers = u.headers || {};
      const r = await fetch(u.url, { method: 'PUT', headers: headers, body: u.blob });
      if (r.ok) {
        const txd = db.transaction('uploads', 'readwrite');
        txd.objectStore('uploads').delete(u.id);
      }
    } catch (err) {
      console.warn('[SW] sync fail', u.id, err);
    }
  }
}

function openSWDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('GSKR_NEXTCLOUD_BUFFER', 1);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

// ── Push-Notifications ───────────────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: 'Goldschlüssel SKR', body: 'Neue Mitteilung.' };
  e.waitUntil(self.registration.showNotification(data.title || 'Goldschlüssel SKR', {
    body: data.body || '',
    icon: data.icon || './icon-192.png',
    badge: './badge-72.png',
    tag: data.tag || 'gskr',
    data: data.url ? { url: data.url } : {}
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) {
      if (c.url.includes(url) && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});

console.log('[SW] GSKR Service Worker', VERSION, 'aktiv');
