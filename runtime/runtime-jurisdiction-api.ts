import { ethers } from 'ethers';

import type { JAdapter } from './jadapter';
import { withCanonicalCrossJurisdictionRouteHash } from './cross-jurisdiction';
import { getJurisdictionStackId, requireEntityRuntimeJurisdictionConfig } from './jurisdiction-runtime';
import { resolveEntityProposerId } from './state-helpers';
import type { CrossJurisdictionSwapRoute, EntityState, Env, RuntimeInput } from './types';
import { getWallClockMs } from './utils';

export function getActiveJAdapter(env: Env): JAdapter | null {
  if (!env.activeJurisdiction) return null;
  const jReplica = env.jReplicas?.get(env.activeJurisdiction);
  return jReplica?.jadapter || null;
}

export function getEntityJAdapter(env: Env, entityId: string, signerId?: string): JAdapter | null {
  const jurisdiction = requireEntityRuntimeJurisdictionConfig(env, entityId, signerId);
  const jReplica = env.jReplicas?.get(jurisdiction.name);
  return jReplica?.jadapter || null;
}

export type CrossJurisdictionSwapSubmitParams = {
  orderId?: string;
  sourceUserEntityId: string;
  sourceHubEntityId: string;
  targetHubEntityId: string;
  targetUserEntityId: string;
  sourceTokenId: number;
  sourceAmount: bigint;
  targetTokenId: number;
  targetAmount: bigint;
  bookHubEntityId?: string;
  sourceUserSignerId?: string;
  sourceHubSignerId?: string;
  targetHubSignerId?: string;
  targetUserSignerId?: string;
  bookHubSignerId?: string;
  expiresInMs?: number;
  priceTicks?: bigint;
  priceImprovementMode?: CrossJurisdictionSwapRoute['priceImprovementMode'];
  memo?: string;
};

export type CrossJurisdictionSwapSubmitResult = {
  route: CrossJurisdictionSwapRoute;
};

export type CrossJurisdictionSwapSubmission = CrossJurisdictionSwapSubmitResult & {
  input: RuntimeInput;
};

const normalizeRuntimeEntityId = (entityId: string): string => String(entityId || '').toLowerCase();

const findEntityStateForRuntime = (env: Env, entityId: string, signerId?: string): EntityState | null => {
  const target = normalizeRuntimeEntityId(entityId);
  const signer = signerId ? String(signerId).toLowerCase() : null;
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const [keyEntity, keySigner] = String(replicaKey).split(':');
    const replicaEntity = normalizeRuntimeEntityId(replica.entityId || keyEntity || '');
    const replicaSigner = String(replica.signerId || keySigner || '').toLowerCase();
    if (replicaEntity !== target && normalizeRuntimeEntityId(keyEntity || '') !== target) continue;
    if (signer && replicaSigner !== signer && String(keySigner || '').toLowerCase() !== signer) continue;
    return replica.state;
  }
  return null;
};

const hasRuntimeAccountWith = (state: EntityState | null, counterpartyId: string): boolean => {
  const counterparty = normalizeRuntimeEntityId(counterpartyId);
  if (!state || !counterparty) return false;
  for (const [accountId, account] of state.accounts.entries()) {
    if (normalizeRuntimeEntityId(accountId) === counterparty) return true;
    if (normalizeRuntimeEntityId(account.leftEntity) === counterparty) return true;
    if (normalizeRuntimeEntityId(account.rightEntity) === counterparty) return true;
  }
  return false;
};

export function buildCrossJurisdictionSwapSubmission(
  env: Env,
  params: CrossJurisdictionSwapSubmitParams,
): CrossJurisdictionSwapSubmission {
  const now = env.scenarioMode ? env.timestamp : getWallClockMs();
  const orderId = params.orderId || `cross-${now}-${ethers.hexlify(ethers.randomBytes(4)).slice(2)}`;
  const sourceUserSignerId = params.sourceUserSignerId || resolveEntityProposerId(env, params.sourceUserEntityId, 'cross-swap.source-user');
  const sourceHubSignerId = params.sourceHubSignerId || resolveEntityProposerId(env, params.sourceHubEntityId, 'cross-swap.source-hub');
  const targetHubSignerId = params.targetHubSignerId || resolveEntityProposerId(env, params.targetHubEntityId, 'cross-swap.target-hub');
  const targetUserSignerId = params.targetUserSignerId || resolveEntityProposerId(env, params.targetUserEntityId, 'cross-swap.target-user');

  const sourceUserJ = requireEntityRuntimeJurisdictionConfig(env, params.sourceUserEntityId, sourceUserSignerId);
  const sourceHubJ = requireEntityRuntimeJurisdictionConfig(env, params.sourceHubEntityId, sourceHubSignerId);
  const targetHubJ = requireEntityRuntimeJurisdictionConfig(env, params.targetHubEntityId, targetHubSignerId);
  const targetUserJ = requireEntityRuntimeJurisdictionConfig(env, params.targetUserEntityId, targetUserSignerId);
  const sourceUserStackId = getJurisdictionStackId(sourceUserJ);
  const sourceHubStackId = getJurisdictionStackId(sourceHubJ);
  const targetHubStackId = getJurisdictionStackId(targetHubJ);
  const targetUserStackId = getJurisdictionStackId(targetUserJ);
  if (!sourceUserStackId || !sourceHubStackId || !targetHubStackId || !targetUserStackId) {
    throw new Error('CROSS_SWAP_STACK_ID_MISSING');
  }
  if (sourceUserStackId !== sourceHubStackId) {
    throw new Error(`CROSS_SWAP_SOURCE_JURISDICTION_MISMATCH: user=${sourceUserJ.name} hub=${sourceHubJ.name}`);
  }
  if (targetHubStackId !== targetUserStackId) {
    throw new Error(`CROSS_SWAP_TARGET_JURISDICTION_MISMATCH: hub=${targetHubJ.name} user=${targetUserJ.name}`);
  }
  if (sourceUserStackId === targetHubStackId) {
    throw new Error(`CROSS_SWAP_REQUIRES_DISTINCT_JURISDICTIONS: ${sourceUserJ.name}`);
  }
  const sourceUserState = findEntityStateForRuntime(env, params.sourceUserEntityId, sourceUserSignerId);
  const targetUserState = findEntityStateForRuntime(env, params.targetUserEntityId, targetUserSignerId);
  if (!hasRuntimeAccountWith(sourceUserState, params.sourceHubEntityId)) {
    throw new Error(`CROSS_SWAP_SOURCE_ACCOUNT_MISSING: user=${params.sourceUserEntityId} hub=${params.sourceHubEntityId}`);
  }
  if (!hasRuntimeAccountWith(targetUserState, params.targetHubEntityId)) {
    throw new Error(`CROSS_SWAP_TARGET_ACCOUNT_MISSING: user=${params.targetUserEntityId} hub=${params.targetHubEntityId}`);
  }

  const expiresInMs = Math.max(30_000, Math.floor(params.expiresInMs ?? 120_000));
  const sourceMarketKey = `${sourceUserStackId}:${Number(params.sourceTokenId)}`;
  const targetMarketKey = `${targetHubStackId}:${Number(params.targetTokenId)}`;
  const defaultBookHubEntityId = sourceMarketKey <= targetMarketKey
    ? params.sourceHubEntityId
    : params.targetHubEntityId;
  const bookHubEntityId = params.bookHubEntityId || defaultBookHubEntityId;

  const route: CrossJurisdictionSwapRoute = withCanonicalCrossJurisdictionRouteHash({
    orderId,
    bookOwnerEntityId: bookHubEntityId,
    makerEntityId: params.sourceUserEntityId,
    hubEntityId: bookHubEntityId,
    source: {
      jurisdiction: sourceUserStackId,
      entityId: params.sourceUserEntityId,
      counterpartyEntityId: params.sourceHubEntityId,
      tokenId: Number(params.sourceTokenId),
      amount: BigInt(params.sourceAmount),
    },
    target: {
      jurisdiction: targetHubStackId,
      entityId: params.targetHubEntityId,
      counterpartyEntityId: params.targetUserEntityId,
      tokenId: Number(params.targetTokenId),
      amount: BigInt(params.targetAmount),
    },
    ...(params.priceTicks !== undefined ? { priceTicks: params.priceTicks } : {}),
    ...(params.priceImprovementMode ? { priceImprovementMode: params.priceImprovementMode } : {}),
    status: 'intent',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + expiresInMs,
    ...(params.memo ? { memo: params.memo } : {}),
  });

  return {
    route,
    input: {
      runtimeTxs: [],
      entityInputs: [
        {
          entityId: params.sourceUserEntityId,
          signerId: sourceUserSignerId,
          entityTxs: [{
            type: 'requestCrossJurisdictionSwap',
            data: { route },
          }],
        },
      ],
      timestamp: now,
    },
  };
}

export async function submitDebtEnforcement(
  env: Env,
  entityId: string,
  tokenId: number,
  maxIterations: number | bigint = 100n,
  signerId?: string,
): Promise<void> {
  const jurisdiction = requireEntityRuntimeJurisdictionConfig(env, entityId, signerId);
  const jAdapter = getEntityJAdapter(env, entityId, signerId);
  if (!jAdapter) {
    throw new Error(`ENTITY_JADAPTER_UNAVAILABLE: ${jurisdiction.name}`);
  }
  await jAdapter.enforceDebts(entityId, tokenId, maxIterations);
}
