/**
 * Entity ownership on the EntityProvider: share tokens (control + dividend),
 * treasury release, and a CONTROL takeover of another entity this signer
 * validates. Same builders as the SvelteKit ownership workspace.
 */
import type { RuntimeAdapterViewFrame, RuntimeInput } from '@xln/core/api/public/runtime-module';
import {
	buildControlBoardActivationInputs,
	buildControlBoardProposalInput,
	buildEntityShareReleaseInput,
	projectEntityShareTokens,
	type ControlTakeoverBoard,
	type EntityShareTokenProjection,
} from '@xln/frontend/lib/components/Entity/ownership/ownership-flow';
import { getEmbeddedEnv, requireAdapter } from '../adapter';
import { getXLN, peekXLN } from '../xln-loader';
import { hostedJAdapter } from './move';

export type { EntityShareTokenProjection };

const normalize = (value: unknown): string => String(value || '').trim().toLowerCase();

export function isNumbered(entityId: string): boolean {
	const xln = peekXLN();
	if (!xln || !entityId) return false;
	try {
		return xln.isNumberedEntity(xln.toEntityId(entityId));
	} catch {
		return false;
	}
}

export type ReleaseState = { pendingNonce: bigint | null; confirmedNonce: bigint; generation: number };

export function releaseState(frame: RuntimeAdapterViewFrame | null): ReleaseState {
	const state = frame?.activeEntity?.core?.entityProviderActionState;
	const pending = state?.pending;
	const pendingRelease = pending && pending.payload.kind === 'releaseControlShares' ? pending : null;
	return {
		pendingNonce: pendingRelease ? BigInt(pendingRelease.actionNonce) : null,
		confirmedNonce: state?.confirmedNonce ?? 0n,
		generation: Number(state?.generation ?? 0),
	};
}

/** Control and dividend share reserves for a numbered entity, read from the token registry. */
export async function shareTokens(entityId: string, signerId: string, reserves: ReadonlyMap<number, bigint>): Promise<readonly EntityShareTokenProjection[]> {
	const xln = await getXLN();
	const jadapter = await hostedJAdapter(entityId, signerId);
	const registry = await jadapter.getTokenRegistry();
	return projectEntityShareTokens(
		xln.toEntityId(entityId),
		registry.map(token => ({ tokenId: token.tokenId, tokenType: token.tokenType, externalTokenId: token.externalTokenId.toString() })),
		reserves,
	);
}

export async function releaseShares(entityId: string, signerId: string, depositoryAddress: string): Promise<void> {
	const xln = await getXLN();
	const input = buildEntityShareReleaseInput({ entityId: xln.toEntityId(entityId), signerId, depositoryAddress });
	await requireAdapter().send({ runtimeTxs: [], entityInputs: [input] } as RuntimeInput);
}

export type TakeoverTarget = { entityId: string; name: string };

export type TakeoverStatus = { currentBoardHash: string; proposedBoardHash: string; currentBlock: bigint; activateAtBlock: bigint };

/** Other entities in this runtime whose board lists our signer: the only takeover candidates. */
export function takeoverTargets(entityId: string, signerId: string, names: Map<string, string>): TakeoverTarget[] {
	const env = getEmbeddedEnv();
	if (!env) return [];
	const self = normalize(entityId);
	const signer = normalize(signerId);
	const selfReplica = Array.from(env.state.eReplicas?.values?.() ?? []).find(replica => normalize(replica.state?.entityId) === self);
	const provider = normalize(selfReplica?.state?.config?.jurisdiction?.entityProviderAddress);
	const out = new Map<string, TakeoverTarget>();
	for (const replica of env.state.eReplicas?.values?.() ?? []) {
		const candidate = normalize(replica.state?.entityId);
		if (!candidate || candidate === self || normalize(replica.signerId) !== signer) continue;
		if (!replica.state?.config?.validators?.some(validator => normalize(validator) === signer)) continue;
		if (!provider || normalize(replica.state?.config?.jurisdiction?.entityProviderAddress) !== provider) continue;
		out.set(candidate, { entityId: candidate, name: names.get(candidate) || candidate });
	}
	return Array.from(out.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function requireTarget(targetEntityId: string, signerId: string) {
	const env = getEmbeddedEnv();
	if (!env) throw new Error('A takeover needs a local runtime');
	const target = normalize(targetEntityId);
	const signer = normalize(signerId);
	const replica = Array.from(env.state.eReplicas?.values?.() ?? []).find(candidate => normalize(candidate.state?.entityId) === target && normalize(candidate.signerId) === signer);
	if (!replica) throw new Error(`No replica of ${target.slice(0, 10)}… for this signer`);
	if (!replica.state.config.validators.some(validator => normalize(validator) === signer)) throw new Error('Our signer is not on that board');
	return { env, replica };
}

const takeoverBoard = (mode: ControlTakeoverBoard['mode'], signerId: string): ControlTakeoverBoard => ({
	mode,
	threshold: 1n,
	validators: [normalize(signerId)],
	shares: { [normalize(signerId)]: 1n },
});

export async function readTakeoverStatus(entityId: string, signerId: string, targetEntityId: string): Promise<TakeoverStatus> {
	const { replica } = requireTarget(targetEntityId, signerId);
	const jadapter = await hostedJAdapter(entityId, signerId);
	const entity = await jadapter.entityProvider.entities(replica.state.entityId);
	return {
		currentBoardHash: normalize(entity.currentBoardHash),
		proposedBoardHash: normalize(entity.proposedBoardHash),
		currentBlock: BigInt(await jadapter.provider.getBlockNumber()),
		activateAtBlock: BigInt(entity.activateAtBlock),
	};
}

export async function proposeTakeover(entityId: string, signerId: string, targetEntityId: string): Promise<void> {
	const xln = await getXLN();
	const { env, replica } = requireTarget(targetEntityId, signerId);
	const board = takeoverBoard(replica.state.config.mode, signerId);
	const boardHash = normalize(
		xln.hashBoard(
			xln.encodeBoard({ ...board, ...(replica.state.config.jurisdiction ? { jurisdiction: structuredClone(replica.state.config.jurisdiction) } : {}) }, env),
		),
	);
	const jadapter = await hostedJAdapter(entityId, signerId);
	const actionNonce = BigInt(await jadapter.entityProvider.boardActionNonces(replica.state.entityId)) + 1n;
	const input = buildControlBoardProposalInput({
		shareholderEntityId: xln.toEntityId(entityId),
		signerId: normalize(signerId),
		targetEntityId: xln.toEntityId(replica.state.entityId),
		newBoardHash: boardHash,
		actionNonce,
	});
	await requireAdapter().send({ runtimeTxs: [], entityInputs: [input] } as RuntimeInput);
}

export async function activateTakeover(entityId: string, signerId: string, targetEntityId: string): Promise<void> {
	const xln = await getXLN();
	const { replica } = requireTarget(targetEntityId, signerId);
	const inputs = buildControlBoardActivationInputs({
		shareholderEntityId: xln.toEntityId(entityId),
		targetEntityId: xln.toEntityId(replica.state.entityId),
		signerId: normalize(signerId),
		board: takeoverBoard(replica.state.config.mode, signerId),
	});
	await requireAdapter().send({ runtimeTxs: [], entityInputs: [...inputs] } as RuntimeInput);
}
