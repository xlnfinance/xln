const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xlnDesktop', {
	platform: 'desktop',
	notifyPaymentWake(payload) {
		return ipcRenderer.invoke('xln-desktop-notify-payment-wake', payload);
	},
	getVersion() {
		return ipcRenderer.invoke('xln-desktop-version');
	},
});

ipcRenderer.on('xln-desktop-deeplink', (_event, url) => {
	window.dispatchEvent(new CustomEvent('xln-native-deeplink', {
		detail: { url, source: 'desktop-protocol' },
	}));
});

window.addEventListener('DOMContentLoaded', () => {
	window.dispatchEvent(new CustomEvent('xln-native-ready', {
		detail: { platform: 'desktop', shell: 'electron' },
	}));
});
