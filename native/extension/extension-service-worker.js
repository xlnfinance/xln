import { sanitizeNotificationPayload } from './extension-security.js';

const openApp = appPath => chrome.tabs.create({ url: chrome.runtime.getURL(appPath || 'app.html') });

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ xlnInstalledAt: Date.now() });
});

chrome.action.onClicked.addListener(() => openApp('app.html'));

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'xln.payment_wake') return false;
  const payload = sanitizeNotificationPayload(message);
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon-128.png',
    title: payload.title,
    message: payload.body,
  }, notificationId => {
    chrome.storage.local.set({ [`wake:${notificationId}`]: payload.appPath });
    sendResponse({ ok: true, notificationId, sender: sender.origin || null });
  });
  return true;
});

chrome.notifications.onClicked.addListener(notificationId => {
  chrome.storage.local.get(`wake:${notificationId}`, values => {
    const appPath = values[`wake:${notificationId}`] || 'app.html';
    openApp(appPath);
    chrome.storage.local.remove(`wake:${notificationId}`);
  });
});
