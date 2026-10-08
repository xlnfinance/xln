import { originatedRecipient } from './payment-receipt-view';
import type { RuntimeActivityEvent } from '@xln/core/api/public/runtime-module';

export type MovementKind = 'payment' | 'swap' | 'settlement' | 'account' | 'onchain';
export type MovementTone = 'settled' | 'inflight' | 'pending' | 'failed' | 'neutral';

/**
 * One row the user reads as one thing that happened to their money. A single
 * HTLC payment commits as several frame entries (lock, hop notice, finalize,
 * resolve); they fold into one movement keyed by the hashlock.
 */
export type Movement = {
	id: string;
	kind: MovementKind;
	direction: 'in' | 'out' | 'neutral';
	title: string;
	/** Counterparty observed in the committed record; HTLC records identify the adjacent hop. */
	counterpartyId: string | null;
	/** First hop when it differs from the counterparty. */
	viaId: string | null;
	tokenId: number | null;
	amount: bigint | null;
	quoteTokenId?: number | null;
	quoteAmount?: bigint | null;
	tone: MovementTone;
	state: string;
	detail: string;
	height: number;
	timestamp: number;
	hash: string | null;
	events: RuntimeActivityEvent[];
};

export const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

export const amountText = (value: unknown): string => {
	if (typeof value === 'bigint') return value.toString();
	const text = String(value ?? '').trim();
	return /^-?\d+$/.test(text) ? BigInt(text).toString() : text;
};

const parseAmount = (value: unknown): bigint | null => {
	const text = amountText(value);
	if (!/^-?\d+$/.test(text)) return null;
	const parsed = BigInt(text);
	return parsed < 0n ? -parsed : parsed;
};

// Swap handlers emit a raw internal log line and a structured entry for the same frame.
const RAW_SWAP_LOG = /^(?:📊 Swap offer|📨 Swap cancel requested)/;
const DIRECT_PAYMENT_TYPES = new Set(['directPayment', 'direct_payment']);
// Opening a token lane is plumbing under a credit limit or a payment, not a movement.
const PLUMBING_TYPES = new Set(['add_delta', 'liveness', 'proposeAccountsNow']);

/** Raw event names ("FoundationBootstrapped", "reserve_updated") read as sentences ("Foundation bootstrapped"). */
export function humanTitle(raw: string): string {
	if (/\s/.test(raw)) return raw;
	const words = raw
		.replace(/_/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.trim()
		.toLowerCase();
	return words ? words[0]!.toUpperCase() + words.slice(1) : raw;
}

const isPaymentEvent = (event: RuntimeActivityEvent): boolean =>
	event.type === 'payment' || event.type === 'htlc' || /htlc/i.test(String(event.rawType || ''));

function kindOf(event: RuntimeActivityEvent): MovementKind | null {
	if (event.kind === 'onchain') return 'onchain';
	if (isPaymentEvent(event)) return 'payment';
	if (event.type === 'swap' || event.type === 'cross_swap') return 'swap';
	if (event.type === 'settlement') return 'settlement';
	if (event.type === 'account') return 'account';
	return null;
}

function paymentTone(events: RuntimeActivityEvent[]): { tone: MovementTone; state: string; detail: string } {
	const statuses = events.map(event => String(event.status || '').toLowerCase());
	const failed = events.find(event => /fail|reject|error|timeout/.test(String(event.status || '').toLowerCase()));
	if (failed) {
		const reason = String(failed.subtitle || '').trim();
		return { tone: 'failed', state: 'failed', detail: /^(htlc resolved|failed)$/i.test(reason) ? '' : reason };
	}
	if (statuses.some(status => /finalized|committed/.test(status))) return { tone: 'settled', state: 'settled', detail: '' };
	return { tone: 'inflight', state: 'in flight', detail: '' };
}

function swapTone(event: RuntimeActivityEvent): { tone: MovementTone; state: string } {
	const status = String(event.status || '').toLowerCase();
	if (status === 'filled') return { tone: 'settled', state: 'filled' };
	if (status === 'placed') return { tone: 'neutral', state: 'placed' };
	if (status === 'cancel requested') return { tone: 'pending', state: 'cancelling' };
	if (status === 'closed') return { tone: 'neutral', state: 'closed' };
	if (/fail|reject|abort/.test(status)) return { tone: 'failed', state: status };
	return { tone: 'pending', state: status || 'open' };
}

function settlementTone(event: RuntimeActivityEvent): { tone: MovementTone; state: string } {
	const raw = String(event.rawType || '');
	if (raw === 'settle_execute') return { tone: 'settled', state: 'executed' };
	if (raw === 'settle_reject') return { tone: 'failed', state: 'rejected' };
	return { tone: 'pending', state: raw.replace(/^settle_/, '') || 'pending' };
}

const paymentTitle = (direction: Movement['direction']): string =>
	direction === 'out' ? 'Sent' : direction === 'in' ? 'Received' : 'Routed';

function foldPayment(id: string, events: RuntimeActivityEvent[], self: string): Movement {
	// Account frame entries carry the frame's own from/to; runtime logs may be another hop's view.
	const ordered = [...events].sort((left, right) => right.height - left.height);
	const authoritative =
		ordered.find(event => event.source === 'runtime_input' && event.direction !== 'neutral') ?? ordered.find(event => event.direction !== 'neutral') ?? ordered[0]!;
	const direction = authoritative.direction === 'in' || authoritative.direction === 'out' ? authoritative.direction : 'neutral';
	// The runtime names the viewed entity itself as counterparty on some direct-payment entries; skip those.
	const hop =
		[authoritative, ...ordered].map(event => normalizeId(event.counterpartyId)).find(candidate => candidate && candidate !== self) ?? null;
	const hash = normalizeId(ordered.find(event => event.hash)?.hash) || null;
	const recipient = direction === 'out' ? originatedRecipient(ordered, self, hash ?? '') : null;
	const withAmount = ordered.find(event => event.amount !== undefined && event.amount !== null && event.tokenId !== undefined);
	const { tone, state, detail } = paymentTone(ordered);
	// The receipt names the frame that finalized the payment; the row must name the same one.
	const finalized = ordered.find(event => event.source === 'runtime_log' && String(event.status || '') === 'finalized');
	return {
		id,
		kind: 'payment',
		direction,
		title: paymentTitle(direction),
		counterpartyId: recipient ?? hop,
		viaId: recipient && hop && recipient !== hop ? hop : null,
		tokenId: withAmount?.tokenId ?? null,
		amount: withAmount ? parseAmount(withAmount.amount) : null,
		tone,
		state,
		detail,
		height: finalized?.height ?? ordered[0]!.height,
		timestamp: finalized?.timestamp ?? Math.max(...ordered.map(event => event.timestamp)),
		hash,
		events: ordered,
	};
}

function singleMovement(event: RuntimeActivityEvent, kind: Exclude<MovementKind, 'payment'>): Movement {
	const { tone, state } = kind === 'swap' ? swapTone(event) : kind === 'settlement' ? settlementTone(event) : { tone: 'neutral' as MovementTone, state: String(event.status || 'updated') };
	const direction = event.direction === 'in' || event.direction === 'out' ? event.direction : 'neutral';
	return {
		id: event.id,
		kind,
		direction,
		title: humanTitle(String(event.title || event.type || 'Update')),
		counterpartyId: normalizeId(event.counterpartyId) || null,
		viaId: null,
		tokenId: event.tokenId ?? null,
		amount: event.amount !== undefined && event.amount !== null ? parseAmount(event.amount) : null,
		tone,
		state,
		quoteTokenId: event.quoteTokenId ?? null,
		quoteAmount: parseAmount(event.quoteAmount),
		detail: event.orderId ? `Order ${event.orderId}` : '',
		height: event.height,
		timestamp: event.timestamp,
		hash: normalizeId(event.hash) || null,
		events: [event],
	};
}

/**
 * Fold the runtime's activity entries for one entity into the movements a
 * wallet shows: movements on this wallet's own bilateral accounts. Routing
 * chatter (payments that neither start nor end here) and frames of other
 * entities the same runtime hosts are left out; the hub console reads those.
 */
export function walletMovements(
	events: RuntimeActivityEvent[],
	entityId: string | null,
	accountIds: readonly string[],
): Movement[] {
	const self = normalizeId(entityId);
	const accounts = new Set(accountIds.map(normalizeId));
	const onOwnAccount = (counterpartyId: string | null): boolean => counterpartyId === null || accounts.has(counterpartyId);
	const groups = new Map<string, RuntimeActivityEvent[]>();
	const order: string[] = [];
	const singles = new Map<string, Movement>();

	const push = (key: string, event: RuntimeActivityEvent): void => {
		const existing = groups.get(key);
		if (existing) existing.push(event);
		else {
			groups.set(key, [event]);
			order.push(key);
		}
	};

	for (const event of events) {
		if (RAW_SWAP_LOG.test(String(event.title || ''))) continue;
		const owner = normalizeId(event.entityId);
		if (self && owner && owner !== self) continue;
		if (PLUMBING_TYPES.has(String(event.rawType || ''))) continue;
		const kind = kindOf(event);
		if (!kind) continue;
		const rawType = String(event.rawType || '');
		if (kind !== 'payment') {
			// Structured frame entries only; raw runtime log lines duplicate them under internal names.
			if ((kind !== 'onchain' && event.source !== 'runtime_input') || PLUMBING_TYPES.has(rawType)) continue;
			const single = singleMovement(event, kind);
			singles.set(event.id, single);
			continue;
		}
		if (event.hash) {
			push(`htlc:${normalizeId(event.hash)}`, event);
			continue;
		}
		if (DIRECT_PAYMENT_TYPES.has(rawType)) {
			// Amount and nearby height are not identity: equal payments stay distinct.
			push(`direct:${event.id}`, event);
			continue;
		}
		// Resolve acknowledgements without a hashlock are consensus chatter for a lock already shown.
	}

	const folded: Movement[] = [];
	for (const key of order) {
		const movement = foldPayment(key, groups.get(key)!, self);
		if (movement.direction === 'neutral') continue;
		if (!onOwnAccount(movement.viaId ?? movement.counterpartyId) && !originatedRecipient(movement.events, self, movement.hash ?? '')) continue;
		folded.push(movement);
	}
	return [...folded, ...singles.values()].sort((left, right) => right.timestamp - left.timestamp || right.height - left.height || right.id.localeCompare(left.id));
}
