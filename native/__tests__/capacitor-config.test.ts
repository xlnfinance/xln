import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../../frontend/capacitor.config';

const root = join(import.meta.dir, '../..');

describe('native mobile shell configuration', () => {
	test('serves the shared frontend build with production-safe webview defaults', () => {
		expect(config.appId).toBe('finance.xln.wallet');
		expect(config.appName).toBe('XLN Wallet');
		expect(config.webDir).toBe('build');
		expect(config.server?.hostname).toBe('localhost');
		expect(config.android?.allowMixedContent).toBe(false);
		expect(config.android?.webContentsDebuggingEnabled).toBe(false);
	});

	test('android shell keeps wallet storage local and supports xln deep links', () => {
		const manifest = readFileSync(join(root, 'frontend/android/app/src/main/AndroidManifest.xml'), 'utf8');

		expect(manifest).toContain('android:allowBackup="false"');
		expect(manifest).toContain('android:fullBackupContent="false"');
		expect(manifest).toContain('android:usesCleartextTraffic="false"');
		expect(manifest).toContain('<data android:scheme="xln" />');
		expect(manifest).toContain('android.permission.POST_NOTIFICATIONS');
	});

	test('ios shell supports the same xln deep-link scheme', () => {
		const plist = readFileSync(join(root, 'frontend/ios/App/App/Info.plist'), 'utf8');

		expect(plist).toContain('<string>finance.xln.wallet</string>');
		expect(plist).toContain('<string>xln</string>');
		expect(plist).toContain('<string>remote-notification</string>');
	});
});
