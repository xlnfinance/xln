self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'XLN dispute wake';
  const body = typeof payload.body === 'string' && payload.body ? payload.body : 'Open XLN to sync and respond.';
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  event.waitUntil(self.registration.showNotification(title, {
    body,
    data,
    tag: typeof payload.collapseKey === 'string' ? payload.collapseKey : 'xln-dispute-wake',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = event.notification.data && typeof event.notification.data.url === 'string'
    ? event.notification.data.url
    : '/app';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ('focus' in client) return client.focus();
    }
    return self.clients.openWindow(rawUrl);
  }));
});
