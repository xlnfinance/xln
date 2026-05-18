import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Device } from '@capacitor/device';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Keyboard } from '@capacitor/keyboard';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Preferences } from '@capacitor/preferences';
import { PushNotifications } from '@capacitor/push-notifications';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

type NativeEventName =
	| 'xln-native-ready'
	| 'xln-native-payment-wake'
	| 'xln-native-push-token'
	| 'xln-native-deeplink';

type XlnDesktopBridge = {
	platform: 'desktop';
	notifyPaymentWake?: (payload: { title: string; body: string; extra?: Record<string, unknown> }) => Promise<void>;
};

declare global {
	interface Window {
		xlnDesktop?: XlnDesktopBridge;
	}
}

const dispatchNativeEvent = (name: NativeEventName, detail: unknown = {}): void => {
	window.dispatchEvent(new CustomEvent(name, { detail }));
};

const normalizeDeepLinkPath = (url: string): string | null => {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'xln:') return null;
		const host = parsed.hostname.toLowerCase();
		const params = parsed.search || '';
		if (host === 'pay') return `/app#pay${params}`;
		if (host === 'invoice') return `/app#invoice${params}`;
		if (host === 'runtime') return `/app#runtime${params}`;
		if (host === 'app') return `/app${params}${parsed.hash || ''}`;
		return `/app#${host}${params}`;
	} catch {
		return null;
	}
};

const routeDeepLink = (url: string): void => {
	const next = normalizeDeepLinkPath(url);
	dispatchNativeEvent('xln-native-deeplink', { url, next });
	if (!next) return;
	window.history.replaceState(window.history.state, '', next);
	window.dispatchEvent(new HashChangeEvent('hashchange'));
};

const maybeRegisterPush = async (): Promise<void> => {
	const optIn = await Preferences.get({ key: 'xln-native-push-opt-in' });
	if (optIn.value !== '1') return;
	const permission = await PushNotifications.requestPermissions();
	if (permission.receive !== 'granted') return;
	await PushNotifications.register();
};

export const requestNativePaymentWakeNotifications = async (): Promise<void> => {
	if (window.xlnDesktop) {
		dispatchNativeEvent('xln-native-ready', { platform: 'desktop', notifications: 'local' });
		return;
	}
	if (!Capacitor.isNativePlatform()) return;
	await Preferences.set({ key: 'xln-native-push-opt-in', value: '1' });
	await maybeRegisterPush();
};

export const sendLocalPaymentWake = async (title: string, body: string, extra: Record<string, unknown> = {}): Promise<void> => {
	if (window.xlnDesktop?.notifyPaymentWake) {
		await window.xlnDesktop.notifyPaymentWake({ title, body, extra });
		return;
	}
	if (!Capacitor.isNativePlatform()) return;
	const permission = await LocalNotifications.requestPermissions();
	if (permission.display !== 'granted') return;
	await LocalNotifications.schedule({
		notifications: [{
			id: Date.now() % 2_147_483_647,
			title,
			body,
			schedule: { at: new Date(Date.now() + 250) },
			extra,
		}],
	});
};

export const initializeNativeShell = async (): Promise<void> => {
	if (window.xlnDesktop) {
		document.documentElement.classList.add('xln-native-shell', 'xln-desktop-shell');
		document.body.classList.add('xln-native-shell', 'xln-desktop-shell');
		dispatchNativeEvent('xln-native-ready', {
			platform: 'desktop',
			device: { platform: navigator.platform, userAgent: navigator.userAgent },
		});
		return;
	}

	if (!Capacitor.isNativePlatform()) return;

	document.documentElement.classList.add('xln-native-shell');
	document.body.classList.add('xln-native-shell');

	await SplashScreen.hide().catch(() => undefined);
	await StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
	await StatusBar.setBackgroundColor({ color: '#09090b' }).catch(() => undefined);
	await Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => undefined);

	const device = await Device.getInfo().catch(() => null);
	dispatchNativeEvent('xln-native-ready', {
		platform: Capacitor.getPlatform(),
		device,
	});

	await App.addListener('appUrlOpen', ({ url }) => routeDeepLink(url));
	await PushNotifications.addListener('registration', token => {
		dispatchNativeEvent('xln-native-push-token', { value: token.value });
	});
	await PushNotifications.addListener('pushNotificationReceived', notification => {
		dispatchNativeEvent('xln-native-payment-wake', { source: 'push', notification });
	});
	await PushNotifications.addListener('pushNotificationActionPerformed', action => {
		dispatchNativeEvent('xln-native-payment-wake', { source: 'push-action', action });
		if (action.notification?.data?.url) routeDeepLink(String(action.notification.data.url));
	});
	await LocalNotifications.addListener('localNotificationActionPerformed', action => {
		dispatchNativeEvent('xln-native-payment-wake', { source: 'local-action', action });
	});

	await maybeRegisterPush().catch(() => undefined);
	await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
};
