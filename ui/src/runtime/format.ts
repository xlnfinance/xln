import { peekXLN } from './xln-loader';

export type TokenMeta = { symbol: string; name: string; decimals: number; color: string };

const FALLBACK_TOKEN: TokenMeta = { symbol: '?', name: 'Unknown', decimals: 18, color: '#888888' };

export function getTokenMeta(tokenId: number): TokenMeta {
	const xln = peekXLN();
	if (!xln) return FALLBACK_TOKEN;
	try {
		return xln.getTokenInfo(tokenId);
	} catch {
		return FALLBACK_TOKEN;
	}
}

export function knownTokenIds(): number[] {
	const xln = peekXLN();
	if (!xln) return [1];
	try {
		return xln.getKnownTokenIds();
	} catch {
		return [1];
	}
}

/** "12,480.2" — grouped integer part, trailing zeros trimmed, never exponent. */
export function formatAmount(amount: bigint, decimals: number, maxFraction = 6): string {
	const negative = amount < 0n;
	const abs = negative ? -amount : amount;
	const base = 10n ** BigInt(decimals);
	const whole = abs / base;
	const fraction = abs % base;

	const wholeText = whole.toLocaleString('en-US');
	let fractionText = fraction.toString().padStart(decimals, '0').slice(0, Math.min(decimals, maxFraction));
	fractionText = fractionText.replace(/0+$/, '');

	const sign = negative ? '−' : '';
	return fractionText ? `${sign}${wholeText}.${fractionText}` : `${sign}${wholeText}`;
}

/** Big-numeral split for the display font: ["12,480", ".20"]. */
export function splitAmountForDisplay(amount: bigint, decimals: number): [string, string] {
	const negative = amount < 0n;
	const abs = negative ? -amount : amount;
	const base = 10n ** BigInt(decimals);
	const whole = abs / base;
	const fraction = abs % base;
	const fractionText = decimals > 0 ? fraction.toString().padStart(decimals, '0').slice(0, 2) : '';
	return [`${negative ? '−' : ''}${whole.toLocaleString('en-US')}`, fractionText ? `.${fractionText}` : ''];
}

export function parseAmount(input: string, decimals: number): bigint {
	const text = input.trim().replace(/,/g, '');
	if (!/^\d*(\.\d*)?$/.test(text) || text === '' || text === '.') {
		throw new Error('Enter a valid amount');
	}
	const [wholeText = '0', fractionText = ''] = text.split('.');
	if (fractionText.length > decimals) {
		throw new Error(`Too many decimal places (max ${decimals})`);
	}
	const whole = BigInt(wholeText || '0');
	const fraction = BigInt((fractionText || '').padEnd(decimals, '0') || '0');
	return whole * 10n ** BigInt(decimals) + fraction;
}

export function shortId(value: string, head = 6, tail = 4): string {
	const text = String(value || '');
	if (text.length <= head + tail + 1) return text;
	return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

export function timeAgo(timestamp: number): string {
	const delta = Math.max(0, Date.now() - timestamp);
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} hr ago`;
	const days = Math.floor(hours / 24);
	return `${days} d ago`;
}
