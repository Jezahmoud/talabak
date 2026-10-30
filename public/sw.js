self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
// عامل الخدمة: يعرض إشعار الجاهزية (أندرويد وأي متصفح يدعم Web Push داخل التبويب)
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'طلبك جاهز', {
    body: d.body || 'طلبك جاهز', tag: d.tag, renotify: true, requireInteraction: true,
    vibrate: [500, 200, 500, 200, 900], data: { url: d.url }, dir: 'rtl', lang: 'ar'
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const id = url.split('/').pop();
    fetch(`/api/orders/${id}/ack`, { method: 'POST' }).catch(() => {});
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if (c.url.startsWith(url)) return c.focus();
    return clients.openWindow(url);
  })());
});
