// ── Musta Chat Service Worker ──────────────────────────────────────────
// Handles push notifications when app is in background or closed

self.addEventListener('install',  e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', e => {
  if (!e.data) return;
  let data;
  try { data = e.data.json(); } catch { return; }

  const isCall = data.type === 'call';

  const options = {
    body: data.body || '',
    icon: '/fav.png',
    badge: '/fav.png',
    vibrate: isCall ? [200,100,200,100,200,100,200] : [200, 100, 200],
    tag: isCall ? `call-${data.from}` : `msg-${data.from}`,
    renotify: true,
    requireInteraction: isCall, // call notifications stay until dismissed
    data: { from: data.from, type: data.type, url: self.registration.scope },
    actions: isCall
      ? [
          { action: 'open', title: '📞 Open App' },
          { action: 'dismiss', title: '❌ Dismiss' }
        ]
      : [
          { action: 'open', title: '💬 Reply' }
        ]
  };

  e.waitUntil(
    self.registration.showNotification(data.title || 'Musta Chat', options)
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;

  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // focus existing tab if open
      for (const client of list) {
        if (client.url.includes(self.registration.scope.replace(/\/$/, '')) && 'focus' in client) {
          return client.focus();
        }
      }
      // otherwise open new tab
      return clients.openWindow(url);
    })
  );
});
