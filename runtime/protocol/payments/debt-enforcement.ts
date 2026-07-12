import type { RuntimeInput } from '../../types';

export type DebtEnforcementProjectionRuntimeInputParams = {
  entityId: string;
  jurisdictionName: string;
  tokenId: number;
  maxIterations?: number | bigint;
  signerId?: string;
  timestamp: number;
};

const normalizeEntityId = (entityId: string): string => String(entityId || '').trim().toLowerCase();

const normalizeTokenId = (tokenId: number): number => {
  const normalized = Number(tokenId);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`DEBT_ENFORCEMENT_TOKEN_INVALID:${tokenId}`);
  }
  return normalized;
};

const normalizeIterations = (maxIterations: number | bigint | undefined): bigint => {
  const normalized = BigInt(maxIterations ?? 100n);
  if (normalized <= 0n) {
    throw new Error(`DEBT_ENFORCEMENT_ITERATIONS_INVALID:${normalized}`);
  }
  return normalized;
};

const normalizeTimestamp = (timestamp: number): number => {
  const normalized = Math.floor(Number(timestamp));
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`DEBT_ENFORCEMENT_TIMESTAMP_INVALID:${timestamp}`);
  }
  return normalized;
};

export function buildDebtEnforcementRuntimeInputFromProjection(
  params: DebtEnforcementProjectionRuntimeInputParams,
): RuntimeInput {
  const entityId = normalizeEntityId(params.entityId);
  if (!entityId) throw new Error('DEBT_ENFORCEMENT_ENTITY_REQUIRED');
  const jurisdictionName = String(params.jurisdictionName || '').trim();
  if (!jurisdictionName) throw new Error(`ENTITY_JURISDICTION_MISSING: entity=${entityId}`);
  const tokenId = normalizeTokenId(params.tokenId);
  const maxIterations = normalizeIterations(params.maxIterations);
  const signerId = params.signerId ? String(params.signerId).trim().toLowerCase() : undefined;
  const timestamp = normalizeTimestamp(params.timestamp);

  return {
    runtimeTxs: [],
    entityInputs: [],
    jInputs: [{
      jurisdictionName,
      jTxs: [{
        type: 'debtEnforcement',
        entityId,
        data: {
          tokenId,
          maxIterations,
          ...(signerId ? { signerId } : {}),
        },
        timestamp,
      }],
    }],
    timestamp,
  };
}
