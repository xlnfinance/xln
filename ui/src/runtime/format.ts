import { peekXLN } from './xln-loader';

export type TokenMeta = { symbol: string; name: string; decimals: number; color: string };

const UNKNOWN_TOKEN: TokenMeta = { symbol: '?', name: 'Unknown', decimals: 18, color: '#888888' };

export function getTokenMeta(tokenId: number): TokenMeta {
	const xln = peekXLN();
	if (!xln) return UNKNOWN_TOKEN;
	try {
		return xln.getTokenInfo(tokenId);
	} catch {
		return UNKNOWN_TOKEN;
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

/** Token glyph for the round icon: currency sign where one exists, first letter otherwise. */
export function tokenGlyph(symbol: string): string {
	const upper = symbol.toUpperCase();
	if (upper === 'USDC' || upper === 'USDT') return '$';
	if (upper === 'WETH' || upper === 'ETH') return 'Ξ';
	return upper.slice(0, 1) || '?';
}

/** "12,480.2" grouped integer part, trailing zeros trimmed, never exponent. */
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

/** Rounds a raw amount to `fraction` decimals, half away from zero; never truncates. */
function roundToFraction(abs: bigint, decimals: number, fraction: number): { whole: bigint; digits: string } {
	const keep = Math.min(decimals, fraction);
	const drop = decimals - keep;
	const unit = 10n ** BigInt(drop);
	const scaled = drop > 0 ? (abs + unit / 2n) / unit : abs;
	const base = 10n ** BigInt(keep);
	return { whole: scaled / base, digits: (scaled % base).toString().padStart(keep, '0').padEnd(fraction, '0') };
}

export function formatMoney(amount: bigint, decimals: number, fraction = 2): string {
	const negative = amount < 0n;
	const { whole, digits } = roundToFraction(negative ? -amount : amount, decimals, fraction);
	const sign = negative ? '−' : '';
	return fraction > 0 && decimals > 0 ? `${sign}${whole.toLocaleString('en-US')}.${digits}` : `${sign}${whole.toLocaleString('en-US')}`;
}

/** Signed money: "+230.00" / "−120.00" / "0.00". */
export function formatSigned(amount: bigint, decimals: number, fraction = 2): string {
	const body = formatMoney(amount < 0n ? -amount : amount, decimals, fraction);
	return amount > 0n ? `+${body}` : amount < 0n ? `−${body}` : body;
}

/** Big-numeral split for the display font: ["12,480", ".20"]. */
export function splitAmountForDisplay(amount: bigint, decimals: number): [string, string] {
	const negative = amount < 0n;
	const { whole, digits } = roundToFraction(negative ? -amount : amount, decimals, 2);
	return [`${negative ? '−' : ''}${whole.toLocaleString('en-US')}`, decimals > 0 ? `.${digits}` : ''];
}

export function formatUsd(value: number): string {
	const abs = Math.abs(value);
	const sign = value < 0 ? '−' : '';
	return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

/** Exact input text for a bigint amount: "730.5" (no grouping, no trailing zeros). */
export function amountInputText(value: bigint, decimals: number): string {
	const base = 10n ** BigInt(decimals);
	const whole = value / base;
	const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
	return fraction ? `${whole}.${fraction}` : whole.toString();
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

export function formatClock(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function dayLabel(timestamp: number): string {
	const date = new Date(timestamp);
	const today = new Date();
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	const sameDay = (a: Date, b: Date): boolean =>
		a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
	if (sameDay(date, today)) return 'Today';
	if (sameDay(date, yesterday)) return 'Yesterday';
	return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
