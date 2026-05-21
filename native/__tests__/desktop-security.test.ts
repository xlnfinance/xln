import { createRequire } from 'node:module';
import { describe, expect, test } from 'bun:test';

const require = createRequire(import.meta.url);
const {
	buildDesktopCsp,
	isAllowedExternalUrl,
	sanitizeNotificationPayload,
	setDesktopSecurityHeaders,
} = require('../desktop/security.cjs') as {
	buildDesktopCsp: () => string;
	isAllowedExternalUrl: (url: string) => boolean;
	sanitizeNotificationPayload: (payload?: Record<string, unknown>) => { title: string; body: string };
	setDesktopSecurityHeaders: (res: { setHeader(name: string, value: string): void }) => void;
};

describe('desktop shell security policy', () => {
	test('CSP keeps scripts local and allows runtime network connections', () => {
		const csp = buildDesktopCsp();
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
		expect(csp).toContain("connect-src 'self'");
		expect(csp).not.toContain('plausible.io');
	});

	test('external opener rejects local files and script URLs', () => {
		expect(isAllowedExternalUrl('https://xln.finance/docs')).toBe(true);
		expect(isAllowedExternalUrl('http://localhost:5173/app')).toBe(true);
		expect(isAllowedExternalUrl('mailto:ops@xln.finance')).toBe(true);
		expect(isAllowedExternalUrl('file:///Users/zigota/.ssh/id_rsa')).toBe(false);
		expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
		expect(isAllowedExternalUrl('xln://pay?amount=1')).toBe(false);
	});

	test('notification IPC payload is bounded before it reaches Electron', () => {
		const payload = sanitizeNotificationPayload({
			title: ' '.repeat(10),
			body: `pay\n${'x'.repeat(300)}`,
		});
		expect(payload.title).toBe('XLN payment');
		expect(payload.body.length).toBeLessThanOrEqual(180);
		expect(payload.body).not.toContain('\n');
	});

	test('sets browser hardening headers', () => {
		const headers = new Map<string, string>();
		setDesktopSecurityHeaders({
			setHeader(name: string, value: string) {
				headers.set(name, value);
			},
		});
		expect(headers.get('Content-Security-Policy')).toContain("object-src 'none'");
		expect(headers.get('Permissions-Policy')).toContain('camera=()');
		expect(headers.get('Referrer-Policy')).toBe('no-referrer');
	});
});
