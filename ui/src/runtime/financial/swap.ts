import { sendRuntimeInput } from '../commands';
import type {
	AccountReplica,
	AccountState,
	CrossJurisdictionSwapRoute,
	RuntimeAdapterEntitySummary,
	RuntimeAdapterViewFrame,
} from '@xln/core/api/public/runtime-module';
import { getJurisdictionStackId } from '@xln/core/api/public/runtime-module';
import type { SwapCommandPlan, SwapCommandPlanInput } from '@xln/core/runtime/swap-cmd/swap-command-plan';

import { getEmbeddedEnv, requireAdapter } from '../adapter';
import { getXLN } from '../xln-loader';
import { committedRoles, gossipProfile, partyRoles } from './roles';

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

export type SwapParty = {
	entityId: string;
	signerId: string;
	hubEntityId: string;
	/** Jurisdiction stack id of the entity's configured jurisdiction. */
	jurisdiction: string;
	account: SwapCommandPlanInput['source']['account'];
};

export function jurisdictionRef(frame: RuntimeAdapterViewFrame | null): string {
	const config = frame?.activeEntity?.core?.config?.jurisdiction;
	return config ? getJurisdictionStackId(config) : '';
}

/** The hub's published taker fee. No fee policy means no order: the runtime would reject an unauthorized net. */
export function hubTakerFeeBps(hubEntityId: string): number {
	const feeBps = gossipProfile(normalizeId(hubEntityId))?.metadata?.swapTakerFeeBps;
	if (!Number.isSafeInteger(feeBps)) throw new Error('SWAP_FEE_POLICY_UNAVAILABLE');
	return Number(feeBps);
}

export function compatibleSwapHubs(sourceHubId: string, targetHubId: string): boolean {
	const sourceRuntime = normalizeId(gossipProfile(sourceHubId)?.runtimeId);
	const targetRuntime = normalizeId(gossipProfile(targetHubId)?.runtimeId);
	return Boolean(sourceRuntime && sourceRuntime === targetRuntime);
}

export async function readAccountState(entityId: string, counterpartyId: string): Promise<AccountState | null> {
	try {
		const doc = await requireAdapter().read<AccountReplica>(
			`entity/${encodeURIComponent(normalizeId(entityId))}/account/${encodeURIComponent(normalizeId(counterpartyId))}`,
		);
		if (doc && (doc.status !== 'active' || doc.activeDispute)) {
			throw new Error(`ACCOUNT_FROZEN:${counterpartyId}`);
		}
		return (doc?.state as AccountState | undefined) ?? null;
	} catch (error) {
		if (error instanceof Error && /E_NOT_FOUND|account not found/i.test(error.message)) return null;
		throw error;
	}
}

export type SwapPlanRequest = {
	mode: 'same' | 'cross';
	frame: RuntimeAdapterViewFrame;
	source: SwapParty;
	target?: SwapParty;
	giveTokenId: number;
	giveTokenDecimals: number;
	wantTokenId: number;
	wantTokenDecimals: number;
	giveAmount: bigint;
	priceTicks: bigint;
	expectedWantAmount: bigint;
	routeValue: string;
};

/**
 * One canonical planner for both modes, the runtime's planSwapCommand. The plan
 * carries the exact RuntimeInput (same network) or the cross-network intent plus
 * an optional target setup input. Mirrors the SvelteKit SwapPanel submission.
 */
/**
 * The hub's signer for a swap command. A hub hosted in this runtime shows its signer in the entity summary;
 * a remote hub does not (gossip carries no signer), so fall back to the runtime's proposer resolution, which
 * knows the hub runtime's signer from its verified profile route, the same way the SvelteKit swap panel does.
 */
function hubSignerIdFor(xln: Awaited<ReturnType<typeof getXLN>>, hubEntityId: string, summary: RuntimeAdapterEntitySummary | undefined): string {
	const fromSummary = normalizeId(summary?.signerId || '');
	if (fromSummary) return fromSummary;
	const env = getEmbeddedEnv();
	if (!env) return '';
	try {
		return normalizeId(xln.resolveEntityProposerId(env, normalizeId(hubEntityId), 'swap-plan') || '');
	} catch {
		return '';
	}
}

export async function planSwap(request: SwapPlanRequest): Promise<SwapCommandPlan> {
	const xln = await getXLN();
	const summaries = request.frame.entities;
	const roles = committedRoles(summaries);
	const logicalTimestamp = Number(request.frame.activeEntity?.core?.timestamp ?? 0);
	const logicalHeight = Number(request.frame.activeEntity?.core?.height ?? 0);
	if (logicalTimestamp <= 0 || logicalHeight <= 0) throw new Error('Swap runtime clock is unavailable');

	const sourceRoles = partyRoles({
		entityId: request.source.entityId,
		hubEntityId: request.source.hubEntityId,
		roles,
		summaries,
		label: 'SOURCE',
	});
	const sourceHub = summaries.find(summary => normalizeId(summary.entityId) === normalizeId(request.source.hubEntityId));
	const sourceHubSignerId = hubSignerIdFor(xln, request.source.hubEntityId, sourceHub);
	if (!sourceHubSignerId) throw new Error(`SWAP_HUB_SIGNER_UNAVAILABLE:${request.source.hubEntityId}`);

	const net =
		request.mode === 'same'
			? xln.deriveSwapNetAuthorization(request.expectedWantAmount, hubTakerFeeBps(request.source.hubEntityId))
			: { maxFee: 0n, minNetReceive: request.expectedWantAmount };

	const source: SwapCommandPlanInput['source'] = {
		entityId: request.source.entityId,
		signerId: request.source.signerId,
		hubEntityId: request.source.hubEntityId,
		hubSignerId: sourceHubSignerId,
		jurisdiction: request.source.jurisdiction,
		...sourceRoles,
		committedRoles: roles,
		account: request.source.account,
	};

	let target: SwapCommandPlanInput['target'] | undefined;
	if (request.mode === 'cross') {
		if (!request.target) throw new Error('Select the account on the other network.');
		const targetHub = summaries.find(summary => normalizeId(summary.entityId) === normalizeId(request.target?.hubEntityId));
		const targetHubSignerId = hubSignerIdFor(xln, request.target.hubEntityId, targetHub);
		if (!targetHubSignerId) throw new Error(`SWAP_HUB_SIGNER_UNAVAILABLE:${request.target.hubEntityId}`);
		target = {
			entityId: request.target.entityId,
			signerId: request.target.signerId,
			hubEntityId: request.target.hubEntityId,
			hubSignerId: targetHubSignerId,
			jurisdiction: request.target.jurisdiction,
			...partyRoles({
				entityId: request.target.entityId,
				hubEntityId: request.target.hubEntityId,
				roles,
				summaries,
				label: 'TARGET',
			}),
			committedRoles: roles,
			account: request.target.account,
		};
	}

	const plan = xln.planSwapCommand({
		mode: request.mode,
		logicalTimestamp,
		logicalHeight,
		routeValue: request.routeValue,
		giveTokenId: request.giveTokenId,
		giveTokenDecimals: request.giveTokenDecimals,
		wantTokenId: request.wantTokenId,
		wantTokenDecimals: request.wantTokenDecimals,
		giveAmount: request.giveAmount,
		priceTicks: request.priceTicks,
		...net,
		source,
		...(target ? { target, allowOpenTargetAccount: target.account === null } : {}),
		expiresInMs: 24 * 60 * 60 * 1_000,
	});
	if (plan.mode !== request.mode) throw new Error(`SWAP_COMMAND_PLAN_MODE_MISMATCH:${plan.mode}`);
	return plan;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Opening the target Account is a bilateral proposal; the readiness check is side-effect free, so retrying is safe. */
async function submitCrossIntent(route: CrossJurisdictionSwapRoute, waitForTargetReady: boolean): Promise<void> {
	const adapter = requireAdapter();
	const deadline = Date.now() + 20_000;
	for (;;) {
		try {
			await adapter.submitCrossJurisdictionIntent(route);
			return;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!waitForTargetReady || !(message.startsWith('CROSS_J_TARGET_INBOUND_NOT_READY:') || message.startsWith('RECEIVE_CAPACITY_ACCOUNT_MISSING:'))) throw error;
			if (Date.now() >= deadline) throw new Error(`CROSS_J_TARGET_READINESS_TIMEOUT:${message}`, { cause: error });
			await sleep(100);
		}
	}
}

export async function submitSwapPlan(plan: SwapCommandPlan): Promise<void> {
	if (plan.mode === 'same') {
		await sendRuntimeInput(plan.runtimeInput);
		return;
	}
	if (plan.targetSetupInput) {
		const env = getEmbeddedEnv();
		if (!env) throw new Error('SWAP_TARGET_SETUP_REQUIRES_EMBEDDED_RUNTIME');
		const xln = await getXLN();
		await xln.ensureGossipProfiles(env, plan.targetSetupInput.entityInputs.flatMap(input => (input.entityTxs ?? []).flatMap(tx => tx.type === 'openAccount' ? [tx.data.targetEntityId] : [])));
		await sendRuntimeInput(plan.targetSetupInput);
	}
	await submitCrossIntent(plan.crossJurisdictionIntent, plan.targetSetupInput !== null);
}

/**
 * This wallet's cross-jurisdiction orders that are still live.
 *
 * A cross order lives in the Entity's own committed state, not in a bilateral
 * book, so the same-network offer list never showed it. Without this a position
 * that stopped moving was invisible and therefore unclearable, which is how
 * money gets stranded across two chains.
 */
export type CrossOrderView = {
	orderId: string;
	status: string;
	sourceTokenId: number;
	sourceAmount: bigint;
	targetTokenId: number;
	targetAmount: bigint;
	sourceJurisdiction: string;
	targetJurisdiction: string;
	filledSourceAmount: bigint;
	clearRequested: boolean;
};

const LIVE_CROSS_STATUSES = new Set(['intent', 'target_prepared', 'resting', 'partially_filled', 'clear_requested', 'clearing']);

export function liveCrossOrders(frame: RuntimeAdapterViewFrame | null, entityId: string): CrossOrderView[] {
	const routes = frame?.activeEntity?.core?.crossJurisdictionSwaps;
	if (!(routes instanceof Map) || !entityId) return [];
	const self = entityId.toLowerCase();
	const orders: CrossOrderView[] = [];
	for (const route of routes.values()) {
		const status = String(route?.status ?? '');
		if (!LIVE_CROSS_STATUSES.has(status)) continue;
		if (String(route?.source?.entityId ?? '').toLowerCase() !== self) continue;
		orders.push({
			orderId: String(route.orderId ?? ''),
			status,
			sourceTokenId: Number(route.source?.tokenId ?? 0),
			sourceAmount: route.source?.amount ?? 0n,
			targetTokenId: Number(route.target?.tokenId ?? 0),
			targetAmount: route.target?.amount ?? 0n,
			sourceJurisdiction: String(route.source?.jurisdiction ?? ''),
			targetJurisdiction: String(route.target?.jurisdiction ?? ''),
			filledSourceAmount: route.filledSourceAmount ?? 0n,
			clearRequested: status === 'clear_requested' || status === 'clearing',
		});
	}
	return orders.filter(order => order.orderId).sort((left, right) => left.orderId.localeCompare(right.orderId));
}
