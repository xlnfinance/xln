import { computeCanonicalEntityConsensusStateHash } from '../../entity/consensus/state-root';
import { isLeftEntity } from '../../protocol/identity/entity-id';
import { createStructuredLogger } from '../../infra/logger';
import type { EntityState } from '../../entity/types';
import type { RuntimeReplica } from '../types';

const solvencyLog = createStructuredLogger('runtime.solvency');

/**
 * Off-chain mirror of the quantity the jurisdiction constrains.
 *
 * The on-chain law is `reserves + collateral == minted + externalBacking` per
 * token, enforced by Depository.invariants `invariant_valueConservation`.
 * `internalValue` is the left-hand side, which a Runtime can compute from its
 * own committed state alone.
 *
 * The right-hand side is not knowable off-chain: minted supply and external
 * escrow live in the Depository. A caller that has read those totals supplies
 * them as `expectedInternalValue`, and only then is `isValid` meaningful -
 * `null` means "not checked", never "checked and fine".
 */
type AssetSolvency = {
  stackId: string;
  chainId: number;
  depositoryAddress: string;
  tokenId: number;
  reserves: bigint;
  confirmedCollateral: bigint;
  pendingCollateral: bigint;
  internalValue: bigint;
  expectedInternalValue: bigint | null;
  delta: bigint | null;
  isValid: boolean | null;
};

export interface Solvency {
  byAsset: Map<string, AssetSolvency>;
  entityCount: number;
  accountViews: number;
  /** null until every asset has an authoritative on-chain total. */
  isValid: boolean | null;
}

/** Authoritative per-token totals read from the Depository, keyed `stackId:tokenId`. */
export type OnChainTokenTotals = ReadonlyMap<string, bigint>;

const canonicalStack = (
  state: EntityState,
): Pick<AssetSolvency, 'stackId' | 'chainId' | 'depositoryAddress'> => {
  const jurisdiction = state.config?.jurisdiction;
  const chainId = Number(jurisdiction?.chainId);
  const depositoryAddress = String(jurisdiction?.depositoryAddress || '')
    .trim()
    .toLowerCase();
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

const selectCanonicalStates = (env: RuntimeReplica): EntityState[] => {
  const selected = new Map<string, { signerId: string; state: EntityState }>();
  for (const replica of env.state.eReplicas.values()) {
    const entityId = String(replica.state?.entityId || '')
      .trim()
      .toLowerCase();
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
  return Array.from(selected.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value.state);
};

const ensureAsset = (byAsset: Map<string, AssetSolvency>, state: EntityState, rawTokenId: unknown): AssetSolvency => {
  const stack = canonicalStack(state);
  const tokenId = canonicalTokenId(rawTokenId);
  const key = `${stack.stackId}:${tokenId}`;
  const existing = byAsset.get(key);
  if (existing) return existing;
  const created: AssetSolvency = {
    ...stack,
    tokenId,
    reserves: 0n,
    confirmedCollateral: 0n,
    pendingCollateral: 0n,
    internalValue: 0n,
    expectedInternalValue: null,
    delta: null,
    isValid: null,
  };
  byAsset.set(key, created);
  return created;
};

export const calculateSolvency = (
  env: RuntimeReplica,
  snapshot?: RuntimeReplica,
  onChainTotals?: OnChainTokenTotals,
): Solvency => {
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
      for (const [tokenId, delta] of account.state.deltas) {
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
  let checked = 0;
  for (const asset of byAsset.values()) {
    asset.internalValue = asset.reserves + asset.confirmedCollateral;
    const expected = onChainTotals?.get(`${asset.stackId}:${asset.tokenId}`);
    if (expected === undefined) continue;
    asset.expectedInternalValue = expected;
    asset.delta = asset.internalValue - expected;
    asset.isValid = asset.delta === 0n;
    checked += 1;
  }
  return {
    byAsset,
    entityCount: states.length,
    accountViews,
    isValid: Array.from(byAsset.values()).some(asset => asset.isValid === false)
      ? false
      : checked > 0 && checked === byAsset.size
        ? true
        : null,
  };
};

/**
 * Assert the conservation law against authoritative on-chain totals.
 *
 * Diagnostic only: nothing in the canonical tick calls this, and it must stay
 * that way. Recomputing a whole-Runtime aggregate per frame would spend real
 * work to restate what the jurisdiction already enforces on every batch.
 *
 * Without `onChainTotals` there is nothing to verify, and this throws rather
 * than returning a green it did not earn.
 */
export const verifySolvency = (
  env: RuntimeReplica,
  label?: string,
  onChainTotals?: OnChainTokenTotals,
): boolean => {
  const solvency = calculateSolvency(env, undefined, onChainTotals);
  const unchecked = Array.from(solvency.byAsset.entries())
    .filter(([, asset]) => asset.isValid === null)
    .map(([key]) => key);
  if (solvency.isValid === null) {
    const reason = unchecked.length === solvency.byAsset.size
      ? `no on-chain totals supplied for ${solvency.byAsset.size} asset(s)`
      : `incomplete on-chain totals; missing ${unchecked.join(',')}`;
    throw new Error(
      `Solvency check failed: ${reason}`,
    );
  }
  const invalid = Array.from(solvency.byAsset.values()).filter(asset => asset.isValid === false);
  if (!solvency.isValid) {
    solvencyLog.error('violation', {
      label: label ?? '',
      assets: invalid.map(asset => ({ key: `${asset.stackId}:${asset.tokenId}`, delta: String(asset.delta) })),
    });
    throw new Error(
      `Solvency check failed: ${invalid.map(asset => `${asset.stackId}:${asset.tokenId}=${String(asset.delta)}`).join(',') || 'no assets'}`,
    );
  }
  solvencyLog.info('ok', { label: label ?? '', assets: solvency.byAsset.size });
  return true;
};
