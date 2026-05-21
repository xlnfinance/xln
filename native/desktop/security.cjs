const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function buildDesktopCsp() {
	return [
		"default-src 'self'",
		"base-uri 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"form-action 'self'",
		"script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		"worker-src 'self' blob:",
		"connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* https: wss:",
	].join('; ');
}

function setDesktopSecurityHeaders(res) {
	res.setHeader('Content-Security-Policy', buildDesktopCsp());
	res.setHeader('Permissions-Policy', [
		'camera=()',
		'microphone=()',
		'geolocation=()',
		'payment=()',
		'usb=()',
		'serial=()',
		'bluetooth=()',
	].join(', '));
	res.setHeader('Referrer-Policy', 'no-referrer');
	res.setHeader('X-Content-Type-Options', 'nosniff');
}

function isAllowedExternalUrl(url) {
	try {
		const parsed = new URL(url);
		return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol);
	} catch {
		return false;
	}
}

function sanitizeNotificationText(value, fallback, maxLength = 180) {
	const text = String(value || fallback).replace(/\s+/g, ' ').trim();
	if (!text) return fallback;
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function sanitizeNotificationPayload(payload = {}) {
	return {
		title: sanitizeNotificationText(payload.title, 'XLN payment', 80),
		body: sanitizeNotificationText(payload.body, 'Open XLN Wallet to review.', 180),
	};
}

module.exports = {
	buildDesktopCsp,
	isAllowedExternalUrl,
	sanitizeNotificationPayload,
	setDesktopSecurityHeaders,
};
