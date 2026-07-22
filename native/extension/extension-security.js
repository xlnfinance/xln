const DEFAULT_APP_PATH = 'app.html';

const paymentHash = parsed => {
	const pathname = parsed.pathname.replace(/^\/+/, '').trim();
	const params = new URLSearchParams(parsed.search);
	if (pathname && !params.has('target')) params.set('target', pathname);
	const target = String(params.get('target') || '').trim();
	if (!target) return `#pay${parsed.search}`;
	params.delete('target');
	const invoice = params.size > 0 ? `${target}?${params.toString()}` : target;
	return `#pay/${encodeURIComponent(invoice)}`;
};

export function normalizeXlnAppPath(value) {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw || raw.length > 2048) return DEFAULT_APP_PATH;
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== 'xln:') return DEFAULT_APP_PATH;
		const host = parsed.hostname.toLowerCase();
		if (host === 'app') return `${DEFAULT_APP_PATH}${parsed.hash || ''}`;
		if (host === 'pay' || host === 'invoice') return `${DEFAULT_APP_PATH}${paymentHash(parsed)}`;
		return `${DEFAULT_APP_PATH}#${host}${parsed.search}`;
	} catch {
		return DEFAULT_APP_PATH;
	}
}

function sanitizeNotificationText(value, fallback, maxLength) {
	const text = String(value || fallback).replace(/\s+/g, ' ').trim();
	if (!text) return fallback;
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

export function sanitizeNotificationPayload(message = {}) {
	return {
		title: sanitizeNotificationText(message.title, 'xln payment', 80),
		body: sanitizeNotificationText(message.body, 'Open xln to review this payment.', 180),
		appPath: normalizeXlnAppPath(message.url),
	};
}
