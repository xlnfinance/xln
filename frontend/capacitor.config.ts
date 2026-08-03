import type { CapacitorConfig } from '@capacitor/cli';

const webDir = process.env['XLN_CAPACITOR_WEB_DIR']?.trim() || 'build';
if (webDir !== 'build' && webDir !== '.native-wallet-build') {
	throw new Error(`CAPACITOR_WEB_DIR_INVALID:${webDir}`);
}

const config: CapacitorConfig = {
	appId: 'finance.xln.wallet',
	appName: 'xln finance',
	webDir,
	bundledWebRuntime: false,
	server: {
		hostname: 'localhost',
		androidScheme: 'https',
		iosScheme: 'xln',
	},
	ios: {
		contentInset: 'automatic',
	},
	android: {
		allowMixedContent: false,
		captureInput: true,
		webContentsDebuggingEnabled: false,
	},
	plugins: {
		SplashScreen: {
			launchAutoHide: true,
			backgroundColor: '#09090b',
			androidSplashResourceName: 'splash',
			showSpinner: false,
		},
		StatusBar: {
			style: 'DARK',
			backgroundColor: '#09090b',
			overlaysWebView: false,
		},
		Keyboard: {
			resize: 'body',
		},
		LocalNotifications: {
			smallIcon: 'ic_stat_icon_config_sample',
			iconColor: '#0f766e',
		},
		PushNotifications: {
			presentationOptions: ['badge', 'sound', 'alert'],
		},
	},
};

export default config;
