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
import { attachHankoWitnessesToState } from '../../entity/consensus/input/hanko-witness';
import {
  commitEntityAccountCandidate,
  createEntityAccountCandidateMap,
} from '../../entity/state/candidate-map';
import type {
  TsAccountWorkerInstallHankosPayload,
  TsAccountWorkerInstallHankosResult,
  TsAccountWorkerInitPayload,
  TsAccountWorkerInitResult,
  TsAccountWorkerCertifiedBoard,
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

export const workerHeapUsedBytes = (): number => {
  const runtimeProcess = Reflect.get(globalThis, 'process') as
    | { memoryUsage?: () => { heapUsed: number } }
    | undefined;
  const heapUsed = runtimeProcess?.memoryUsage?.().heapUsed;
  return typeof heapUsed === 'number' && Number.isFinite(heapUsed) ? heapUsed : 0;
};

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
  certifiedBoards: ReadonlyMap<string, TsAccountWorkerCertifiedBoard> = new Map(),
): AccountConsensusContext => ({
  runtimeTimestamp: timestamp,
  accountAuthorityFrameId: null,
  entityClock: { timestamp, finalizedJHeight },
  quietLogs: true,
  jReplicas: worker.jReplicas,
  jClaimNodeStore,
  verifyHanko: async (hanko, hash, expectedEntityId, authority) => {
    const certifiedBoardRecord = certifiedBoards.get(expectedEntityId.toLowerCase());
    if (authority?.registeredBoardHash && !certifiedBoardRecord) {
      throw new Error(`TS_ACCOUNT_WORKER_CERTIFIED_BOARD_CONTEXT_REQUIRED:${expectedEntityId}`);
    }
    return verifyHankoForHash(hanko, hash, expectedEntityId, undefined, {
      ...authority,
      ...(certifiedBoardRecord ? { certifiedBoardRecord, observerTimestamp: timestamp } : {}),
    });
  },
  resolveSettlementBoardAuthority: async (sourceEntityId, certifiedBoardHash) =>
    certifiedBoardHash ?? worker.settlementBoardAuthorities.get(sourceEntityId.toLowerCase()),
});

export const projectWorkerPostAccounts = (
  worker: TsAccountWorkerState,
): readonly TsAccountWorkerPostAccount[] => {
  return [...worker.frameTouchedAccountIds].sort().map(accountId => {
    const account = worker.accounts.get(accountId);
    if (!account) throw new Error(`TS_ACCOUNT_WORKER_POST_ACCOUNT_MISSING:${accountId}`);
    const entityAccountLeaf = worker.accounts.valueHashAt(accountId);
    if (entityAccountLeaf === undefined) {
      throw new Error(`TS_ACCOUNT_WORKER_POST_ACCOUNT_LEAF_MISSING:${accountId}`);
    }
    return { accountId, account: projectPortableAccountDoc(account), entityAccountLeaf };
  });
};

export const collectWorkerPostAccounts = (
  worker: TsAccountWorkerState,
): readonly TsAccountWorkerPostAccount[] => {
  const accounts = projectWorkerPostAccounts(worker);
  worker.frameTouchedAccountIds.clear();
  return accounts;
};

export const installWorkerCommittedHankos = (
  worker: TsAccountWorkerState,
  input: TsAccountWorkerInstallHankosPayload,
): TsAccountWorkerInstallHankosResult => {
  if (!Number.isSafeInteger(input.entityHeight) || input.entityHeight < 1) {
    throw new Error(`TS_ACCOUNT_WORKER_HANKO_HEIGHT_INVALID:${input.entityHeight}`);
  }
  const accountIds: string[] = [];
  const seenAccounts = new Set<string>();
  const witnesses = new Map<string, import('../../entity/consensus/input/hanko-witness').HankoWitnessEntry>();
  for (const row of input.rows) {
    const accountId = requireWorkerAccount(worker, row.accountId);
    if (seenAccounts.has(accountId)) {
      throw new Error(`TS_ACCOUNT_WORKER_HANKO_ACCOUNT_DUPLICATE:${accountId}`);
    }
    seenAccounts.add(accountId);
    accountIds.push(accountId);
    for (const witness of row.hankos) {
      if (
        witness.entityHeight !== input.entityHeight
        || witness.hash.length === 0
        || witness.hanko.length === 0
        || !Number.isSafeInteger(witness.createdAt)
        || witness.createdAt < 0
      ) {
        throw new Error(`TS_ACCOUNT_WORKER_HANKO_INVALID:${accountId}:${witness.hash}`);
      }
      const existing = witnesses.get(witness.hash);
      if (existing && (
        existing.hanko !== witness.hanko
        || existing.type !== witness.type
        || existing.entityHeight !== witness.entityHeight
        || existing.createdAt !== witness.createdAt
      )) {
        throw new Error(`TS_ACCOUNT_WORKER_HANKO_CONFLICT:${witness.hash}`);
      }
      witnesses.set(witness.hash, {
        hanko: witness.hanko,
        type: witness.type,
        entityHeight: witness.entityHeight,
        createdAt: witness.createdAt,
      });
    }
  }
  const beforeRoot = worker.accounts.rootHash();
  const candidateAccounts = createEntityAccountCandidateMap(worker.accounts);
  const attached = attachHankoWitnessesToState(
    { entityId: worker.ownerEntityId, accounts: candidateAccounts },
    witnesses,
    input.entityHeight,
    accountIds,
  );
  worker.accounts = commitEntityAccountCandidate(candidateAccounts);
  const accountsRoot = worker.accounts.rootHash();
  if (accountsRoot !== beforeRoot) {
    throw new Error(`TS_ACCOUNT_WORKER_HANKO_ROOT_CHANGED:${beforeRoot}:${accountsRoot}`);
  }
  return { workerIndex: worker.workerIndex, accounts: accountIds.length, attached, accountsRoot };
};
