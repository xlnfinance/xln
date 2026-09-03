import type { PaymentDeliveryMode } from '@xln/core/api/public/runtime-module';
import type { RuntimeAdapterPaymentRoutesResponse, RuntimeAdapterSendResult } from '@xln/core/api/runtime-adapter/types';
import { buildPaymentRuntimeInput } from '@xln/frontend/lib/components/Entity/payments/runtime/payment-command';
import type { PaymentRouteQuote } from '@xln/frontend/lib/components/Entity/payments/runtime/payment-route-quote';
import { requireAdapter } from '../adapter';
import { usePaymentIntents } from './movements';

export type { PaymentRouteQuote };

export type DeliveryOption = {
	value: PaymentDeliveryMode;
	label: string;
	description: string;
	recommended?: boolean;
};

/** Same four modes, same copy, same default as the SvelteKit PaymentPanel. */
export const DELIVERY_OPTIONS: readonly DeliveryOption[] = [
	{ value: 'instant', label: 'Instant', description: 'Atomic · recipient online', recommended: true },
	{ value: 'async', label: 'Async', description: 'Atomic · recipient may be offline' },
	{ value: 'direct', label: 'Direct', description: 'One hop · shared account' },
	{ value: 'trusted', label: 'Trusted', description: 'Trusts the selected hub' },
];

const MAX_ROUTES = 100;
const ENTITY_ID_RE = /^0x[0-9a-f]{64}$/;

export const isEntityId = (value: string): boolean => ENTITY_ID_RE.test(value.trim().toLowerCase());

/**
 * Routes come from the Runtime's own pathfinder through the adapter, identical in
 * embedded and remote mode (`payment-routes` mirrors the server rpc-ws
 * findPaymentRoutes). The UI never invents a route the Runtime would not sign.
 */
export async function quotePaymentRoutes(input: {
	sourceEntityId: string;
	targetEntityId: string;
	tokenId: number;
	amount: bigint;
}): Promise<PaymentRouteQuote[]> {
	const response = await requireAdapter().read<RuntimeAdapterPaymentRoutesResponse>('payment-routes', {
		sourceEntityId: input.sourceEntityId,
		targetEntityId: input.targetEntityId,
		tokenId: input.tokenId,
		amount: input.amount.toString(),
	});
	const quotes: PaymentRouteQuote[] = response.routes.map(route => ({
		path: route.path.map(id => id.toLowerCase()),
		hops: route.hops.map(hop => ({
			from: hop.from.toLowerCase(),
			to: hop.to.toLowerCase(),
			fee: BigInt(hop.fee),
			feePPM: hop.feePPM,
		})),
		totalFee: BigInt(route.totalFee),
		senderAmount: BigInt(route.senderAmount),
		recipientAmount: BigInt(route.recipientAmount),
	}));
	return sortRoutes(quotes).slice(0, MAX_ROUTES);
}

/** Cheapest first, then fewest hops, then smallest debit. Mirrors PaymentPanel.sortRoutesList. */
export function sortRoutes(routes: readonly PaymentRouteQuote[]): PaymentRouteQuote[] {
	return [...routes].sort((a, b) => {
		if (a.totalFee !== b.totalFee) return a.totalFee < b.totalFee ? -1 : 1;
		if (a.hops.length !== b.hops.length) return a.hops.length - b.hops.length;
		if (a.senderAmount !== b.senderAmount) return a.senderAmount < b.senderAmount ? -1 : 1;
		return a.path.length - b.path.length;
	});
}

/** Direct needs a bilateral route; trusted needs exactly one fee-free gateway. */
export function eligibleRoutes(routes: readonly PaymentRouteQuote[], mode: PaymentDeliveryMode): PaymentRouteQuote[] {
	return routes.filter(route => {
		if (mode === 'direct') return route.path.length === 2;
		if (mode === 'trusted') return route.path.length === 3 && route.totalFee === 0n;
		return true;
	});
}

export function routeModeError(route: PaymentRouteQuote | null, mode: PaymentDeliveryMode): string | null {
	if (!route) return null;
	if (mode === 'direct' && route.path.length !== 2) return 'Direct delivery requires a bilateral route.';
	if (mode === 'trusted' && (route.path.length !== 3 || route.totalFee !== 0n)) {
		return 'Trusted delivery requires one fee-free gateway.';
	}
	return null;
}

/** The exact RuntimeInput the SvelteKit PaymentPanel submits, through the same adapter command lane. */
export async function submitPayment(input: {
	entityId: string;
	signerId: string;
	targetEntityId: string;
	tokenId: number;
	deliveryMode: PaymentDeliveryMode;
	description: string;
	route: PaymentRouteQuote;
}): Promise<RuntimeAdapterSendResult> {
	const result = await requireAdapter().send(buildPaymentRuntimeInput(input));
	usePaymentIntents.getState().record({
		entityId: input.entityId,
		targetEntityId: input.targetEntityId,
		tokenId: input.tokenId,
		amounts: [input.route.recipientAmount.toString(), input.route.senderAmount.toString()],
		description: input.description.trim(),
		submittedAt: Date.now(),
	});
	return result;
}
