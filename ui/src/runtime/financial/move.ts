import { isAddress } from 'ethers';
import type { EntityTx, JBatch, RuntimeAdapterViewFrame } from '@xln/core/api/public/runtime-module';
import {
	buildBroadcastTx,
	buildExternalToReserveTx,
	buildMoveSettlementContinuation,
	buildReserveToCollateralTx,
	buildReserveToExternalEoaTx,
	buildReserveToReserveTx,
	type MovePostSettleOp,
} from '@xln/frontend/lib/components/Entity/account/entity-action-txs';
import {
	MOVE_ENDPOINT_LABEL,
	MOVE_ENDPOINTS,
	buildMoveRouteSteps,
	canAddMoveRouteToDraft,
	getMoveRouteKey,
	isExternalTransferMoveRoute,
	isMoveRouteSupported,
	moveNeedsExternalRecipient,
	moveNeedsReserveRecipient,
	routeRequiresExplicitExternalAllowance,
	type MoveEndpoint,
} from '@xln/frontend/lib/components/Entity/move-routes';
import { getEmbeddedEnv } from '../adapter';
import { deriveAddress, derivePrivateKeyBytes } from '../keys';
import { useApp } from '../store';
import { sendEntityTxs } from '../tx';
import { getXLN } from '../xln-loader';
import type { WalletView } from '../views';

export { MOVE_ENDPOINT_LABEL, MOVE_ENDPOINTS, buildMoveRouteSteps, getMoveRouteKey, isMoveRouteSupported, type MoveEndpoint };

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

/** Same three places Home draws: the signer's on-chain wallet, the Depository reserve, bilateral accounts. */
export type MoveIntent = {
	from: MoveEndpoint;
	to: MoveEndpoint;
	tokenId: number;
	amount: bigint;
	/** from = account: the counterparty whose account the money leaves. */
	sourceAccountId: string;
	/** to = account: who receives (default self) and through which counterparty. */
	targetEntityId: string;
	targetHubId: string;
	/** to = reserve: whose reserve (default self). */
	reserveRecipientId: string;
	/** to = external: EOA address. */
	externalRecipient: string;
	/** from = external: ERC20 contract of the token being deposited. */
	tokenAddress: string;
};

export type ExternalTokenRow = { tokenAddress: string; tokenId: number; balance: bigint; allowance: bigint | null };

/** On-chain balances the runtime has observed for this signer, by token. */
export function externalTokens(frame: RuntimeAdapterViewFrame | null, signerId: string, depository: string): ExternalTokenRow[] {
	const wallet = frame?.activeEntity?.core?.externalWallet;
	const owner = normalizeId(signerId);
	const rows = new Map<string, ExternalTokenRow>();
	for (const [ownerKey, byToken] of wallet?.balances?.entries() ?? []) {
		if (owner && normalizeId(ownerKey) !== owner) continue;
		for (const record of byToken.values()) {
			if (typeof record.tokenId !== 'number') continue;
			const tokenAddress = normalizeId(record.tokenAddress);
			rows.set(tokenAddress, { tokenAddress, tokenId: record.tokenId, balance: record.balance, allowance: null });
		}
	}
	const spender = normalizeId(depository);
	for (const [ownerKey, byKey] of wallet?.allowances?.entries() ?? []) {
		if (owner && normalizeId(ownerKey) !== owner) continue;
		for (const record of byKey.values()) {
			if (spender && normalizeId(record.spender) !== spender) continue;
			const row = rows.get(normalizeId(record.tokenAddress));
			if (row) row.allowance = record.allowance;
		}
	}
	return [...rows.values()].sort((a, b) => a.tokenId - b.tokenId);
}

/** Reserve movement already queued in the draft batch, so "available" never double-spends. */
export function draftReserveDelta(entityId: string, batch: JBatch | null | undefined, tokenId: number): bigint {
	if (!batch) return 0n;
	const self = normalizeId(entityId);
	let delta = 0n;
	for (const op of batch.externalTokenToReserve ?? []) {
		if ((op.entity ? normalizeId(op.entity) : self) === self && op.internalTokenId === tokenId) delta += op.amount;
	}
	for (const op of batch.collateralToReserve ?? []) if (op.tokenId === tokenId) delta += op.amount;
	for (const settlement of batch.settlements ?? []) {
		for (const diff of settlement.diffs ?? []) {
			if (diff.tokenId !== tokenId) continue;
			if (normalizeId(settlement.leftEntity) === self) delta += diff.leftDiff;
			else if (normalizeId(settlement.rightEntity) === self) delta += diff.rightDiff;
		}
	}
	for (const op of batch.reserveToReserve ?? []) {
		if (op.tokenId !== tokenId) continue;
		delta -= op.amount;
		if (normalizeId(op.receivingEntity) === self) delta += op.amount;
	}
	for (const op of batch.reserveToExternalToken ?? []) if (op.tokenId === tokenId) delta -= op.amount;
	for (const op of batch.reserveToCollateral ?? []) {
		if (op.tokenId !== tokenId) continue;
		for (const pair of op.pairs ?? []) delta -= pair.amount;
	}
	return delta;
}

export function openOutgoingDebt(frame: RuntimeAdapterViewFrame | null, tokenId: number): bigint {
	let total = 0n;
	for (const debt of frame?.activeEntity?.core?.outDebtsByToken?.get(tokenId)?.values() ?? []) {
		if (debt.status === 'open') total += debt.remainingAmount;
	}
	return total;
}

/** What can leave each place right now, for one token. */
export function availableAt(place: MoveEndpoint, wallet: WalletView, tokenId: number, sourceAccountId: string, external: ExternalTokenRow[]): bigint {
	const core = wallet.frame?.activeEntity?.core;
	switch (place) {
		case 'external':
			return external.find(row => row.tokenId === tokenId)?.balance ?? 0n;
		case 'reserve': {
			const reserve = (core?.reserves?.get(tokenId) ?? 0n) + draftReserveDelta(wallet.entityId, core?.jBatchState?.batch, tokenId);
			const debt = openOutgoingDebt(wallet.frame, tokenId);
			return reserve > debt ? reserve - debt : 0n;
		}
		case 'account': {
			const account = wallet.accounts.find(entry => entry.counterpartyId === normalizeId(sourceAccountId));
			return account?.tokens.find(token => token.tokenId === tokenId)?.derived.outCapacity ?? 0n;
		}
	}
}

export function awaitingCounterparty(frame: RuntimeAdapterViewFrame | null): boolean {
	return (frame?.activeEntity?.core?.settlementContinuations?.size ?? 0) > 0;
}

export function hasSentBatch(frame: RuntimeAdapterViewFrame | null): boolean {
	const sent = frame?.activeEntity?.core?.jBatchState?.sentBatch?.batch;
	return Boolean(sent && countBatchOps(sent) > 0);
}

export function countBatchOps(batch: JBatch | null | undefined): number {
	if (!batch) return 0;
	return (
		(batch.flashloans?.length || 0) +
		(batch.reserveToCollateral?.length || 0) +
		(batch.collateralToReserve?.length || 0) +
		(batch.settlements?.length || 0) +
		(batch.reserveToReserve?.length || 0) +
		(batch.disputeStarts?.length || 0) +
		(batch.counterDisputes?.length || 0) +
		(batch.disputeFinalizations?.length || 0) +
		(batch.externalTokenToReserve?.length || 0) +
		(batch.reserveToExternalToken?.length || 0) +
		(batch.revealSecrets?.length || 0) +
		(batch.hashLadderRegistrations?.length || 0)
	);
}

export type MoveMode = 'draft' | 'now';

/** Same rules the SvelteKit move workspace enforces before a route is queued. */
export function validateMove(input: {
	intent: MoveIntent;
	mode: MoveMode;
	self: string;
	selfSigner: string;
	available: bigint;
	awaiting: boolean;
	sentBatch: boolean;
	allowance: bigint | null;
}): string | null {
	const { intent, mode } = input;
	if (!isMoveRouteSupported(intent.from, intent.to)) return 'This route is not available';
	if ((intent.from === 'account' || intent.to === 'account') && input.awaiting) return 'Wait for the current account settlement to finish';
	if (mode === 'draft' && input.sentBatch) return 'A batch is already on its way; wait for it or clear it first';
	if (mode === 'draft' && !canAddMoveRouteToDraft(intent.from, intent.to)) return 'Wallet-to-wallet sends go out directly, not in a batch';
	if (intent.amount <= 0n) return 'Enter an amount';
	if (intent.amount > input.available) return 'Amount exceeds what is available here';
	const self = normalizeId(input.self);
	if (intent.from === 'account' && !intent.sourceAccountId) return 'Choose the account the money leaves';
	if (intent.to === 'account' && (!intent.targetEntityId || !intent.targetHubId)) return 'Choose who receives and through whom';
	if (moveNeedsReserveRecipient(intent.from, intent.to) && !intent.reserveRecipientId) return 'Choose whose reserve receives';
	if (moveNeedsExternalRecipient(intent.from, intent.to)) {
		if (!intent.externalRecipient) return 'Enter the receiving wallet address';
		if (!isAddress(intent.externalRecipient)) return 'That is not a valid wallet address';
		if (intent.from === 'external' && normalizeId(intent.externalRecipient) === normalizeId(input.selfSigner)) return 'That is your own wallet';
	}
	if (intent.from === 'account' && intent.to === 'account' && normalizeId(intent.targetEntityId) === self && normalizeId(intent.targetHubId) === normalizeId(intent.sourceAccountId)) {
		return 'Same account on both sides';
	}
	if (intent.from === 'reserve' && intent.to === 'reserve' && normalizeId(intent.reserveRecipientId) === self) return 'Your reserve to your reserve moves nothing';
	if (intent.from === 'external' && !intent.tokenAddress) return 'This token has no on-chain contract here';
	if (mode === 'draft' && routeRequiresExplicitExternalAllowance(intent.from, intent.to) && (input.allowance === null || input.allowance < intent.amount)) {
		return 'Allow the Depository to pull this token first';
	}
	return null;
}

/** The exact entity transactions the SvelteKit workspace queues for a route. */
export function buildMoveTxs(self: string, intent: MoveIntent, mode: MoveMode): EntityTx[] {
	const selfId = normalizeId(self);
	const broadcast = mode === 'now';
	const txs: EntityTx[] = [];
	const target = normalizeId(intent.targetEntityId) || selfId;
	switch (getMoveRouteKey(intent.from, intent.to)) {
		case 'external->reserve':
			txs.push(buildExternalToReserveTx({ contractAddress: intent.tokenAddress, amount: intent.amount, internalTokenId: intent.tokenId }));
			break;
		case 'external->account':
			txs.push(buildExternalToReserveTx({ contractAddress: intent.tokenAddress, amount: intent.amount, internalTokenId: intent.tokenId }));
			txs.push(buildReserveToCollateralTx({ counterpartyEntityId: normalizeId(intent.targetHubId), selfEntityId: selfId, receivingEntityId: target, tokenId: intent.tokenId, amount: intent.amount }));
			break;
		case 'reserve->reserve':
			txs.push(buildReserveToReserveTx(normalizeId(intent.reserveRecipientId), intent.tokenId, intent.amount));
			break;
		case 'reserve->account':
			txs.push(buildReserveToCollateralTx({ counterpartyEntityId: normalizeId(intent.targetHubId), selfEntityId: selfId, receivingEntityId: target, tokenId: intent.tokenId, amount: intent.amount }));
			break;
		case 'reserve->external':
			txs.push(buildReserveToExternalEoaTx(intent.externalRecipient, intent.tokenId, intent.amount));
			break;
		case 'account->reserve':
		case 'account->external':
		case 'account->account': {
			const counterparty = normalizeId(intent.sourceAccountId);
			const post: MovePostSettleOp =
				intent.to === 'external'
					? { type: 'r2e', recipientEoa: intent.externalRecipient }
					: intent.to === 'account'
						? { type: 'reserve_to_collateral', targetEntityId: target, counterpartyEntityId: normalizeId(intent.targetHubId) }
						: normalizeId(intent.reserveRecipientId) && normalizeId(intent.reserveRecipientId) !== selfId
							? { type: 'r2r', recipientEntityId: normalizeId(intent.reserveRecipientId) }
							: { type: 'none' };
			txs.push({
				type: 'settle_propose',
				data: {
					counterpartyEntityId: counterparty,
					executorIsLeft: selfId < counterparty,
					memo: 'asset-c2r',
					ops: [{ type: 'c2r', tokenId: intent.tokenId, amount: intent.amount }],
					continuation: buildMoveSettlementContinuation(selfId, intent.tokenId, intent.amount, post, broadcast),
				},
			});
			// The settlement carries its own broadcast flag; nothing else to queue now.
			return txs;
		}
		default:
			throw new Error(`MOVE_ROUTE_UNSUPPORTED:${intent.from}->${intent.to}`);
	}
	if (broadcast) txs.push(buildBroadcastTx());
	return txs;
}

export async function submitMove(entityId: string, signerId: string, intent: MoveIntent, mode: MoveMode): Promise<void> {
	await sendEntityTxs(entityId, signerId, buildMoveTxs(entityId, intent, mode));
}

export { isExternalTransferMoveRoute };

// ---------------------------------------------------------------------------
// On-chain signer actions: only where this runtime holds the jurisdiction
// adapter and the vault seed (the sandbox, an embedded runtime).
// ---------------------------------------------------------------------------

function signerPrivateKey(signerId: string): Uint8Array {
	const state = useApp.getState();
	const seed = state.activeVaultId ? state.sessionSeeds[state.activeVaultId] : undefined;
	if (!seed) throw new Error('SIGNER_KEY_LOCKED');
	for (let index = 0; index < 8; index += 1) {
		if (deriveAddress(seed, index) === normalizeId(signerId)) return derivePrivateKeyBytes(seed, index);
	}
	throw new Error('SIGNER_KEY_NOT_IN_VAULT');
}

async function hostedJAdapter(entityId: string, signerId: string) {
	const env = getEmbeddedEnv();
	if (!env) throw new Error('ONCHAIN_ACTIONS_NEED_A_LOCAL_RUNTIME');
	const xln = await getXLN();
	const jadapter = xln.getEntityJAdapter(env, entityId, signerId);
	if (!jadapter) throw new Error('JURISDICTION_ADAPTER_UNAVAILABLE');
	return jadapter;
}

export async function depositoryAddress(entityId: string, signerId: string): Promise<string> {
	try {
		return normalizeId((await hostedJAdapter(entityId, signerId)).addresses.depository);
	} catch {
		return '';
	}
}

/** ERC20 approval for the Depository, as the signer; waits until the chain reports it. */
export async function approveDepository(entityId: string, signerId: string, tokenAddress: string, amount: bigint, tokenId: number): Promise<bigint> {
	const jadapter = await hostedJAdapter(entityId, signerId);
	const spender = jadapter.addresses.depository;
	await jadapter.approveErc20(signerPrivateKey(signerId), tokenAddress, spender, amount, { entityId, tokenId });
	const deadline = Date.now() + 5_000;
	for (;;) {
		const allowance = await jadapter.getErc20Allowance(tokenAddress, signerId, spender);
		if (allowance >= amount) return allowance;
		if (Date.now() > deadline) throw new Error('APPROVAL_NOT_CONFIRMED');
		await new Promise(resolve => setTimeout(resolve, 250));
	}
}

/** Wallet-to-wallet ERC20 transfer signed by the entity's signer; no runtime input. */
export async function sendExternal(entityId: string, signerId: string, tokenAddress: string, to: string, amount: bigint): Promise<string> {
	const jadapter = await hostedJAdapter(entityId, signerId);
	return jadapter.transferErc20(signerPrivateKey(signerId), tokenAddress, to, amount);
}
