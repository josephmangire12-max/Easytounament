// EasyTournament service worker: shows push notifications even when the app is closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (_) { d = { title: 'EasyTournament', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'EasyTournament', {
    body: d.body || '', tag: d.tag || 'et', renotify: true, requireInteraction: !!d.call,
    vibrate: d.call ? [400, 200, 400, 200, 400] : [120], icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: d.url || '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close(); const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { try { c.navigate(url); } catch (_) { } return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
