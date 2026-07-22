import { describe, expect, test } from 'bun:test';
import { normalizeNativeDeepLinkPath } from '../../frontend/src/lib/native/deeplink';

describe('native deep-link routing', () => {
	test('normalizes supported xln links into app routes', () => {
		expect(normalizeNativeDeepLinkPath('xln://pay?amount=1')).toBe('/app#pay?amount=1');
		expect(normalizeNativeDeepLinkPath('xln://invoice?id=abc')).toBe('/app#pay?id=abc');
		const target = `0x${'ab'.repeat(32)}`;
		expect(normalizeNativeDeepLinkPath(`xln://pay/${target}?token=1&amount=5`))
			.toBe(`/app#pay/${encodeURIComponent(`${target}?token=1&amount=5`)}`);
		expect(normalizeNativeDeepLinkPath('xln://runtime?id=hub')).toBe('/app#runtime?id=hub');
		expect(normalizeNativeDeepLinkPath('xln://app/settings?tab=network#hubs')).toBe('/app/settings?tab=network#hubs');
		expect(normalizeNativeDeepLinkPath('xln://swap?pair=1-2')).toBe('/app#swap?pair=1-2');
	});

	test('rejects non-xln links before they reach app history', () => {
		expect(normalizeNativeDeepLinkPath('https://xln.finance/app')).toBeNull();
		expect(normalizeNativeDeepLinkPath('javascript:alert(1)')).toBeNull();
		expect(normalizeNativeDeepLinkPath('not a url')).toBeNull();
	});
});
