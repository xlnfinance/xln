import { computeCanonicalEntityConsensusStateHash } from '../entity/consensus/state-root';
import { isLeftEntity } from '../entity/id';
import { createStructuredLogger } from '../infra/logger';
import type { EntityState, Env } from '../types';

const solvencyLog = createStructuredLogger('runtime.solvency');

export type AssetSolvency = {
  stackId: string;
  chainId: number;
  depositoryAddress: string;
  tokenId: number;
  reserves: bigint;
  confirmedCollateral: bigint;
  pendingCollateral: bigint;
  delta: bigint;
  isValid: boolean;
};

export interface Solvency {
  byAsset: Map<string, AssetSolvency>;
  entityCount: number;
  accountViews: number;
  isValid: boolean;
}

const canonicalStack = (state: EntityState): Omit<AssetSolvency, 'tokenId' | 'reserves' | 'confirmedCollateral' | 'pendingCollateral' | 'delta' | 'isValid'> => {
  const jurisdiction = state.config?.jurisdiction;
  const chainId = Number(jurisdiction?.chainId);
  const depositoryAddress = String(jurisdiction?.depositoryAddress || '').trim().toLowerCase();
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !/^0x[0-9a-f]{40}$/.test(depositoryAddress)) {
    throw new Error(`SOLVENCY_STACK_IDENTITY_INVALID:${state.entityId}`);
  }
  return { stackId: `${chainId}:${depositoryAddress}`, chainId, depositoryAddress };
};

const canonicalTokenId = (value: unknown): number => {
  const tokenId = Number(value);
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
    throw new Error(`SOLVENCY_TOKEN_ID_INVALID:${String(value)}`);
  }
  return tokenId;
};

const canonicalAmount = (value: unknown, context: string): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new Error(`${context} must be a bigint-compatible amount`);
};

const selectCanonicalStates = (env: Env): EntityState[] => {
  const selected = new Map<string, { signerId: string; state: EntityState }>();
  for (const replica of env.eReplicas.values()) {
    const entityId = String(replica.state?.entityId || '').trim().toLowerCase();
    const height = Number(replica.state?.height);
    if (!entityId || !Number.isSafeInteger(height) || height < 0) {
      throw new Error(`SOLVENCY_ENTITY_STATE_INVALID:${entityId || 'missing'}:${String(height)}`);
    }
    const current = selected.get(entityId);
    if (!current || height > current.state.height) {
      selected.set(entityId, { signerId: String(replica.signerId || ''), state: replica.state });
      continue;
    }
    if (height !== current.state.height) continue;
    const currentHash = computeCanonicalEntityConsensusStateHash(current.state);
    const candidateHash = computeCanonicalEntityConsensusStateHash(replica.state);
    if (currentHash !== candidateHash) {
      throw new Error(`SOLVENCY_ENTITY_REPLICA_DIVERGENCE:${entityId}:${height}:${currentHash}:${candidateHash}`);
    }
    if (String(replica.signerId || '') < current.signerId) {
      selected.set(entityId, { signerId: String(replica.signerId || ''), state: replica.state });
    }
  }
  return Array.from(selected.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value.state);
};

const ensureAsset = (
  byAsset: Map<string, AssetSolvency>,
  state: EntityState,
  rawTokenId: unknown,
): AssetSolvency => {
  const stack = canonicalStack(state);
  const tokenId = canonicalTokenId(rawTokenId);
  const key = `${stack.stackId}:${tokenId}`;
  const existing = byAsset.get(key);
  if (existing) return existing;
  const created: AssetSolvency = {
    ...stack, tokenId, reserves: 0n, confirmedCollateral: 0n,
    pendingCollateral: 0n, delta: 0n, isValid: true,
  };
  byAsset.set(key, created);
  return created;
};

export const calculateSolvency = (env: Env, snapshot?: Env): Solvency => {
  const states = selectCanonicalStates(snapshot || env);
  const byAsset = new Map<string, AssetSolvency>();
  let accountViews = 0;
  for (const state of states) {
    for (const [tokenId, amount] of state.reserves) {
      ensureAsset(byAsset, state, tokenId).reserves += canonicalAmount(amount, `reserves.${tokenId}`);
    }
    accountViews += state.accounts.size;
    for (const [counterpartyId, account] of state.accounts) {
      if (!isLeftEntity(state.entityId, counterpartyId)) continue;
      for (const [tokenId, delta] of account.deltas) {
        ensureAsset(byAsset, state, tokenId).confirmedCollateral += canonicalAmount(
          delta.collateral,
          `collateral.${tokenId}`,
        );
      }
      for (const delta of account.pendingFrame?.deltas ?? []) {
        ensureAsset(byAsset, state, delta.tokenId).pendingCollateral += canonicalAmount(
          delta.collateral,
          `pendingCollateral.${delta.tokenId}`,
        );
      }
    }
  }
  for (const asset of byAsset.values()) {
    asset.delta = asset.reserves - asset.confirmedCollateral;
    asset.isValid = asset.delta === 0n;
  }
  return { byAsset, entityCount: states.length, accountViews, isValid: byAsset.size > 0 && Array.from(byAsset.values()).every(asset => asset.isValid) };
};

export const verifySolvency = (env: Env, label?: string): boolean => {
  const solvency = calculateSolvency(env);
  const invalid = Array.from(solvency.byAsset.values()).filter(asset => !asset.isValid);
  if (!solvency.isValid) {
    solvencyLog.error('violation', {
      label: label ?? '',
      assets: invalid.map(asset => ({ key: `${asset.stackId}:${asset.tokenId}`, delta: asset.delta.toString() })),
    });
    throw new Error(`Solvency check failed: ${invalid.map(asset => `${asset.stackId}:${asset.tokenId}=${asset.delta}`).join(',') || 'no assets'}`);
  }
  solvencyLog.info('ok', { label: label ?? '', assets: solvency.byAsset.size });
  return true;
};
