import type { AccountReplica, Delta } from '../../types/account';
import type { EntityTx } from '../../types/entity-tx';
import type { RuntimeReplica } from '../../runtime/types';
import { buildDefaultEntitySwapPairs, deriveDelta, getTokenInfo } from '../../account/utils';
import { encodeBoard, hashBoard } from '../../entity/factory';
import { getBootstrapTokenAmount } from '../../jurisdiction/machine/config/bootstrap-economy';
import { getEntityReplicaById } from '../../entity/replica/replica-lookup';
import { findAccountByCounterparty } from '../../account/state/account-lookup';
import { assertEntityProposalAction } from '../../entity/auth/authorization';
import { normalizeSignedEntityCommand } from '../../entity/command/command-codec';
import { getReliableOutputIdentity } from '../../runtime/routing/output-routing';
export { getEntityReplicaById } from '../../entity/replica/replica-lookup';
export { DEFAULT_ACCOUNT_TOKEN_IDS } from '../../account/config/defaults';
export {
  getBootstrapTokenAmount,
} from '../../jurisdiction/machine/config/bootstrap-economy';

export const HUB_MESH_TOKEN_ID = 1;
export const getBootstrapCreditAmount = (
  tokenId: number,
  decimals = getTokenInfo(tokenId).decimals,
): bigint => getBootstrapTokenAmount(tokenId, decimals);

export const HUB_MESH_CREDIT_AMOUNT = getBootstrapCreditAmount(HUB_MESH_TOKEN_ID);
export const HUB_REQUIRED_TOKEN_COUNT = 3;
export const HUB_DEFAULT_SUPPORTED_PAIRS = ['1/2', '1/3', '2/3'] as const;
export const HUB_DEFAULT_MIN_TRADE_SIZE = 10n * 10n ** BigInt(getTokenInfo(HUB_MESH_TOKEN_ID).decimals);

export type MarketMakerIdentityLabelPlan = Readonly<{
  samePairIndex: number;
  signerLabel: string;
  profileName: string;
}>;

/** Hub allowlists and the MM process must derive the exact same pair shards. */
export const planMarketMakerIdentityLabels = (
  signerLabel: string,
  profileName: string,
  tokenIds: readonly number[],
): readonly MarketMakerIdentityLabelPlan[] =>
  buildDefaultEntitySwapPairs(tokenIds).map((_pair, samePairIndex) => Object.freeze({
    samePairIndex,
    signerLabel: samePairIndex === 0 ? signerLabel : `${signerLabel}:pair:${samePairIndex + 1}`,
    profileName: samePairIndex === 0 ? profileName : `${profileName} Pair ${samePairIndex + 1}`,
  }));
export const BOOTSTRAP_POLL_MS = Math.max(10, Number(process.env['BOOTSTRAP_POLL_MS'] || '50'));
const RUNTIME_SETTLE_POLL_MS = Math.max(5, Number(process.env['RUNTIME_SETTLE_POLL_MS'] || '10'));

export const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

export const isCanonicalAccountOpener = (entityId: string, counterpartyId: string): boolean => {
  const left = String(entityId || '').toLowerCase();
  const right = String(counterpartyId || '').toLowerCase();
  return Boolean(left && right && left < right);
};

export type MarketMakerEntityJurisdictionConfig = {
  name: string;
  address: string;
  entityProviderAddress: string;
  depositoryAddress: string;
  chainId: number;
  blockTimeMs: number;
};

export const buildMarketMakerConsensusConfig = (
  signerId: string,
  jurisdiction: MarketMakerEntityJurisdictionConfig,
) => {
  const normalizedSignerId = String(signerId || '').trim().toLowerCase();
  if (!normalizedSignerId) throw new Error('MARKET_MAKER_SIGNER_ID_MISSING');
  return {
    mode: 'proposer-based' as const,
    threshold: 1n,
    validators: [normalizedSignerId],
    shares: { [normalizedSignerId]: 1n },
    jurisdiction,
  };
};

export const deriveMarketMakerEntityId = (
  signerId: string,
  jurisdiction: MarketMakerEntityJurisdictionConfig,
): string => hashBoard(encodeBoard(buildMarketMakerConsensusConfig(signerId, jurisdiction))).toLowerCase();

export const hasPendingRuntimeWork = (env: RuntimeReplica): boolean => {
  if (env.infrastructure?.processingPromise) return true;
  if (env.pendingOutputs?.length) return true;
  if (env.pendingNetworkOutputs?.length) return true;
  if (env.networkInbox?.length) return true;
  const mempool = env.runtimeMempool;
  if (mempool.entityInputs.length) return true;
  if (mempool.runtimeTxs.length) return true;
  if (mempool.jInputs?.length) return true;
  if (mempool.reliableReceipts?.length) return true;

  if (env.state.jReplicas) {
    for (const replica of env.state.jReplicas.values()) {
      if ((replica.mempool?.length ?? 0) > 0) return true;
    }
  }

  return false;
};

export type RuntimeQuiescenceHealth = {
  pendingRuntimeWork: number;
  pendingReliableOutputs: number;
  pendingAccountFrames: number;
  accountMempoolTxs: number;
};

/** Read-only bootstrap evidence; it never participates in consensus state. */
export const summarizeRuntimeQuiescence = (env: RuntimeReplica): RuntimeQuiescenceHealth => {
  let pendingAccountFrames = 0;
  let accountMempoolTxs = 0;
  for (const replica of env.state.eReplicas.values()) {
    for (const account of replica.state.accounts.values()) {
      if (account.pendingFrame) pendingAccountFrames += 1;
      accountMempoolTxs += account.mempool?.length ?? 0;
    }
  }
  return {
    pendingRuntimeWork: hasPendingRuntimeWork(env) ? 1 : 0,
    pendingReliableOutputs: (env.pendingNetworkOutputs ?? [])
      .filter(output => getReliableOutputIdentity(output) !== null).length,
    pendingAccountFrames,
    accountMempoolTxs,
  };
};

export const settleRuntimeFor = async (env: RuntimeReplica, rounds = 30): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    if (!hasPendingRuntimeWork(env)) break;
    await sleep(RUNTIME_SETTLE_POLL_MS);
  }
};

export const waitUntil = async (
  predicate: () => boolean | Promise<boolean>,
  maxAttempts = 120,
  stepMs = BOOTSTRAP_POLL_MS,
): Promise<boolean> => {
  for (let i = 0; i < maxAttempts; i += 1) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
};

export const hasAccount = (env: RuntimeReplica, entityId: string, counterpartyId: string): boolean => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.accounts) return false;
  return findAccountByCounterparty(replica.state.accounts, entityId, counterpartyId) !== null;
};

const expandQueuedEntityTxs = (txs: readonly EntityTx[] | undefined): EntityTx[] => {
  if (!Array.isArray(txs)) return [];
  const expanded: EntityTx[] = [];
  // Bootstrap dedup must inspect semantic work after local authorization wraps
  // it as EntityCommand -> proposal -> entity_transaction. Looking only at the
  // outer frame lets the next bootstrap poll enqueue the same financial action
  // again. Parse only these two canonical wrappers; never crawl arbitrary data.
  const appendProposal = (tx: EntityTx): void => {
    expanded.push(tx);
    if (tx.type !== 'propose') return;
    const action = assertEntityProposalAction(tx.data.action);
    if (action.type === 'entity_transaction') expanded.push(...action.data.txs);
  };
  for (const tx of txs) {
    if (tx.type !== 'entityCommand') {
      appendProposal(tx);
      continue;
    }
    expanded.push(tx);
    const command = normalizeSignedEntityCommand(tx.data);
    for (const nested of command.txs) appendProposal(nested);
  }
  return expanded;
};

export const hasQueuedOpenAccount = (
  env: RuntimeReplica,
  entityId: string,
  counterpartyId: string,
): boolean => {
  const target = String(counterpartyId || '').toLowerCase();
  return semanticQueuedEntityTxsFor(env, entityId).some((tx) =>
    tx.type === 'openAccount' &&
    String(tx.data.targetEntityId || '').toLowerCase() === target,
  );
};

const queuedEntityTxsFor = (env: RuntimeReplica, targetEntityId: string): EntityTx[] => {
  const normalizedEntityId = String(targetEntityId || '').toLowerCase();
  const txs: EntityTx[] = [];
  for (const input of env.runtimeMempool.entityInputs) {
    if (String(input.entityId || '').toLowerCase() !== normalizedEntityId) continue;
    txs.push(...(input.entityTxs || []));
  }
  return txs;
};

const semanticQueuedEntityTxsFor = (env: RuntimeReplica, entityId: string): EntityTx[] => {
  const replica = getEntityReplicaById(env, entityId);
  return [
    queuedEntityTxsFor(env, entityId),
    replica?.mempool,
    replica?.proposal?.txs,
    replica?.lockedFrame?.txs,
  ].flatMap(expandQueuedEntityTxs);
};

const parseQueuedAmount = (value: unknown): bigint | null => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
};

export const hasQueuedExtendCredit = (
  env: RuntimeReplica,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  minAmount: bigint = 0n,
): boolean => {
  const target = String(counterpartyId || '').toLowerCase();
  const expectedTokenId = Number(tokenId);
  return semanticQueuedEntityTxsFor(env, entityId).some((tx) => {
    if (tx.type !== 'extendCredit') return false;
    const data = tx.data as {
      counterpartyEntityId?: string;
      tokenId?: number;
      amount?: unknown;
    };
    if (String(data.counterpartyEntityId || '').toLowerCase() !== target) return false;
    if (Number(data.tokenId) !== expectedTokenId) return false;
    if (minAmount <= 0n) return true;
    const amount = parseQueuedAmount(data.amount);
    return amount !== null && amount >= minAmount;
  });
};

export const collectQueuedSwapOfferIds = (
  env: RuntimeReplica,
  entityId: string,
  counterpartyId: string,
): Set<string> => {
  const target = String(counterpartyId || '').toLowerCase();
  const ids = new Set<string>();
  for (const tx of semanticQueuedEntityTxsFor(env, entityId)) {
    if (tx.type !== 'placeSwapOffer') continue;
    const data = tx.data as {
      counterpartyEntityId?: string;
      offerId?: string;
    };
    if (String(data.counterpartyEntityId || '').toLowerCase() !== target) continue;
    const offerId = String(data.offerId || '').trim();
    if (offerId) ids.add(offerId);
  }
  return ids;
};

export const hasQueuedSwapOffer = (
  env: RuntimeReplica,
  entityId: string,
  counterpartyId: string,
  offerId: string,
): boolean => collectQueuedSwapOfferIds(env, entityId, counterpartyId).has(String(offerId || '').trim());

export const getAccountReplica = (
  env: RuntimeReplica,
  entityId: string,
  counterpartyId: string,
): AccountReplica | null => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.accounts) return null;
  return findAccountByCounterparty(replica.state.accounts, entityId, counterpartyId);
};

export const serializeAccountDelta = (delta: Delta | null | undefined): Record<string, string> | null =>
  delta
    ? {
        collateral: String(delta.collateral ?? 0n),
        ondelta: String(delta.ondelta ?? 0n),
        offdelta: String(delta.offdelta ?? 0n),
        leftCreditLimit: String(delta.leftCreditLimit ?? 0n),
        rightCreditLimit: String(delta.rightCreditLimit ?? 0n),
        leftHold: String(delta.leftHold),
        rightHold: String(delta.rightHold),
      }
    : null;

/**
 * Credit `ownerEntityId` granted to their counterparty.
 * Canonical only via deriveDelta: left writes rightCreditLimit, right writes
 * leftCreditLimit; from the granter's perspective that is peerCreditLimit.
 */
export const getCreditGrantedByEntity = (
  account: AccountReplica,
  ownerEntityId: string,
  tokenId: number,
): bigint => {
  const delta = account.state.deltas.get(tokenId);
  if (!delta) return 0n;
  const owner = String(ownerEntityId || '').toLowerCase();
  const left = String(account.state.leftEntity || '').toLowerCase();
  if (!owner || (owner !== left && owner !== String(account.state.rightEntity || '').toLowerCase())) {
    throw new Error(`CREDIT_GRANTER_NOT_ACCOUNT_PARTY:${ownerEntityId.slice(-8)}`);
  }
  return deriveDelta(delta, owner === left).peerCreditLimit;
};

export const getEntityOutCapacity = (
  account: AccountReplica | null,
  ownerEntityId: string,
  tokenId: number,
): bigint => {
  if (!account) return 0n;
  const delta = account.state.deltas.get(tokenId);
  if (!delta) return 0n;
  return deriveDelta(delta, account.state.leftEntity === ownerEntityId).outCapacity;
};

/** A committed Account remains usable even while its peer is offline. */
export const hasCommittedAccountState = (
  account: AccountReplica | null,
): account is AccountReplica => {
  if (!account) return false;
  if (account.status !== 'active') return false;
  if (!account.currentFrame) return false;
  if (Number(account.currentHeight ?? 0) <= 0) return false;
  return true;
};

/** Mutation producers use this stricter predicate to avoid overlapping writes. */
export const isAccountWriteLaneIdle = (account: AccountReplica | null): boolean => {
  if (!hasCommittedAccountState(account)) return false;
  if (account.pendingFrame) return false;
  if ((account.mempool?.length ?? 0) > 0) return false;
  return true;
};

export const hasPairMutualCredit = (
  env: RuntimeReplica,
  leftEntityId: string,
  rightEntityId: string,
  tokenId: number,
  amount: bigint,
): boolean => {
  const account =
    getAccountReplica(env, leftEntityId, rightEntityId)
    ?? getAccountReplica(env, rightEntityId, leftEntityId);
  if (!hasCommittedAccountState(account)) return false;
  const grantedByLeft = getCreditGrantedByEntity(account, leftEntityId, tokenId);
  const grantedByRight = getCreditGrantedByEntity(account, rightEntityId, tokenId);
  return grantedByLeft >= amount && grantedByRight >= amount;
};

export const hasPairMutualCredits = (
  env: RuntimeReplica,
  leftEntityId: string,
  rightEntityId: string,
  tokenIds: readonly number[],
  amount: bigint | ((tokenId: number) => bigint),
): boolean => tokenIds.every((tokenId) => hasPairMutualCredit(
  env,
  leftEntityId,
  rightEntityId,
  tokenId,
  typeof amount === 'function' ? amount(tokenId) : amount,
));
