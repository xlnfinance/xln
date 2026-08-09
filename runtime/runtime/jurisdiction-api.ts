import type { JAdapter } from '../jurisdiction/adapter/types';
import { withCanonicalCrossJurisdictionRouteHash } from '../extensions/cross-j/index';
import { getJurisdictionStackId, requireEntityRuntimeJurisdictionConfig } from '../jurisdiction/machine/jurisdiction-runtime';
import { resolveEntityDefaultProposerId } from './entity-output-signer';
import type { AccountState } from '../types/account';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { EntityState } from '../entity/types';
import type { RuntimeReplica, RuntimeInput } from './types';
import { getWallClockMs } from '../infra/time';
import { buildDebtEnforcementRuntimeInputFromProjection } from './debt-enforcement-input';
import type { DebtEnforcementProjectionRuntimeInputParams } from './debt-enforcement-input';
import { deriveCanonicalCrossJurisdictionBookOwnerForLegs } from '../extensions/cross-j/market';
import { getLiveJAdapter } from './live-jadapters';

export function getActiveJAdapter(env: RuntimeReplica): JAdapter | null {
  if (!env.activeJurisdiction) return null;
  return getLiveJAdapter(env, env.activeJurisdiction) ?? null;
}

export function getEntityJAdapter(env: RuntimeReplica, entityId: string, signerId?: string): JAdapter | null {
  const jurisdiction = requireEntityRuntimeJurisdictionConfig(env, entityId, signerId);
  return getLiveJAdapter(env, jurisdiction.name) ?? null;
}

export type CrossJurisdictionSwapSubmitParams = {
  /** Caller-owned idempotency key. Retries must reuse the same identifier. */
  orderId: string;
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

export type DebtEnforcementRuntimeInputParams = {
  entityId: string;
  tokenId: number;
  maxIterations?: number | bigint;
  signerId?: string;
};

export { buildDebtEnforcementRuntimeInputFromProjection };
export type { DebtEnforcementProjectionRuntimeInputParams };

const normalizeRuntimeEntityId = (entityId: string): string => String(entityId || '').toLowerCase();

export const requireCrossJurisdictionOrderId = (value: string): string => {
  const orderId = String(value).trim();
  if (!orderId) throw new Error('CROSS_SWAP_ORDER_ID_REQUIRED');
  if (orderId.includes('\0')) throw new Error('CROSS_SWAP_ORDER_ID_INVALID');
  if (new TextEncoder().encode(orderId).byteLength > 256) {
    throw new Error('CROSS_SWAP_ORDER_ID_TOO_LARGE');
  }
  return orderId;
};

const findEntityStateForRuntime = (env: RuntimeReplica, entityId: string, signerId?: string): EntityState | null => {
  const target = normalizeRuntimeEntityId(entityId);
  const signer = signerId ? String(signerId).toLowerCase() : null;
  for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
    const [keyEntity, keySigner] = String(replicaKey).split(':');
    const replicaEntity = normalizeRuntimeEntityId(replica.entityId || keyEntity || '');
    const replicaSigner = String(replica.signerId || keySigner || '').toLowerCase();
    if (replicaEntity !== target && normalizeRuntimeEntityId(keyEntity || '') !== target) continue;
    if (signer && replicaSigner !== signer && String(keySigner || '').toLowerCase() !== signer) continue;
    return replica.state;
  }
  return null;
};

const findRuntimeAccountWith = (state: EntityState | null, counterpartyId: string): AccountState | null => {
  const counterparty = normalizeRuntimeEntityId(counterpartyId);
  if (!state || !counterparty) return null;
  for (const [accountId, account] of state.accounts.entries()) {
    if (normalizeRuntimeEntityId(accountId) === counterparty) return account.state;
    if (normalizeRuntimeEntityId(account.state.leftEntity) === counterparty) return account.state;
    if (normalizeRuntimeEntityId(account.state.rightEntity) === counterparty) return account.state;
  }
  return null;
};

const resolveCrossJurisdictionSwapContext = (
  env: RuntimeReplica,
  params: CrossJurisdictionSwapSubmitParams,
) => {
  const now = env.scenarioMode ? env.state.timestamp : getWallClockMs();
  const canonicalSigner = (entityId: string, requested: string | undefined, role: string): string => {
    const expected = resolveEntityDefaultProposerId(env, entityId, `cross-swap.${role}`);
    if (requested && normalizeRuntimeEntityId(requested) !== expected) {
      throw new Error(`CROSS_SWAP_OWNER_SIGNER_NON_CANONICAL:${role}:${requested}:${expected}`);
    }
    return expected;
  };
  const sourceUserSignerId = canonicalSigner(
    params.sourceUserEntityId, params.sourceUserSignerId, 'source-user');
  const sourceHubSignerId = canonicalSigner(
    params.sourceHubEntityId, params.sourceHubSignerId, 'source-hub');
  const targetHubSignerId = canonicalSigner(
    params.targetHubEntityId, params.targetHubSignerId, 'target-hub');
  const targetUserSignerId = canonicalSigner(
    params.targetUserEntityId, params.targetUserSignerId, 'target-user');
  const sourceJurisdiction = requireEntityRuntimeJurisdictionConfig(
    env,
    params.sourceUserEntityId,
    sourceUserSignerId,
  );
  const targetJurisdiction = requireEntityRuntimeJurisdictionConfig(
    env,
    params.targetUserEntityId,
    targetUserSignerId,
  );
  const sourceAccount = findRuntimeAccountWith(
    findEntityStateForRuntime(env, params.sourceUserEntityId, sourceUserSignerId),
    params.sourceHubEntityId,
  );
  const targetAccount = findRuntimeAccountWith(
    findEntityStateForRuntime(env, params.targetUserEntityId, targetUserSignerId),
    params.targetHubEntityId,
  );
  if (!sourceAccount) {
    throw new Error(
      `CROSS_SWAP_SOURCE_ACCOUNT_MISSING: user=${params.sourceUserEntityId} hub=${params.sourceHubEntityId}`,
    );
  }
  if (!targetAccount) {
    throw new Error(
      `CROSS_SWAP_TARGET_ACCOUNT_MISSING: user=${params.targetUserEntityId} hub=${params.targetHubEntityId}`,
    );
  }
  const sourceStackId = getJurisdictionStackId(sourceJurisdiction);
  const targetStackId = getJurisdictionStackId(targetJurisdiction);
  if (!sourceStackId || !targetStackId) throw new Error('CROSS_SWAP_STACK_ID_MISSING');
  if (sourceStackId === targetStackId) {
    throw new Error(`CROSS_SWAP_REQUIRES_DISTINCT_JURISDICTIONS: ${sourceJurisdiction.name}`);
  }
  if (getJurisdictionStackId(sourceAccount.domain) !== sourceStackId) {
    throw new Error(
      `CROSS_SWAP_SOURCE_ACCOUNT_DOMAIN_MISMATCH:${params.sourceUserEntityId}:${params.sourceHubEntityId}`,
    );
  }
  if (getJurisdictionStackId(targetAccount.domain) !== targetStackId) {
    throw new Error(
      `CROSS_SWAP_TARGET_ACCOUNT_DOMAIN_MISMATCH:${params.targetUserEntityId}:${params.targetHubEntityId}`,
    );
  }
  return {
    now,
    // Runtime never invents a financial identity. The caller owns this
    // idempotency key so an uncertain delivery can be retried safely.
    orderId: requireCrossJurisdictionOrderId(params.orderId),
    sourceUserSignerId,
    sourceHubSignerId,
    targetHubSignerId,
    targetUserSignerId,
    sourceJurisdiction,
    targetJurisdiction,
    sourceStackId,
    targetStackId,
    sourceDisputeConfig: { ...sourceAccount.disputeConfig },
    targetDisputeConfig: { ...targetAccount.disputeConfig },
  };
};

const resolveCrossJurisdictionBook = (
  params: CrossJurisdictionSwapSubmitParams,
  context: ReturnType<typeof resolveCrossJurisdictionSwapContext>,
): { entityId: string; signerId: string } => {
  const entityId = deriveCanonicalCrossJurisdictionBookOwnerForLegs(
    context.sourceStackId,
    params.sourceHubEntityId,
    context.targetStackId,
    params.targetHubEntityId,
  );
  if (
    params.bookHubEntityId &&
    normalizeRuntimeEntityId(params.bookHubEntityId) !== normalizeRuntimeEntityId(entityId)
  ) {
    throw new Error(`CROSS_SWAP_BOOK_OWNER_NON_CANONICAL:${params.bookHubEntityId}:${entityId}`);
  }
  const signerId =
    normalizeRuntimeEntityId(entityId) === normalizeRuntimeEntityId(params.sourceHubEntityId)
      ? context.sourceHubSignerId
      : normalizeRuntimeEntityId(entityId) === normalizeRuntimeEntityId(params.targetHubEntityId)
        ? context.targetHubSignerId
        : '';
  if (
    params.bookHubSignerId &&
    normalizeRuntimeEntityId(params.bookHubSignerId) !== normalizeRuntimeEntityId(signerId)
  ) {
    throw new Error(`CROSS_SWAP_BOOK_SIGNER_NON_CANONICAL:${params.bookHubSignerId}:${signerId}`);
  }
  return { entityId, signerId };
};

export function buildCrossJurisdictionSwapSubmission(
  env: RuntimeReplica,
  params: CrossJurisdictionSwapSubmitParams,
): CrossJurisdictionSwapSubmitResult {
  const context = resolveCrossJurisdictionSwapContext(env, params);
  const book = resolveCrossJurisdictionBook(params, context);
  const expiresInMs = Math.max(30_000, Math.floor(params.expiresInMs ?? 120_000));
  const route: CrossJurisdictionSwapRoute = withCanonicalCrossJurisdictionRouteHash({
    orderId: context.orderId,
    bookOwnerEntityId: book.entityId,
    makerEntityId: params.sourceUserEntityId,
    hubEntityId: book.entityId,
    sourceSignerId: context.sourceUserSignerId,
    sourceHubSignerId: context.sourceHubSignerId,
    targetHubSignerId: context.targetHubSignerId,
    targetSignerId: context.targetUserSignerId,
    ...(book.signerId ? { bookHubSignerId: book.signerId } : {}),
    source: {
      jurisdiction: context.sourceStackId,
      entityId: params.sourceUserEntityId,
      counterpartyEntityId: params.sourceHubEntityId,
      tokenId: Number(params.sourceTokenId),
      amount: BigInt(params.sourceAmount),
    },
    sourceDisputeConfig: context.sourceDisputeConfig,
    target: {
      jurisdiction: context.targetStackId,
      entityId: params.targetHubEntityId,
      counterpartyEntityId: params.targetUserEntityId,
      tokenId: Number(params.targetTokenId),
      amount: BigInt(params.targetAmount),
    },
    targetDisputeConfig: context.targetDisputeConfig,
    domain: {
      protocol: 'xln-cross-j',
      hashSchema: 'route-domain',
      sourceStackId: context.sourceStackId,
      targetStackId: context.targetStackId,
      sourceEntityProviderAddress: context.sourceJurisdiction.entityProviderAddress.toLowerCase(),
      targetEntityProviderAddress: context.targetJurisdiction.entityProviderAddress.toLowerCase(),
      sourceAssetRef: `${context.sourceStackId}:${Number(params.sourceTokenId)}`,
      targetAssetRef: `${context.targetStackId}:${Number(params.targetTokenId)}`,
    },
    ...(params.settlementPolicy ? { settlementPolicy: params.settlementPolicy } : {}),
    riskMode: params.riskMode || 'fully_collateralized',
    ...(params.priceTicks !== undefined ? { priceTicks: params.priceTicks } : {}),
    ...(params.priceImprovementMode ? { priceImprovementMode: params.priceImprovementMode } : {}),
    status: 'intent',
    createdAt: context.now,
    updatedAt: context.now,
    expiresAt: context.now + expiresInMs,
    ...(params.memo ? { memo: params.memo } : {}),
  });

  return {
    route,
  };
}

export function buildDebtEnforcementRuntimeInput(
  env: RuntimeReplica,
  params: DebtEnforcementRuntimeInputParams,
): RuntimeInput {
  const entityId = String(params.entityId || '').trim().toLowerCase();
  if (!entityId) throw new Error('DEBT_ENFORCEMENT_ENTITY_REQUIRED');
  const signerId = params.signerId ? String(params.signerId).trim().toLowerCase() : undefined;
  const jurisdiction = requireEntityRuntimeJurisdictionConfig(env, entityId, signerId);
  const now = env.scenarioMode ? env.state.timestamp : getWallClockMs();

  return buildDebtEnforcementRuntimeInputFromProjection({
    entityId,
    jurisdictionName: jurisdiction.name,
    tokenId: params.tokenId,
    ...(params.maxIterations === undefined ? {} : { maxIterations: params.maxIterations }),
    ...(signerId ? { signerId } : {}),
    timestamp: now,
  });
}
