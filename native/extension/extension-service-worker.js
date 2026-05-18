chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ xlnCompanionInstalledAt: Date.now() });
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'xln://app' });
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'xln.payment_wake') return false;

  const url = typeof message.url === 'string' ? message.url : 'xln://app';
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon-128.png',
    title: String(message.title || 'XLN payment'),
    message: String(message.body || 'Open XLN Wallet to review this payment.'),
  }, notificationId => {
    chrome.storage.local.set({ [`wake:${notificationId}`]: url });
    sendResponse({ ok: true, notificationId, sender: sender.origin || null });
  });
  return true;
});

chrome.notifications.onClicked.addListener(notificationId => {
  chrome.storage.local.get(`wake:${notificationId}`, values => {
    const url = values[`wake:${notificationId}`] || 'xln://app';
    chrome.tabs.create({ url });
    chrome.storage.local.remove(`wake:${notificationId}`);
  });
});
