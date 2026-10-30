self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
// عامل الخدمة: يعرض إشعار الجاهزية. يفهم صيغة Declarative Web Push (Apple) والصيغة التقليدية (أندرويد)
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch {}
  const n = d.notification || d;
  const url = n.navigate || n.url || '/app';
  e.waitUntil(self.registration.showNotification(n.title || 'طلبك جاهز', {
    body: n.body || 'طلبك جاهز', tag: n.tag || 'talabak', image: n.image, icon: n.icon, badge: n.badge,
    renotify: true, requireInteraction: true, silent: false,
    vibrate: [600, 200, 600, 200, 600, 200, 1200], data: { url }, dir: 'rtl', lang: 'ar'
  }).then(() => {
    const m = url.match(/\/o\/([a-f0-9]+)/);
    const body = JSON.stringify({ state: 'sw_notification_shown' });
    if (m) return fetch(`/api/orders/${m[1]}/ping`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
    if (n.dev) return fetch('/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: n.dev, state: 'sw_notification_shown' }) }).catch(() => {});
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/app';
  e.waitUntil((async () => {
    const m = url.match(/\/o\/([a-f0-9]+)/);
    if (m) fetch(`/api/orders/${m[1]}/ack`, { method: 'POST' }).catch(() => {});
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if (c.url.startsWith(url.split('?')[0])) return c.focus();
    return clients.openWindow(url);
  })());
});
// يسجل تغيّر الاشتراك أو إلغاءه من جهة الجوال (مثل إيقاف إشعارات الموقع من الإعدادات)
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(fetch('/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'sw', state: 'pushsubscriptionchange ' + (e.newSubscription ? 'renewed' : 'revoked') }) }).catch(() => {}));
});
self.addEventListener('notificationclose', e => {
  const url = (e.notification.data && e.notification.data.url) || ''; const m = url.match(/\/o\/([a-f0-9]+)/);
  if (m) e.waitUntil(fetch(`/api/orders/${m[1]}/ping`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'sw_notification_closed' }) }).catch(() => {}));
});
