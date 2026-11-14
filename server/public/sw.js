// Service worker: ให้ติดตั้งเป็นแอปได้ เปิดหน้าแอปได้แม้เน็ตแกว่ง และกดแจ้งเตือนแล้วกลับเข้าแอป
// หน้าเว็บ: ลองเน็ตก่อน (ได้เวอร์ชันใหม่เสมอ) ถ้าไม่มีเน็ตใช้ของที่เก็บไว้ · /api และ WebSocket ไม่ผ่าน cache
const CACHE = 'wormadi-v45';
// (index.html / log.html are cached when visited: Cloudflare redirects *.html to clean URLs)
const SHELL = ['./', 'theme.css', 'app.css', 'app.js', 'manifest.webmanifest', 'vendor/qrcode.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-180.png', 'brand/logo.png', 'brand/app-icon.png', 'brand/wordmark.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./')))
  );
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || './');
  }));
});

// ---- Web Push: an SOS while the app is closed. The push has no content; read the latest SOS from the server.
const kv = key => new Promise(res => {
  const o = indexedDB.open('wormadi', 1);
  o.onupgradeneeded = () => o.result.createObjectStore('kv');
  o.onsuccess = () => { const r = o.result.transaction('kv').objectStore('kv').get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); };
  o.onerror = () => res(null);
});
const kvPut = (key, val) => new Promise(res => {
  const o = indexedDB.open('wormadi', 1);
  o.onupgradeneeded = () => o.result.createObjectStore('kv');
  o.onsuccess = () => { const t = o.result.transaction('kv', 'readwrite'); t.objectStore('kv').put(val, key); t.oncomplete = () => res(); t.onerror = () => res(); };
  o.onerror = () => res();
});
/** app icon badge while the app is closed: one more unread chat per new private-chat push */
async function bumpBadge() {
  try { const n = ((await kv('unread')) || 0) + 1; await kvPut('unread', n); if (self.navigator.setAppBadge) await self.navigator.setAppBadge(n); } catch {}
}
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    const auth = await kv('auth');
    if (!auth || !auth.token) return;                   // logged out on this device: no alerts
    let d = null;
    try {
      const r = await fetch(auth.base + '/api/push/latest', { headers: { Authorization: 'Bearer ' + auth.token }, cache: 'no-store' });
      if (r.ok) d = await r.json();
    } catch {}
    if (d && d.kind === 'call') {                        // someone is calling me on the private walkie: ring until I open the app
      return self.registration.showNotification(d.title, {
        body: d.body, tag: 'wormadi-call', renotify: true, requireInteraction: true,
        vibrate: [600, 200, 600, 200, 600, 200, 600], icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: d.url },
      });
    }
    if (d && (d.kind === 'dm' || d.kind === 'voice')) {
      await bumpBadge();
      return self.registration.showNotification(d.title, {
        body: d.kind === 'voice' ? d.body + ' · แตะเพื่อฟัง' : d.body, tag: 'wormadi-' + (d.tag || 'dm'), renotify: true,
        vibrate: [200, 100, 200], icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: d.url },
      });
    }
    // SOS (or the server could not be reached: treat it as urgent)
    await self.registration.showNotification((d && d.kind === 'sos' && d.title) || '🚨 แจ้งเหตุฉุกเฉิน', {
      body: (d && d.kind === 'sos' && d.body) || 'มีการแจ้งเตือนสำคัญ แตะเพื่อเปิดแอป', tag: 'wormadi-sos', renotify: true, requireInteraction: true,
      vibrate: [700, 300, 700, 300, 700, 300, 700, 300, 700],
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: './#/sos' },
    });
  })());
});
