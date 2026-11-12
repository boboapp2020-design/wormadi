// Service worker: ให้ติดตั้งเป็นแอปได้ เปิดหน้าแอปได้แม้เน็ตแกว่ง และกดแจ้งเตือนแล้วกลับเข้าแอป
// หน้าเว็บ: ลองเน็ตก่อน (ได้เวอร์ชันใหม่เสมอ) ถ้าไม่มีเน็ตใช้ของที่เก็บไว้ · /api และ WebSocket ไม่ผ่าน cache
const CACHE = 'wormadi-v16';
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
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let title = '🚨 แจ้งเหตุฉุกเฉิน', body = 'มีการแจ้งเหตุฉุกเฉิน แตะเพื่อเปิดแอป';
    const auth = await kv('auth');
    if (!auth || !auth.token) return;                   // logged out on this device: no alerts
    try {
      const r = await fetch(auth.base + '/api/sos', { headers: { Authorization: 'Bearer ' + auth.token }, cache: 'no-store' });
      if (r.ok) {
        const s = (await r.json()).find(x => x.status === 'open');
        if (s) body = `แจ้งโดย ${s.reporter}${s.reporter_dept ? ' (' + s.reporter_dept + ')' : ''}${s.place ? ' · ' + s.place : ''}`;
      }
    } catch {}
    await self.registration.showNotification(title, {
      body, tag: 'wormadi-sos', renotify: true, requireInteraction: true,
      vibrate: [700, 300, 700, 300, 700, 300, 700, 300, 700],
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: './#/sos' },
    });
  })());
});
