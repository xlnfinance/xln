/**
 * Account management: the same entity txs the SvelteKit "Configure" panel
 * sends (collateral request, add token, dispute prepare/finalize, settlement
 * signature) plus the hub's HTTP credit request. Pure helpers over the account
 * document the view-frame already carries; nothing here reads the env.
 */
import type { EntityTx, JBatch, RuntimeAdapterViewFrame } from '@xln/core/api/public/runtime-module';
import type { SettlementOp } from '@xln/core/types/account';
import { postJson } from '../http';

/** One account as the view-frame carries it (native maps instead of persistent collections). */
export type AccountDoc = NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number];

export type FeePolicy = { policyVersion: number; baseFee: bigint; gasFee: bigint; liquidityFeeBps: bigint };

/**
 * The counterparty's committed rebalance fee policy for a token. We are on one
 * side; the fee we pay is set by the other side's snapshot.
 */
export function counterpartyFeePolicy(doc: AccountDoc | null | undefined, isLeft: boolean, tokenId: number): FeePolicy | null {
	const policy = doc?.state?.rebalanceFeePolicies?.get(tokenId)?.[isLeft ? 'right' : 'left'];
	if (!policy) return null;
	return { policyVersion: policy.policyVersion, baseFee: policy.baseFee, gasFee: policy.gasFee, liquidityFeeBps: policy.liquidityFeeBps };
}

export function collateralFee(policy: FeePolicy, amount: bigint): bigint {
	return policy.baseFee + policy.gasFee + (amount * policy.liquidityFeeBps) / 10_000n;
}

export function buildRequestCollateralTx(counterpartyEntityId: string, tokenId: number, amount: bigint, policy: FeePolicy): EntityTx {
	if (policy.baseFee < 0n || policy.gasFee < 0n || policy.liquidityFeeBps < 0n) throw new Error('The counterparty fee policy contains negative values');
	const feeAmount = collateralFee(policy, amount);
	if (feeAmount >= amount) throw new Error('The fee must be lower than the amount requested');
	return {
		type: 'requestCollateral',
		data: { counterpartyEntityId, tokenId, amount, feeTokenId: tokenId, feeAmount, policyVersion: policy.policyVersion },
	};
}

/** Adds a token lane with zero credit; "Extend credit" sets the line afterwards. */
export function buildAddTokenTx(counterpartyEntityId: string, tokenId: number): EntityTx {
	return { type: 'extendCredit', data: { counterpartyEntityId, tokenId, amount: 0n } };
}

export function buildPrepareDisputeTx(counterpartyEntityId: string, description = 'dispute-prepare-from-configure'): EntityTx {
	return { type: 'prepareDispute', data: { counterpartyEntityId, description } };
}

export function buildDisputeFinalizeTx(counterpartyEntityId: string, description = 'dispute-finalize-from-configure'): EntityTx {
	return { type: 'disputeFinalize', data: { counterpartyEntityId, description } };
}

export function buildSettleApproveTx(counterpartyEntityId: string, workspaceHash: string): EntityTx {
	return { type: 'settle_approve', data: { counterpartyEntityId, workspaceHash } };
}

/** queued = the dispute start sits in our draft batch; sent = the batch went to the chain and DisputeStarted is not observed yet; active = activeDispute set. */
export type DisputePhase = 'none' | 'preparing' | 'queued' | 'sent' | 'active';

export type DisputeView = {
	phase: DisputePhase;
	/** True when we started the on-chain dispute. */
	startedByUs: boolean;
	/** Unix seconds when the challenge window closes; 0 when not on-chain yet. */
	timeout: number;
	observedOnChain: boolean;
	finalizeQueued: boolean;
	reason: string;
};

export function disputeView(doc: AccountDoc | null | undefined, isLeft: boolean, draftBatch?: JBatch | null): DisputeView {
	const active = doc?.activeDispute;
	if (active) {
		return {
			phase: 'active',
			startedByUs: active.startedByLeft === isLeft,
			timeout: Number(active.disputeTimeout || 0),
			observedOnChain: active.observedOnChain === true,
			finalizeQueued: active.finalizeQueued === true,
			reason: String(doc?.disputePrepare?.reason || ''),
		};
	}
	if (String(doc?.status || '') === 'disputed') {
		const queued = (draftBatch?.disputeStarts?.length ?? 0) > 0;
		return { phase: queued ? 'queued' : 'sent', startedByUs: true, timeout: 0, observedOnChain: false, finalizeQueued: false, reason: String(doc?.disputePrepare?.reason || '') };
	}
	if (String(doc?.status || '') === 'dispute_preparing' || doc?.disputePrepare) {
		return { phase: 'preparing', startedByUs: true, timeout: 0, observedOnChain: false, finalizeQueued: false, reason: String(doc?.disputePrepare?.reason || '') };
	}
	return { phase: 'none', startedByUs: false, timeout: 0, observedOnChain: false, finalizeQueued: false, reason: '' };
}

export type SettlementPhase = 'none' | 'awaiting_you' | 'awaiting_them' | 'ready' | 'submitted' | 'draft';

export type SettlementView = {
	phase: SettlementPhase;
	label: string;
	workspaceHash: string;
	memo: string;
	ops: SettlementOp[];
	/** We proposed (or last edited) the workspace. */
	proposedByUs: boolean;
	/** We are the side that submits the batch on-chain. */
	weExecute: boolean;
	signedByUs: boolean;
	signedByThem: boolean;
	revision: number;
};

/** Same reading of the workspace as the SvelteKit account preview: sign only when it is our turn. */
export function settlementView(doc: AccountDoc | null | undefined, isLeft: boolean): SettlementView | null {
	const workspace = doc?.state?.settlementWorkspace;
	if (!workspace) return null;
	const proposedByUs = workspace.lastModifiedByLeft === isLeft;
	const signedByUs = Boolean(isLeft ? workspace.leftHanko : workspace.rightHanko);
	const signedByThem = Boolean(isLeft ? workspace.rightHanko : workspace.leftHanko);
	const status = String(workspace.status || '');
	let phase: SettlementPhase = 'none';
	let label = status.replace(/_/g, ' ');
	if (status === 'awaiting_counterparty') {
		if (!proposedByUs && !signedByUs) {
			phase = 'awaiting_you';
			label = 'Awaiting your signature';
		} else {
			phase = 'awaiting_them';
			label = proposedByUs ? 'Awaiting counterparty signature' : 'Awaiting signature';
		}
	} else if (status === 'ready_to_submit') {
		phase = 'ready';
		label = 'Both signed · going on-chain';
	} else if (status === 'submitted') {
		phase = 'submitted';
		label = 'Pending on-chain confirmation';
	} else if (status === 'draft') {
		phase = 'draft';
		label = 'Draft';
	}
	return {
		phase,
		label,
		workspaceHash: String(workspace.workspaceHash || ''),
		memo: String(workspace.memo || ''),
		ops: workspace.ops ?? [],
		proposedByUs,
		weExecute: workspace.executorIsLeft === isLeft,
		signedByUs,
		signedByThem,
		revision: Number(workspace.revision || 0),
	};
}

export function describeSettlementOp(op: SettlementOp, money: (tokenId: number, amount: bigint) => string, proposedByUs: boolean): string {
	const who = proposedByUs ? 'your' : 'their';
	switch (op.type) {
		case 'r2c':
			return `${money(op.tokenId, op.amount)} from ${who} reserve into collateral`;
		case 'c2r':
			return `${money(op.tokenId, op.amount)} of collateral to ${who} reserve`;
		case 'r2r':
			return `${money(op.tokenId, op.amount)} reserve to reserve`;
		case 'forgive':
			return `forgive debt in token ${op.tokenId}`;
		case 'rawDiff':
			return `raw diff · collateral ${money(op.tokenId, op.collateralDiff)}`;
		default:
			return 'settlement operation';
	}
}

/**
 * Ask the hub's HTTP API for a credit line. The frontend uses this because a
 * user cannot set the hub's own credit limit; the hub decides and commits.
 */
export async function requestCreditFromHub(input: { userEntityId: string; hubEntityId: string; tokenId: number; amount: bigint }): Promise<void> {
	await postJson('/api/credit/request', {
		userEntityId: input.userEntityId,
		hubEntityId: input.hubEntityId,
		tokenId: input.tokenId,
		amount: input.amount.toString(),
	});
}
