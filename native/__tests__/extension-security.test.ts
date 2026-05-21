import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	normalizeXlnUrl,
	sanitizeNotificationPayload,
} from '../extension/extension-security';

const root = join(import.meta.dir, '../..');

describe('browser extension companion policy', () => {
	test('external wake payloads can only open xln deep links', () => {
		expect(normalizeXlnUrl('xln://pay?amount=1')).toBe('xln://pay?amount=1');
		expect(normalizeXlnUrl('https://evil.example/pay')).toBe('xln://app');
		expect(normalizeXlnUrl('javascript:alert(1)')).toBe('xln://app');
		expect(normalizeXlnUrl(`xln://pay?memo=${'x'.repeat(3000)}`)).toBe('xln://app');
	});

	test('notification text is bounded before it reaches the browser API', () => {
		const payload = sanitizeNotificationPayload({
			title: ' '.repeat(10),
			body: `pay\n${'x'.repeat(300)}`,
			url: 'file:///Users/zigota/.ssh/id_rsa',
		});

		expect(payload.title).toBe('XLN payment');
		expect(payload.body.length).toBeLessThanOrEqual(180);
		expect(payload.body).not.toContain('\n');
		expect(payload.url).toBe('xln://app');
	});

	test('manifest does not expose wake messages to arbitrary websites', () => {
		const manifest = JSON.parse(readFileSync(join(root, 'native/extension/manifest.json'), 'utf8'));
		expect(manifest.externally_connectable.matches).toContain('https://xln.finance/*');
		expect(manifest.externally_connectable.matches).not.toContain('https://*/*');
	});
});
