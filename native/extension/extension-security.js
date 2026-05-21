const DEFAULT_XLN_URL = 'xln://app';

export function normalizeXlnUrl(value) {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw) return DEFAULT_XLN_URL;
	if (raw.length > 2048) return DEFAULT_XLN_URL;
	try {
		const parsed = new URL(raw);
		return parsed.protocol === 'xln:' ? raw : DEFAULT_XLN_URL;
	} catch {
		return DEFAULT_XLN_URL;
	}
}

function sanitizeNotificationText(value, fallback, maxLength) {
	const text = String(value || fallback).replace(/\s+/g, ' ').trim();
	if (!text) return fallback;
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

export function sanitizeNotificationPayload(message = {}) {
	return {
		title: sanitizeNotificationText(message.title, 'XLN payment', 80),
		body: sanitizeNotificationText(message.body, 'Open XLN Wallet to review this payment.', 180),
		url: normalizeXlnUrl(message.url),
	};
}
