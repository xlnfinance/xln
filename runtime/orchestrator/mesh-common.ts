import type { AccountMachine, Delta, EntityTx, Env } from '../types';
import { deriveDelta, getTokenInfo } from '../account/utils';
import { encodeBoard, hashBoard } from '../entity/factory';
import { compareStableText } from '../protocol/serialization';
import { getBootstrapTokenAmount } from '../jurisdiction/bootstrap-economy';
import { getEntityReplicaById } from '../entity/replica-lookup';
import { assertEntityProposalAction } from '../entity/authorization';
import { normalizeSignedEntityCommand } from '../entity/command-codec';
import { getReliableOutputIdentity } from '../machine/output-routing';
export { getEntityReplicaById } from '../entity/replica-lookup';
export { DEFAULT_ACCOUNT_TOKEN_IDS } from '../account/default-tokens';
export {
  BOOTSTRAP_USD_NOTIONAL,
  BOOTSTRAP_WETH_USD_RATE,
  getBootstrapTokenAmount,
} from '../jurisdiction/bootstrap-economy';

export const HUB_MESH_TOKEN_ID = 1;
export const getBootstrapCreditAmount = (
  tokenId: number,
  decimals = getTokenInfo(tokenId).decimals,
): bigint => getBootstrapTokenAmount(tokenId, decimals);

export const HUB_MESH_CREDIT_AMOUNT = getBootstrapCreditAmount(HUB_MESH_TOKEN_ID);
export const DEFAULT_USER_HUB_CREDIT_AMOUNT = 10_000n * 10n ** BigInt(getTokenInfo(HUB_MESH_TOKEN_ID).decimals);
export const HUB_REQUIRED_TOKEN_COUNT = 3;
export const HUB_DEFAULT_SUPPORTED_PAIRS = ['1/2', '1/3', '2/3'] as const;
export const HUB_DEFAULT_MIN_TRADE_SIZE = 10n * 10n ** BigInt(getTokenInfo(HUB_MESH_TOKEN_ID).decimals);
export const BOOTSTRAP_POLL_MS = Math.max(10, Number(process.env['BOOTSTRAP_POLL_MS'] || '50'));
export const RUNTIME_SETTLE_POLL_MS = Math.max(5, Number(process.env['RUNTIME_SETTLE_POLL_MS'] || '10'));

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

export const hasPendingRuntimeWork = (env: Env): boolean => {
  if (env.runtimeState?.processingPromise) return true;
  if (env.pendingOutputs?.length) return true;
  if (env.pendingNetworkOutputs?.length) return true;
  if (env.networkInbox?.length) return true;
  const queuedInputs = [env.runtimeMempool, env.runtimeInput]
    .filter((input, index, all) => input && all.indexOf(input) === index);
  for (const input of queuedInputs) {
    if (input!.entityInputs?.length) return true;
    if (input!.runtimeTxs?.length) return true;
    if (input!.jInputs?.length) return true;
    if (input!.reliableReceipts?.length) return true;
  }

  if (env.jReplicas) {
    for (const replica of env.jReplicas.values()) {
      if ((replica.mempool?.length ?? 0) > 0) return true;
    }
  }

  return false;
};

export type RuntimeQuiescenceHealth = {
  pendingReliableOutputs: number;
  pendingAccountFrames: number;
  accountMempoolTxs: number;
};

/** Read-only bootstrap evidence; it never participates in consensus state. */
export const summarizeRuntimeQuiescence = (env: Env): RuntimeQuiescenceHealth => {
  let pendingAccountFrames = 0;
  let accountMempoolTxs = 0;
  for (const replica of env.eReplicas.values()) {
    for (const account of replica.state.accounts.values()) {
      if (account.pendingFrame) pendingAccountFrames += 1;
      accountMempoolTxs += account.mempool?.length ?? 0;
    }
  }
  return {
    pendingReliableOutputs: (env.pendingNetworkOutputs ?? [])
      .filter(output => getReliableOutputIdentity(output) !== null).length,
    pendingAccountFrames,
    accountMempoolTxs,
  };
};

export const settleRuntimeFor = async (env: Env, rounds = 30): Promise<void> => {
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

const accountMatchesCounterparty = (
  account: AccountMachine | null | undefined,
  ownerEntityId: string,
  counterpartyId: string,
): boolean => {
  const needle = String(counterpartyId || '').toLowerCase();
  if (!needle) return false;

  const counterpartyEntityId =
    account && typeof account === 'object' && 'counterpartyEntityId' in account
      ? account.counterpartyEntityId
      : undefined;
  const cp = typeof counterpartyEntityId === 'string' ? counterpartyEntityId.toLowerCase() : '';
  if (cp === needle) return true;

  const me = String(ownerEntityId || '').toLowerCase();
  const left = typeof account?.leftEntity === 'string' ? account.leftEntity.toLowerCase() : '';
  const right = typeof account?.rightEntity === 'string' ? account.rightEntity.toLowerCase() : '';

  if (left && right) {
    if (left === me && right === needle) return true;
    if (right === me && left === needle) return true;
  }

  return false;
};

export const hasAccount = (env: Env, entityId: string, counterpartyId: string): boolean => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.accounts) return false;
  const needle = String(counterpartyId || '').toLowerCase();
  for (const [key, account] of replica.state.accounts.entries()) {
    if (typeof key === 'string' && key.toLowerCase() === needle) return true;
    if (accountMatchesCounterparty(account, entityId, counterpartyId)) return true;
  }
  return false;
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
  env: Env,
  entityId: string,
  counterpartyId: string,
): boolean => {
  const target = String(counterpartyId || '').toLowerCase();
  return semanticQueuedEntityTxsFor(env, entityId).some((tx) =>
    tx.type === 'openAccount' &&
    String(tx.data.targetEntityId || '').toLowerCase() === target,
  );
};

const queuedEntityTxsFor = (env: Env, targetEntityId: string): EntityTx[] => {
  const normalizedEntityId = String(targetEntityId || '').toLowerCase();
  const queues = [env.runtimeMempool?.entityInputs, env.runtimeInput?.entityInputs]
    .filter((queue, index, all) => Array.isArray(queue) && all.indexOf(queue) === index);
  const txs: EntityTx[] = [];
  for (const queue of queues) {
    for (const input of queue || []) {
      if (String(input.entityId || '').toLowerCase() !== normalizedEntityId) continue;
      txs.push(...(input.entityTxs || []));
    }
  }
  return txs;
};

const semanticQueuedEntityTxsFor = (env: Env, entityId: string): EntityTx[] => {
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
  env: Env,
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
  env: Env,
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
  env: Env,
  entityId: string,
  counterpartyId: string,
  offerId: string,
): boolean => collectQueuedSwapOfferIds(env, entityId, counterpartyId).has(String(offerId || '').trim());

export const getAccountMachine = (
  env: Env,
  entityId: string,
  counterpartyId: string,
): AccountMachine | null => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.accounts) return null;
  const needle = String(counterpartyId || '').toLowerCase();
  for (const [key, account] of replica.state.accounts.entries()) {
    if (typeof key === 'string' && key.toLowerCase() === needle) return account ?? null;
    if (accountMatchesCounterparty(account, entityId, counterpartyId)) return account ?? null;
  }
  return null;
};

export const getAccountDelta = (
  env: Env,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
): Delta | null => {
  const account = getAccountMachine(env, entityId, counterpartyId);
  if (!account?.deltas) return null;
  return account.deltas.get(tokenId) ?? null;
};

export const getCreditGrantedByEntity = (
  account: AccountMachine,
  ownerEntityId: string,
  tokenId: number,
): bigint => {
  const delta = account.deltas.get(tokenId);
  if (!delta) return 0n;
  const owner = String(ownerEntityId || '').toLowerCase();
  const left = String(account.leftEntity || '').toLowerCase();
  const isOwnerLeft = owner.length > 0 && owner === left;
  return BigInt(isOwnerLeft ? (delta.rightCreditLimit ?? 0n) : (delta.leftCreditLimit ?? 0n));
};

export const getEntityOutCapacity = (
  account: AccountMachine | null,
  ownerEntityId: string,
  tokenId: number,
): bigint => {
  if (!account) return 0n;
  const delta = account.deltas.get(tokenId);
  if (!delta) return 0n;
  return deriveDelta(delta, account.leftEntity === ownerEntityId).outCapacity;
};

/** A committed Account remains usable even while its peer is offline. */
export const hasCommittedAccountState = (
  account: AccountMachine | null,
): account is AccountMachine => {
  if (!account) return false;
  if (account.status !== 'active') return false;
  if (!account.currentFrame) return false;
  if (Number(account.currentHeight ?? 0) <= 0) return false;
  return true;
};

/** Mutation producers use this stricter predicate to avoid overlapping writes. */
export const isAccountWriteLaneIdle = (account: AccountMachine | null): boolean => {
  if (!hasCommittedAccountState(account)) return false;
  if (account.pendingFrame) return false;
  if ((account.mempool?.length ?? 0) > 0) return false;
  return true;
};

/** @deprecated Prefer the explicit committed-state or write-lane predicate. */
export const isAccountConsensusReady = isAccountWriteLaneIdle;

export const hasPairMutualCredit = (
  env: Env,
  leftEntityId: string,
  rightEntityId: string,
  tokenId: number,
  amount: bigint,
): boolean => {
  const account =
    getAccountMachine(env, leftEntityId, rightEntityId)
    ?? getAccountMachine(env, rightEntityId, leftEntityId);
  if (!hasCommittedAccountState(account)) return false;
  const grantedByLeft = getCreditGrantedByEntity(account, leftEntityId, tokenId);
  const grantedByRight = getCreditGrantedByEntity(account, rightEntityId, tokenId);
  return grantedByLeft >= amount && grantedByRight >= amount;
};

export const hasPairMutualCredits = (
  env: Env,
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

export const serializeReserves = (reserves: ReadonlyMap<string | number, bigint>): Record<string, string> => {
  const entries = Array.from(reserves.entries())
    .map(([tokenId, amount]) => [String(tokenId), amount.toString()] as const)
    .sort(([left], [right]) => {
      const leftNum = Number(left);
      const rightNum = Number(right);
      if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) {
        return leftNum - rightNum;
      }
      return compareStableText(left, right);
    });
  return Object.fromEntries(entries);
};
