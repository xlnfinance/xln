import { useMemo } from 'react';
import { create } from 'zustand';
import type { RuntimeActivityEvent } from '@xln/core/api/public/runtime-module';
import { useAdapterRead } from '../hooks';

/** User-relevant money movements; consensus internals stay in the developer workspace. */
export const USER_ACTIVITY_TYPES = ['payment', 'htlc', 'swap', 'cross_swap', 'settlement', 'account'];

export type MovementKind = 'payment' | 'swap' | 'settlement' | 'account';
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
	/** Who the money is for or from: the addressed recipient when this wallet sent it. */
	counterpartyId: string | null;
	/** First hop when it differs from the counterparty. */
	viaId: string | null;
	tokenId: number | null;
	amount: bigint | null;
	tone: MovementTone;
	state: string;
	detail: string;
	height: number;
	timestamp: number;
	hash: string | null;
	events: RuntimeActivityEvent[];
};

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

const amountText = (value: unknown): string => {
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

// ---------------------------------------------------------------------------
// Payment intents: what this wallet addressed, bound to the committed hashlock.
// ---------------------------------------------------------------------------

export type PaymentIntent = {
	entityId: string;
	targetEntityId: string;
	tokenId: number;
	/** Recipient and sender amounts; the finalized log reports the paybook's own figure. */
	amounts: string[];
	description: string;
	submittedAt: number;
};

type IntentState = {
	intents: PaymentIntent[];
	/** hashlock → recipient this wallet addressed; bound when the finalized frame log arrived. */
	recipients: Record<string, string>;
	record: (intent: PaymentIntent) => void;
	/** Bind a terminal HTLC payload to the intent it fulfils. Returns the recipient when known. */
	bind: (entityId: string, data: Record<string, unknown>) => string | null;
};

const INTENTS_KEY = 'xln-ui-payment-intents';
const RECIPIENTS_KEY = 'xln-ui-payment-recipients';
const INTENT_TTL_MS = 24 * 60 * 60 * 1000;
const RECIPIENTS_CAP = 1000;

function readStored<T>(key: string, initial: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : initial;
	} catch {
		return initial;
	}
}

function writeStored(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Storage may be unavailable (private mode); the binding then lives for this session only.
	}
}

const liveIntents = (intents: PaymentIntent[]): PaymentIntent[] => {
	const horizon = Date.now() - INTENT_TTL_MS;
	return intents.filter(intent => intent.submittedAt >= horizon);
};

export const usePaymentIntents = create<IntentState>((set, get) => ({
	intents: liveIntents(readStored<PaymentIntent[]>(INTENTS_KEY, [])),
	recipients: readStored<Record<string, string>>(RECIPIENTS_KEY, {}),
	record: intent => {
		const intents = [
			...liveIntents(get().intents),
			{ ...intent, entityId: normalizeId(intent.entityId), targetEntityId: normalizeId(intent.targetEntityId), amounts: intent.amounts.map(amountText) },
		];
		writeStored(INTENTS_KEY, intents);
		set({ intents });
	},
	bind: (entityId, data) => {
		const hash = normalizeId(data['hashlock'] ?? data['lockId']);
		if (!hash) return null;
		const known = get().recipients[hash];
		if (known) return known;
		if (normalizeId(data['fromEntity']) !== normalizeId(entityId)) return null;
		const amount = amountText(data['amount']);
		const tokenId = Number(data['tokenId']);
		const description = String(data['description'] || '').trim();
		const intents = liveIntents(get().intents);
		const index = intents.findIndex(
			intent => intent.entityId === normalizeId(entityId) && intent.amounts.includes(amount) && intent.tokenId === tokenId && intent.description === description,
		);
		const intent = index >= 0 ? intents[index] : undefined;
		if (!intent) return null;
		const remaining = intents.filter((_, position) => position !== index);
		const entries = Object.entries(get().recipients);
		entries.push([hash, intent.targetEntityId]);
		const recipients = Object.fromEntries(entries.slice(-RECIPIENTS_CAP));
		writeStored(INTENTS_KEY, remaining);
		writeStored(RECIPIENTS_KEY, recipients);
		set({ intents: remaining, recipients });
		return intent.targetEntityId;
	},
}));

// ---------------------------------------------------------------------------
// Folding frame entries into movements.
// ---------------------------------------------------------------------------

// Swap handlers emit a raw internal log line and a structured entry for the same frame.
const RAW_SWAP_LOG = /^(?:📊 Swap offer|📨 Swap cancel requested)/;
const DIRECT_PAYMENT_TYPES = new Set(['directPayment', 'direct_payment']);
const MERGE_WINDOW = 6;
// Opening a token lane is plumbing under a credit limit or a payment, not a movement.
const PLUMBING_TYPES = new Set(['add_delta']);

const isPaymentEvent = (event: RuntimeActivityEvent): boolean =>
	event.type === 'payment' || event.type === 'htlc' || /htlc/i.test(String(event.rawType || ''));

function kindOf(event: RuntimeActivityEvent): MovementKind | null {
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
	if (status === 'placed') return { tone: 'pending', state: 'open' };
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

function foldPayment(id: string, events: RuntimeActivityEvent[], self: string, recipients: Record<string, string>): Movement {
	// Account frame entries carry the frame's own from/to; runtime logs may be another hop's view.
	const ordered = [...events].sort((left, right) => right.height - left.height);
	const authoritative =
		ordered.find(event => event.source === 'runtime_input' && event.direction !== 'neutral') ?? ordered.find(event => event.direction !== 'neutral') ?? ordered[0]!;
	const direction = authoritative.direction === 'in' || authoritative.direction === 'out' ? authoritative.direction : 'neutral';
	// The runtime names the viewed entity itself as counterparty on some direct-payment entries; skip those.
	const hop =
		[authoritative, ...ordered].map(event => normalizeId(event.counterpartyId)).find(candidate => candidate && candidate !== self) ?? null;
	const hash = normalizeId(ordered.find(event => event.hash)?.hash) || null;
	const recipient = hash && direction === 'out' ? normalizeId(recipients[hash]) || null : null;
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
		title: String(event.title || event.type || 'Update'),
		counterpartyId: normalizeId(event.counterpartyId) || null,
		viaId: null,
		tokenId: event.tokenId ?? null,
		amount: event.amount !== undefined && event.amount !== null ? parseAmount(event.amount) : null,
		tone,
		state,
		detail: '',
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
	recipients: Record<string, string>,
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
	// Both sides of a bilateral frame commit the same entry; fold copies that land within a few frames.
	const nearKey = (keys: Iterable<string>, base: string, height: number): string | undefined => {
		for (const key of keys) {
			if (!key.startsWith(`${base}@`)) continue;
			const anchor = Number(key.slice(key.lastIndexOf('@') + 1));
			if (Math.abs(anchor - height) <= MERGE_WINDOW) return key;
		}
		return undefined;
	};

	for (const event of events) {
		if (RAW_SWAP_LOG.test(String(event.title || ''))) continue;
		const owner = normalizeId(event.entityId);
		if (self && owner && owner !== self) continue;
		const kind = kindOf(event);
		if (!kind) continue;
		const rawType = String(event.rawType || '');
		if (kind !== 'payment') {
			// Structured frame entries only; raw runtime log lines duplicate them under internal names.
			if (event.source !== 'runtime_input' || PLUMBING_TYPES.has(rawType)) continue;
			const single = singleMovement(event, kind);
			if (!onOwnAccount(single.counterpartyId)) continue;
			const base = `${kind}:${rawType}:${single.counterpartyId ?? ''}:${single.tokenId ?? ''}:${single.amount?.toString() ?? ''}:${event.orderId ?? ''}`;
			const near = nearKey(singles.keys(), base, single.height);
			if (near) {
				const kept = singles.get(near)!;
				kept.events.push(event);
				continue;
			}
			singles.set(`${base}@${single.height}`, single);
			continue;
		}
		if (event.hash) {
			push(`htlc:${normalizeId(event.hash)}`, event);
			continue;
		}
		if (DIRECT_PAYMENT_TYPES.has(rawType)) {
			const base = `direct:${event.tokenId ?? '?'}:${amountText(event.amount)}`;
			push(nearKey(order, base, event.height) ?? `${base}@${event.height}`, event);
			continue;
		}
		// Resolve acknowledgements without a hashlock are consensus chatter for a lock already shown.
	}

	const folded: Movement[] = [];
	for (const key of order) {
		const movement = foldPayment(key, groups.get(key)!, self, recipients);
		if (movement.direction === 'neutral') continue;
		if (!onOwnAccount(movement.viaId ?? movement.counterpartyId)) continue;
		folded.push(movement);
	}
	return [...folded, ...singles.values()].sort((left, right) => right.timestamp - left.timestamp || right.height - left.height || right.id.localeCompare(left.id));
}

type ActivityPage = { events?: RuntimeActivityEvent[]; latestHeight?: number };

export function useMovements(
	entityId: string | null,
	types: readonly string[],
	limit: number,
	accountIds: readonly string[],
): { movements: Movement[]; loading: boolean; error: string | null } {
	const recipients = usePaymentIntents(s => s.recipients);
	const query = useMemo(() => ({ limit, types: [...types], ...(entityId ? { entityId } : {}) }), [entityId, limit, types]);
	const page = useAdapterRead<ActivityPage>(entityId ? 'activity' : null, query);
	const accountsKey = accountIds.join(',');
	const movements = useMemo(
		() => walletMovements(page.data?.events ?? [], entityId, recipients, accountsKey ? accountsKey.split(',') : []),
		[page.data, entityId, recipients, accountsKey],
	);
	return { movements, loading: page.loading, error: page.error };
}
