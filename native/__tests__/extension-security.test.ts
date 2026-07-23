import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	normalizeXlnAppPath,
	sanitizeNotificationPayload,
} from '../extension/extension-security';

const root = join(import.meta.dir, '../..');

describe('Chrome extension wallet policy', () => {
	test('external wake payloads can only open packaged app routes', () => {
		expect(normalizeXlnAppPath('xln://pay?amount=1')).toBe('app.html#pay?amount=1');
		expect(normalizeXlnAppPath(`xln://pay/${`0x${'ab'.repeat(32)}`}?amount=1`)).toContain('app.html#pay/');
		expect(normalizeXlnAppPath('https://evil.example/pay')).toBe('app.html');
		expect(normalizeXlnAppPath('javascript:alert(1)')).toBe('app.html');
		expect(normalizeXlnAppPath(`xln://pay?memo=${'x'.repeat(3000)}`)).toBe('app.html');
	});

	test('notification text is bounded before it reaches the browser API', () => {
		const payload = sanitizeNotificationPayload({
			title: ' '.repeat(10),
			body: `pay\n${'x'.repeat(300)}`,
			url: 'file:///Users/zigota/.ssh/id_rsa',
		});

		expect(payload.title).toBe('xln payment');
		expect(payload.body.length).toBeLessThanOrEqual(180);
		expect(payload.body).not.toContain('\n');
		expect(payload.appPath).toBe('app.html');
	});

	test('manifest does not expose wake messages to arbitrary websites', () => {
		const manifest = JSON.parse(readFileSync(join(root, 'native/extension/manifest.json'), 'utf8'));
		expect(manifest.externally_connectable.matches).toContain('https://xln.finance/*');
		expect(manifest.externally_connectable.matches).not.toContain('https://*/*');
		expect(manifest.name).toBe('xln finance');
		expect(manifest.version).toBe('0.1.19');
		expect(manifest.action.default_popup).toBeUndefined();
	});
});
