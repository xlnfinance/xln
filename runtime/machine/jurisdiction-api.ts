import { ethers } from 'ethers';

import type { JAdapter } from '../jadapter';
import { withCanonicalCrossJurisdictionRouteHash } from '../extensions/cross-j/index';
import { getJurisdictionStackId, requireEntityRuntimeJurisdictionConfig } from '../jurisdiction/jurisdiction-runtime';
import { resolveEntityProposerId } from '../state-helpers';
import type { AccountMachine, CrossJurisdictionSwapRoute, EntityState, Env, RuntimeInput } from '../types';
import { getWallClockMs } from '../utils';
import { buildDebtEnforcementRuntimeInputFromProjection } from '../protocol/payments/debt-enforcement';
import type { DebtEnforcementProjectionRuntimeInputParams } from '../protocol/payments/debt-enforcement';
import { deriveCanonicalCrossJurisdictionBookOwnerForLegs } from '../extensions/cross-j/market';

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
  riskMode?: CrossJurisdictionSwapRoute['riskMode'];
  settlementPolicy?: CrossJurisdictionSwapRoute['settlementPolicy'];
  memo?: string;
};

export type CrossJurisdictionSwapSubmitResult = {
  route: CrossJurisdictionSwapRoute;
};

export type CrossJurisdictionSwapSubmission = CrossJurisdictionSwapSubmitResult & {
  input: RuntimeInput;
};

export type DebtEnforcementRuntimeInputParams = {
  entityId: string;
  tokenId: number;
  maxIterations?: number | bigint;
  signerId?: string;
};

export { buildDebtEnforcementRuntimeInputFromProjection };
export type { DebtEnforcementProjectionRuntimeInputParams };

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

const findRuntimeAccountWith = (state: EntityState | null, counterpartyId: string): AccountMachine | null => {
  const counterparty = normalizeRuntimeEntityId(counterpartyId);
  if (!state || !counterparty) return null;
  for (const [accountId, account] of state.accounts.entries()) {
    if (normalizeRuntimeEntityId(accountId) === counterparty) return account;
    if (normalizeRuntimeEntityId(account.leftEntity) === counterparty) return account;
    if (normalizeRuntimeEntityId(account.rightEntity) === counterparty) return account;
  }
  return null;
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
  const targetUserJ = requireEntityRuntimeJurisdictionConfig(env, params.targetUserEntityId, targetUserSignerId);
  const sourceUserState = findEntityStateForRuntime(env, params.sourceUserEntityId, sourceUserSignerId);
  const targetUserState = findEntityStateForRuntime(env, params.targetUserEntityId, targetUserSignerId);
  const sourceAccount = findRuntimeAccountWith(sourceUserState, params.sourceHubEntityId);
  const targetAccount = findRuntimeAccountWith(targetUserState, params.targetHubEntityId);
  if (!sourceAccount) {
    throw new Error(`CROSS_SWAP_SOURCE_ACCOUNT_MISSING: user=${params.sourceUserEntityId} hub=${params.sourceHubEntityId}`);
  }
  if (!targetAccount) {
    throw new Error(`CROSS_SWAP_TARGET_ACCOUNT_MISSING: user=${params.targetUserEntityId} hub=${params.targetHubEntityId}`);
  }
  const sourceHubJ = sourceUserJ;
  const targetHubJ = targetUserJ;
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
  if (getJurisdictionStackId(sourceAccount.domain) !== sourceUserStackId) {
    throw new Error(`CROSS_SWAP_SOURCE_ACCOUNT_DOMAIN_MISMATCH:${params.sourceUserEntityId}:${params.sourceHubEntityId}`);
  }
  if (getJurisdictionStackId(targetAccount.domain) !== targetUserStackId) {
    throw new Error(`CROSS_SWAP_TARGET_ACCOUNT_DOMAIN_MISMATCH:${params.targetUserEntityId}:${params.targetHubEntityId}`);
  }

  const expiresInMs = Math.max(30_000, Math.floor(params.expiresInMs ?? 120_000));
  const canonicalBookHubEntityId = deriveCanonicalCrossJurisdictionBookOwnerForLegs(
    sourceUserStackId,
    Number(params.sourceTokenId),
    params.sourceHubEntityId,
    targetHubStackId,
    Number(params.targetTokenId),
    params.targetHubEntityId,
  );
  if (
    params.bookHubEntityId &&
    normalizeRuntimeEntityId(params.bookHubEntityId) !== normalizeRuntimeEntityId(canonicalBookHubEntityId)
  ) {
    throw new Error(`CROSS_SWAP_BOOK_OWNER_NON_CANONICAL:${params.bookHubEntityId}:${canonicalBookHubEntityId}`);
  }
  const bookHubEntityId = canonicalBookHubEntityId;
  const canonicalBookHubSignerId = (
    normalizeRuntimeEntityId(bookHubEntityId) === normalizeRuntimeEntityId(params.sourceHubEntityId) ? sourceHubSignerId :
    normalizeRuntimeEntityId(bookHubEntityId) === normalizeRuntimeEntityId(params.targetHubEntityId) ? targetHubSignerId :
    ''
  );
  if (
    params.bookHubSignerId &&
    normalizeRuntimeEntityId(params.bookHubSignerId) !== normalizeRuntimeEntityId(canonicalBookHubSignerId)
  ) {
    throw new Error(`CROSS_SWAP_BOOK_SIGNER_NON_CANONICAL:${params.bookHubSignerId}:${canonicalBookHubSignerId}`);
  }
  const bookHubSignerId = canonicalBookHubSignerId;

  const route: CrossJurisdictionSwapRoute = withCanonicalCrossJurisdictionRouteHash({
    orderId,
    bookOwnerEntityId: bookHubEntityId,
    makerEntityId: params.sourceUserEntityId,
    hubEntityId: bookHubEntityId,
    sourceSignerId: sourceUserSignerId,
    sourceHubSignerId,
    targetHubSignerId,
    targetSignerId: targetUserSignerId,
    ...(bookHubSignerId ? { bookHubSignerId } : {}),
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
    domain: {
      protocol: 'xln-cross-j',
      hashSchema: 'route-domain',
      sourceStackId: sourceUserStackId,
      targetStackId: targetHubStackId,
      sourceEntityProviderAddress: sourceUserJ.entityProviderAddress.toLowerCase(),
      targetEntityProviderAddress: targetHubJ.entityProviderAddress.toLowerCase(),
      sourceAssetRef: `${sourceUserStackId}:${Number(params.sourceTokenId)}`,
      targetAssetRef: `${targetHubStackId}:${Number(params.targetTokenId)}`,
    },
    ...(params.settlementPolicy ? { settlementPolicy: params.settlementPolicy } : {}),
    riskMode: params.riskMode || 'fully_collateralized',
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

export function buildDebtEnforcementRuntimeInput(
  env: Env,
  params: DebtEnforcementRuntimeInputParams,
): RuntimeInput {
  const entityId = String(params.entityId || '').trim().toLowerCase();
  if (!entityId) throw new Error('DEBT_ENFORCEMENT_ENTITY_REQUIRED');
  const signerId = params.signerId ? String(params.signerId).trim().toLowerCase() : undefined;
  const jurisdiction = requireEntityRuntimeJurisdictionConfig(env, entityId, signerId);
  const now = env.scenarioMode ? env.timestamp : getWallClockMs();

  return buildDebtEnforcementRuntimeInputFromProjection({
    entityId,
    jurisdictionName: jurisdiction.name,
    tokenId: params.tokenId,
    ...(params.maxIterations === undefined ? {} : { maxIterations: params.maxIterations }),
    ...(signerId ? { signerId } : {}),
    timestamp: now,
  });
}
