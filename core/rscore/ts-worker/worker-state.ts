import type { AccountConsensusContext } from '../../account/consensus/context';
import { computeEntityAccountValueHash } from '../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../entity/state/persistent-account-map';
import { verifyHankoForHash } from '../../hanko/signing';
import { hashAccountJClaimNode } from '../../account/j-claims/j-claim-accumulator';
import type { AccountReplica } from '../../types/account';
import type {
  AccountJClaimNode,
  AccountJClaimNodeStore,
} from '../../types/finance/account-j-claims';
import type { JReplica } from '../../types/jurisdiction-runtime';
import {
  assertStorageAccountDocBinding,
  validateStorageAccountDocValue,
} from '../../storage/schema/schema-state-docs';
import {
  hydrateAccountDocFromStorage,
  projectPortableAccountDoc,
} from '../../storage/read/projections';
import {
  normalizeTsWorkerAccountId,
  TS_ACCOUNT_LOGICAL_SHARDS,
  tsAccountLogicalShard,
  tsAccountLogicalShardPath,
} from './sharding';
import type {
  TsAccountWorkerInitPayload,
  TsAccountWorkerInitResult,
  TsAccountWorkerPostAccount,
  TsAccountWorkerSubroot,
} from './protocol';

export type TsAccountWorkerState = {
  readonly workerIndex: number;
  readonly ownedShardIds: ReadonlySet<number>;
  readonly ownerEntityId: string;
  accounts: PersistentEntityAccountMap;
  readonly populatedShardIds: ReadonlySet<number>;
  readonly jReplicas: Map<string, JReplica>;
  readonly jClaimNodes: Map<string, AccountJClaimNode>;
  readonly settlementBoardAuthorities: Map<string, string>;
  readonly frameTouchedAccountIds: Set<string>;
  candidateBaseAccounts: PersistentEntityAccountMap | null;
  inboundPrepared: boolean;
};

export const workerHeapUsedBytes = (): number => process.memoryUsage().heapUsed;

export const requireWorkerAccount = (
  worker: TsAccountWorkerState,
  accountIdInput: string,
): string => {
  const accountId = normalizeTsWorkerAccountId(accountIdInput);
  const shardId = tsAccountLogicalShard(accountId);
  if (!worker.ownedShardIds.has(shardId)) {
    throw new Error(`TS_ACCOUNT_WORKER_OWNERSHIP_MISMATCH:${worker.workerIndex}:${accountId}`);
  }
  if (!worker.accounts.has(accountId)) throw new Error(`TS_ACCOUNT_WORKER_ACCOUNT_MISSING:${accountId}`);
  return accountId;
};

export const requireWorkerOwnedAccountId = (
  worker: TsAccountWorkerState,
  accountIdInput: string,
): string => {
  const accountId = normalizeTsWorkerAccountId(accountIdInput);
  const shardId = tsAccountLogicalShard(accountId);
  if (!worker.ownedShardIds.has(shardId)) {
    throw new Error(`TS_ACCOUNT_WORKER_OWNERSHIP_MISMATCH:${worker.workerIndex}:${accountId}`);
  }
  return accountId;
};

export const hydrateWorkerGenesisAccount = (
  worker: TsAccountWorkerState,
  accountId: string,
  portable: Record<string, unknown>,
): AccountReplica => hydrateAccountDocFromStorage(assertStorageAccountDocBinding(
  validateStorageAccountDocValue(portable),
  worker.ownerEntityId,
  accountId,
  'ts-account-worker-genesis',
));

export const computeWorkerShardCommitment = (
  worker: TsAccountWorkerState,
  shardId: number,
): TsAccountWorkerSubroot => ({
  shardId,
  node: worker.accounts.nodeCommitmentAtPath(tsAccountLogicalShardPath(shardId)),
});

const populatedSubroots = (worker: TsAccountWorkerState): TsAccountWorkerSubroot[] =>
  [...worker.populatedShardIds]
    .sort((left, right) => left - right)
    .map(shardId => computeWorkerShardCommitment(worker, shardId));

export const initializeWorkerState = (
  input: TsAccountWorkerInitPayload,
): Readonly<{ state: TsAccountWorkerState; result: TsAccountWorkerInitResult }> => {
  const ownedShardIds = new Set<number>();
  for (const shardId of input.ownedShardIds) {
    if (
      !Number.isSafeInteger(shardId)
      || shardId < 0
      || shardId >= TS_ACCOUNT_LOGICAL_SHARDS
      || ownedShardIds.has(shardId)
    ) throw new Error(`TS_ACCOUNT_WORKER_INIT_OWNED_SHARD:${input.workerIndex}:${shardId}`);
    ownedShardIds.add(shardId);
  }
  if (ownedShardIds.size === 0) {
    throw new Error(`TS_ACCOUNT_WORKER_INIT_OWNED_SHARDS_EMPTY:${input.workerIndex}`);
  }
  const accountEntries: Array<readonly [string, AccountReplica]> = [];
  const populatedShardIds = new Set<number>();
  const seenAccountIds = new Set<string>();
  for (const [accountId, portable] of input.accounts) {
    const shardId = tsAccountLogicalShard(accountId);
    if (!ownedShardIds.has(shardId)) {
      throw new Error(`TS_ACCOUNT_WORKER_INIT_OWNERSHIP:${input.workerIndex}:${accountId}`);
    }
    if (seenAccountIds.has(accountId)) throw new Error(`TS_ACCOUNT_WORKER_INIT_DUPLICATE:${accountId}`);
    const validated = assertStorageAccountDocBinding(
      validateStorageAccountDocValue(portable),
      input.ownerEntityId,
      accountId,
      'ts-account-worker-init',
    );
    const account = hydrateAccountDocFromStorage(validated);
    seenAccountIds.add(accountId);
    accountEntries.push([accountId, account]);
    populatedShardIds.add(shardId);
  }
  const jClaimNodes = new Map(input.jClaimNodes);
  for (const [hash, node] of jClaimNodes) {
    const actual = hashAccountJClaimNode(node);
    if (actual !== hash) throw new Error(`TS_ACCOUNT_WORKER_INIT_JCLAIM_CORRUPT:${hash}:${actual}`);
  }
  const state: TsAccountWorkerState = {
    workerIndex: input.workerIndex,
    ownedShardIds,
    ownerEntityId: input.ownerEntityId,
    accounts: PersistentEntityAccountMap.fromEntries(
      accountEntries,
      input.ownerEntityId,
      computeEntityAccountValueHash,
    ),
    populatedShardIds,
    jReplicas: new Map(input.jReplicas),
    jClaimNodes,
    settlementBoardAuthorities: new Map(
      input.settlementBoardAuthorities.map(([entityId, boardHash]) => [entityId.toLowerCase(), boardHash]),
    ),
    frameTouchedAccountIds: new Set(),
    candidateBaseAccounts: null,
    inboundPrepared: false,
  };
  return {
    state,
    result: {
      workerIndex: state.workerIndex,
      accountCount: state.accounts.size,
      subroots: populatedSubroots(state),
      heapUsedBytes: workerHeapUsedBytes(),
    },
  };
};

export const prepareWorkerAttempt = (
  worker: TsAccountWorkerState,
  restorePrevious: boolean,
): void => {
  if (restorePrevious) {
    if (worker.candidateBaseAccounts === null) {
      throw new Error(`TS_ACCOUNT_WORKER_RESTORE_BASE_MISSING:${worker.workerIndex}`);
    }
    worker.accounts = worker.candidateBaseAccounts;
  } else {
    worker.candidateBaseAccounts = worker.accounts;
  }
  worker.frameTouchedAccountIds.clear();
};

export const createWorkerConsensusContext = (
  worker: TsAccountWorkerState,
  timestamp: number,
  finalizedJHeight: number,
  jClaimNodeStore: AccountJClaimNodeStore,
): AccountConsensusContext => ({
  runtimeTimestamp: timestamp,
  accountAuthorityFrameId: null,
  entityClock: { timestamp, finalizedJHeight },
  quietLogs: true,
  emitRuntimeEvents: false,
  jReplicas: worker.jReplicas,
  jClaimNodeStore,
  verifyHanko: async (hanko, hash, expectedEntityId, authority) => {
    // Rotated boards require the exact parent Entity-certified registry view.
    // Until that compact view has a canonical interface, halt instead of
    // silently turning a valid peer frame into a worker-only rejection.
    if (authority?.registeredBoardHash) {
      throw new Error('TS_ACCOUNT_WORKER_CERTIFIED_BOARD_CONTEXT_REQUIRED');
    }
    return verifyHankoForHash(hanko, hash, expectedEntityId, undefined, authority);
  },
  resolveSettlementBoardAuthority: async (sourceEntityId, certifiedBoardHash) =>
    certifiedBoardHash ?? worker.settlementBoardAuthorities.get(sourceEntityId.toLowerCase()),
});

export const collectWorkerPostAccounts = (
  worker: TsAccountWorkerState,
): readonly TsAccountWorkerPostAccount[] => {
  const accounts = [...worker.frameTouchedAccountIds].sort().map(accountId => {
    const account = worker.accounts.get(accountId);
    if (!account) throw new Error(`TS_ACCOUNT_WORKER_POST_ACCOUNT_MISSING:${accountId}`);
    const entityAccountLeaf = worker.accounts.valueHashAt(accountId);
    if (entityAccountLeaf === undefined) {
      throw new Error(`TS_ACCOUNT_WORKER_POST_ACCOUNT_LEAF_MISSING:${accountId}`);
    }
    return { accountId, account: projectPortableAccountDoc(account), entityAccountLeaf };
  });
  worker.frameTouchedAccountIds.clear();
  return accounts;
};
