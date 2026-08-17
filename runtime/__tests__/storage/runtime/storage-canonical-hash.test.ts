import { expect, test } from 'bun:test';

import {
  canonicalizeStorageAuditValue,
  computeCanonicalEntityHash,
  computeCanonicalStateHashFromEnv,
} from '../../../storage/canonical-hash';
import {
  computeRuntimePostStateComponentDigests,
  computeStorageFrameHash,
  computeStoragePostStateHash,
} from '../../../storage/hashes';
import { encodeBuffer } from '../../../storage/codec/codec';
import { buildStorageLiveReplicaMetaCommitment } from '../../../storage/replica/replicas';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { encodeBoard, hashBoard } from '../../../entity/factory';
import { applyCommand, createBook, replaceOrderbookPair } from '../../../orderbook';
import { encodeReplicaMeta, hydrateEntityStateFromStorage, projectAccountDoc, projectEntityCoreDoc, projectReplicaMeta } from '../../../storage/read/projections';
import {
  commitEntityFrameCandidateState,
  createEntityFrameCandidateState,
} from '../../../entity/state-clone';
import type { RuntimeFrame } from '../../../storage/types';
import type { AccountReplica } from '../../../types/account';
import type { EntityReplica } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import {
  projectReplayVerifiableRuntimePostStateView,
  buildReplayVerifiableRuntimeMachineSnapshot,
  projectReplayVerifiableRuntimeMachine,
} from '../../../storage/wal/snapshot';
import { makeAccount as makeBaseAccount } from '../.././helpers/cross-j';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { prepareRuntimeMachineGraphRows } from '../../../storage/wal/runtime-machine-graph';

const signerIds = [`0x${'11'.repeat(20)}`, `0x${'12'.repeat(20)}`];
const consensusConfig = {
  mode: 'proposer-based' as const,
  threshold: 2n,
  validators: signerIds,
  shares: Object.fromEntries(signerIds.map(signerId => [signerId, 1n])),
};
const entityId = hashBoard(encodeBoard(consensusConfig)).toLowerCase();
const counterpartyId = `0x${'ff'.repeat(32)}`;

const makeAccount = (frameStateHash: string): AccountReplica => {
  const account = makeBaseAccount(entityId, counterpartyId, {
    chainId: 31_337,
    depositoryAddress: `0x${'de'.repeat(20)}`,
  });
  account.state.watchSeed = `0x${'ac'.repeat(32)}`;
  const delta = account.state.deltas.get(1)!;
  account.state.deltas = account.state.deltas.updated(1, { ...delta, offdelta: 10n });
  account.currentHeight = 1;
  account.currentFrame = {
    height: 1,
    timestamp: 100,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: 'genesis',
    accountStateRoot: `0x${'00'.repeat(32)}`,
    stateHash: `0x${'01'.repeat(32)}`,
    deltas: [],
    byLeft: entityId < counterpartyId,
  };
  (account as AccountReplica & { frameHistory: unknown[] }).frameHistory = [{
      height: 1,
      timestamp: 100,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: 'genesis',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      stateHash: frameStateHash,
      deltas: [],
      byLeft: entityId < counterpartyId,
    }];
  return account;
};

const makeEnv = (account: AccountReplica, reserves: Array<[number, bigint]>): RuntimeReplica =>
  ({
    state: {
      height: 7,
      timestamp: 1234,
      jReplicas: new Map(),
      eReplicas: new Map<string, EntityReplica>([
      [`${entityId}:${signerIds[0]}`, {
        entityId,
        signerId: signerIds[0]!,
        mempool: [],
        isProposer: true,
        state: {
          entityId,
          entityEncryptionPublicKey: `0x${'44'.repeat(32)}`,
          height: 0,
          timestamp: 1234,
          nonces: new Map([['1', 1]]),
          proposals: new Map(),
          config: consensusConfig,
          reserves: new Map(reserves),
          accounts: PersistentEntityAccountMap.fromMap(
            new Map([[counterpartyId, account]]),
            entityId,
            computeEntityAccountValueHash,
          ),
          deferredAccountProposals: new Map(),
          lastFinalizedJHeight: 0,
          profile: { name: 'canonical-test', isHub: false, avatar: '', bio: '', website: '' },
          htlcRoutes: new Map(),
          htlcFeesEarned: 0n,
          lockBook: new Map(),
          swapTradingPairs: [],
        },
        } as EntityReplica],
      ]),
    },
  }) as RuntimeReplica;

const sharedOrderId = 'account:offer-1';

const createBookWithSharedOrder = () => {
  const book = createBook({ bucketWidthTicks: 1n, maxOrders: 10, stpPolicy: 0 });
  return applyCommand(book, {
    kind: 0,
    ownerId: 'account',
    orderId: sharedOrderId,
    side: 0,
    tif: 0,
    postOnly: true,
    priceTicks: 100n,
    qtyLots: 1n,
  }).state;
};

const makeEnvWithOrderbookPairs = (pairIds: string[]): RuntimeReplica => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const orderbookExt = {
    books: new Map(),
    orderPairs: new Map(),
    pairDimensions: new Map(),
    referrals: new Map(),
    hubProfile: {},
  };
  for (const pairId of pairIds) {
    replaceOrderbookPair(orderbookExt as never, pairId, createBookWithSharedOrder());
  }
  replica.state.orderbookExt = orderbookExt as never;
  return env;
};

test('canonical storage hash is deterministic across Map insertion order', () => {
  const left = computeCanonicalStateHashFromEnv(makeEnv(makeAccount('history-a'), [[2, 20n], [1, 10n]]));
  const right = computeCanonicalStateHashFromEnv(makeEnv(makeAccount('history-a'), [[1, 10n], [2, 20n]]));
  expect(left).toBe(right);
});

test('canonical storage audit values reject ambiguous or lossy JavaScript values', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  for (const [label, value] of [
    ['undefined', { value: undefined }],
    ['NaN', { value: Number.NaN }],
    ['Infinity', { value: Number.POSITIVE_INFINITY }],
    ['function', { value: () => 1 }],
    ['symbol', { value: Symbol('audit') }],
    ['cycle', cyclic],
  ] as const) {
    expect(() => canonicalizeStorageAuditValue(value), label)
      .toThrow('STORAGE_AUDIT_HASH_UNSUPPORTED');
  }
});

test('storage frame integrity commits Runtime checkpoint graph root, never a blob', () => {
  const base: RuntimeFrame = {
    height: 1,
    timestamp: 100,
    replicaMetaDigest: `0x${'22'.repeat(32)}`,
    postStateHash: `0x${'44'.repeat(32)}`,
    stateHash: `0x${'33'.repeat(32)}`,
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    touchedEntities: [],
    touchedAccounts: [],
    touchedBookEntities: [],
  };

  const alpha = computeStorageFrameHash({
    ...base,
    runtimeMachineRoot: prepareRuntimeMachineGraphRows(1, { provider: 'alpha' }).root,
  });
  const beta = computeStorageFrameHash({
    ...base,
    runtimeMachineRoot: prepareRuntimeMachineGraphRows(1, { provider: 'beta' }).root,
  });

  // Current testnet storage checksum golden. Fresh deploys intentionally keep
  // one format instead of a parallel versioned recovery implementation.
  expect(alpha).not.toBe(beta);
});

test('per-frame post-state hash commits replayed state and frame coordinates', () => {
  const base = {
    height: 7,
    timestamp: 1234,
    replicaMetaDigest: `0x${'22'.repeat(32)}`,
    runtimeComponentDigests: computeRuntimePostStateComponentDigests({
      infrastructure: { pendingCommittedJOutbox: new Map([['a', 1]]) },
    }),
    runtimeOutputRefs: [],
    runtimeOutputRetryState: [],
  };
  const hash = computeStoragePostStateHash(base);

  expect(computeStoragePostStateHash({ ...base, height: 8 })).not.toBe(hash);
  expect(computeStoragePostStateHash({ ...base, timestamp: 1235 })).not.toBe(hash);
  expect(computeStoragePostStateHash({
    ...base,
    replicaMetaDigest: `0x${'23'.repeat(32)}`,
  })).not.toBe(hash);
  expect(computeStoragePostStateHash({
    ...base,
    runtimeOutputRefs: [`0x${'24'.repeat(32)}`],
  })).not.toBe(hash);
  expect(computeStoragePostStateHash({
    ...base,
    runtimeOutputRetryState: [{
      outputHash: `xln.durable-output-retry.v1:0x${'25'.repeat(32)}`,
      attempts: 2,
      retryAt: 1236,
    }],
  })).not.toBe(hash);
  expect(computeStoragePostStateHash({
    ...base,
    runtimeComponentDigests: computeRuntimePostStateComponentDigests({
      infrastructure: { pendingCommittedJOutbox: new Map([['a', 2]]) },
    }),
  })).not.toBe(hash);
});

test('per-frame Runtime root trusts BrowserVM stateRoot instead of rehashing trie bytes', () => {
  const browserVMState = {
    version: 1,
    chainId: 31_337,
    stateRoot: `0x${'31'.repeat(32)}`,
    trieData: [['0x01', '0xaa']],
    nonce: '1',
    entityProviderDeploymentBlock: 1,
    chain: { blockNumber: 1 },
    addresses: {
      depository: `0x${'41'.repeat(20)}`,
      entityProvider: `0x${'42'.repeat(20)}`,
    },
  };
  const digest = (machine: Record<string, unknown>) =>
    computeRuntimePostStateComponentDigests(
      projectReplayVerifiableRuntimePostStateView(machine),
    );
  const base = digest({ browserVMState });
  expect(digest({ browserVMState: { ...browserVMState, trieData: [['0x02', '0xbb']] } }))
    .toEqual(base);
  expect(digest({
    browserVMState: { ...browserVMState, stateRoot: `0x${'32'.repeat(32)}` },
  })).not.toEqual(base);
});

test('replay oracle excludes local operator config and active J-adapter selector', () => {
  const infrastructure = { pendingCommittedJOutbox: new Map([['a', 1]]) };
  const left = projectReplayVerifiableRuntimeMachine({
    runtimeId: 'runtime-a',
    activeJurisdiction: 'Testnet',
    runtimeConfig: { storage: { snapshotPeriodFrames: 2 } },
    infrastructure,
  });
  const right = projectReplayVerifiableRuntimeMachine({
    runtimeId: 'runtime-a',
    activeJurisdiction: 'Tron',
    runtimeConfig: { storage: { snapshotPeriodFrames: 200 } },
    infrastructure,
  });

  expect(left).toEqual(right);
  expect(left).toEqual({ runtimeId: 'runtime-a', infrastructure });
});

test('replay oracle canonicalizes empty optional Runtime input queues', () => {
  const base = {
    state: {
      eReplicas: new Map(),
      jReplicas: new Map(),
      height: 0,
      timestamp: 0,
    },
    runtimeMempool: { runtimeTxs: [], entityInputs: [] },
  } as unknown as RuntimeReplica;
  const withEmptyOptionals = {
    ...base,
    runtimeMempool: {
      runtimeTxs: [],
      entityInputs: [],
      jInputs: [],
      reliableReceipts: [],
    },
  } as RuntimeReplica;

  expect(buildReplayVerifiableRuntimeMachineSnapshot(withEmptyOptionals))
    .toEqual(buildReplayVerifiableRuntimeMachineSnapshot(base));
});

test('replay oracle excludes process-local Runtime lifecycle failures', () => {
  const base = {
    state: {
      eReplicas: new Map(),
      jReplicas: new Map(),
      height: 0,
      timestamp: 0,
    },
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
  } as unknown as RuntimeReplica;
  const running = { ...base, infrastructure: { halted: false } } as RuntimeReplica;
  const halted = { ...base, infrastructure: { halted: true } } as RuntimeReplica;

  expect(buildReplayVerifiableRuntimeMachineSnapshot(running))
    .toEqual(buildReplayVerifiableRuntimeMachineSnapshot(base));
  expect(buildReplayVerifiableRuntimeMachineSnapshot(halted))
    .toEqual(buildReplayVerifiableRuntimeMachineSnapshot(base));
});

test('canonical storage hash is deterministic across orderbook pair index insertion order', () => {
  const left = makeEnvWithOrderbookPairs(['b-pair', 'a-pair']);
  const right = makeEnvWithOrderbookPairs(['a-pair', 'b-pair']);

  const leftIndex = Array.from(left.state.eReplicas.values())[0]!.state.orderbookExt!.orderPairs.get(sharedOrderId);
  const rightIndex = Array.from(right.state.eReplicas.values())[0]!.state.orderbookExt!.orderPairs.get(sharedOrderId);

  expect(leftIndex).toEqual(['a-pair', 'b-pair']);
  expect(rightIndex).toEqual(['a-pair', 'b-pair']);
  expect(computeCanonicalStateHashFromEnv(left)).toBe(computeCanonicalStateHashFromEnv(right));
});

test('canonical storage hash ignores UI frameHistory and reacts to consensus state', () => {
  const base = computeCanonicalStateHashFromEnv(makeEnv(makeAccount('history-a'), [[1, 10n]]));
  const changedHistory = computeCanonicalStateHashFromEnv(makeEnv(makeAccount('history-b'), [[1, 10n]]));
  const changedReserve = computeCanonicalStateHashFromEnv(makeEnv(makeAccount('history-a'), [[1, 11n]]));

  expect(changedHistory).toBe(base);
  expect(changedReserve).not.toBe(base);
});

test('canonical Entity hash excludes validator-private J history', () => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const before = computeCanonicalEntityHash(replica).hash;

  replica.jHistory = {
    jurisdictionRef: 'testnet:1',
    scannedThroughHeight: 25,
    contiguousThroughHeight: 0,
    tipBlockHash: `0x${'25'.repeat(32)}`,
    eventBlocks: new Map([[25, {
      jurisdictionRef: 'testnet:1',
      jHeight: 25,
      jBlockHash: `0x${'25'.repeat(32)}`,
      eventsHash: `0x${'26'.repeat(32)}`,
      events: [],
    }]]),
    blockHashes: new Map([[25, `0x${'25'.repeat(32)}`]]),
  };

  expect(computeCanonicalEntityHash(replica).hash).toBe(before);
});

test('validator-local HTLC notes neither diverge shared storage nor leak into Entity core', () => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const first = Array.from(env.state.eReplicas.values())[0]!;
  const second: EntityReplica = { ...first, state: { ...first.state } };
  second.signerId = signerIds[1]!;
  first.htlcNotes = new Map([[`hashlock:0x${'33'.repeat(32)}`, 'validator-one']]);
  second.htlcNotes = new Map([[`hashlock:0x${'33'.repeat(32)}`, 'validator-two']]);
  env.state.eReplicas.set(`${entityId}:${signerIds[1]}`, second);

  expect(computeCanonicalEntityHash(first).hash).toBe(computeCanonicalEntityHash(second).hash);
  expect(() => computeCanonicalStateHashFromEnv(env)).not.toThrow();
  expect('htlcNotes' in projectEntityCoreDoc(first.state)).toBeFalse();
  expect(projectReplicaMeta(first).htlcNotes).toEqual(first.htlcNotes);
  expect(projectReplicaMeta(second).htlcNotes).toEqual(second.htlcNotes);
});

test('canonical storage rejects conflicting validator replicas of one Entity', () => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const first = Array.from(env.state.eReplicas.values())[0]!;
  const conflicting: EntityReplica = { ...first, state: { ...first.state } };
  conflicting.signerId = signerIds[1]!;
  conflicting.state.profile = { ...conflicting.state.profile, name: 'validator-local-conflict' };
  env.state.eReplicas.set(`${entityId}:${signerIds[1]}`, conflicting);

  expect(() => computeCanonicalStateHashFromEnv(env))
    .toThrow('STORAGE_ENTITY_REPLICA_STATE_DIVERGENCE');
});

test('storage projection round-trip preserves canonical account optional-field shape', () => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const state = replica.state;
  const currentAccount = state.accounts.get(counterpartyId)!;
  const account: AccountReplica = {
    ...currentAccount,
    state: { ...currentAccount.state },
  };
  account.hankoSignature = '0xaccount-proof-hanko';
  account.pendingForwards = [{
    tokenId: 1,
    amount: 25n,
    route: [entityId, counterpartyId],
    description: 'projection-round-trip',
  }];
  account.state.lendingIntents = PersistentAccountStateMap.fromEntries('lendingIntents', [['lend-0123456789abcdef', 'fund']]);
  account.state.subcontracts = PersistentAccountStateMap.fromEntries('subcontracts', [['custom-transformer', {
    transformerAddress: `0x${'33'.repeat(20)}`,
    encodedBatch: '0x1234',
    allowances: [{ deltaIndex: 0, rightAllowance: 3n, leftAllowance: 4n }],
  }]]);
  account.disputePrepare = {
    startedAt: 100,
    readyAfter: 200,
    reason: 'projection-round-trip',
  };
  state.lending = {
    pools: new Map([['lend-0123456789abcdef', {
      positionId: 'lend-0123456789abcdef',
      hubEntityId: entityId,
      lenderEntityId: counterpartyId,
      tokenId: 1,
      principalAmount: 25n,
      availableAmount: 25n,
      borrowedAmount: 0n,
      interestBps: 100,
      termId: '1h',
      termMs: 3_600_000,
      createdAt: 100,
      updatedAt: 100,
      status: 'open',
    }]]),
    loans: new Map(),
  };
  state.consumptionAccumulator = {
    version: 1,
    root: `0x${'44'.repeat(32)}`,
    count: 1n,
  };

  expect(account.state.pulls).toBeUndefined();
  expect(account.swapOrderHistory).toBeUndefined();
  expect(account.swapClosedOrders).toBeUndefined();
  expect(projectAccountDoc(account)).toBe(account);

  const hydratedState = hydrateEntityStateFromStorage({
    core: projectEntityCoreDoc(state),
    accounts: new Map([[counterpartyId, projectAccountDoc(account)]]),
    books: new Map(),
  });
  state.accounts = state.accounts.updated(counterpartyId, account);

  const before = computeCanonicalEntityHash(replica);
  const after = computeCanonicalEntityHash({ ...replica, state: hydratedState });

  expect(hydratedState.accounts.get(counterpartyId)?.state.pulls).toBeUndefined();
  expect(hydratedState.accounts.get(counterpartyId)?.state.domain).toEqual(account.state.domain);
  expect(hydratedState.accounts.get(counterpartyId)?.swapOrderHistory).toBeUndefined();
  expect(hydratedState.accounts.get(counterpartyId)?.swapClosedOrders).toBeUndefined();
  expect(hydratedState.accounts.get(counterpartyId)?.hankoSignature).toBe(account.hankoSignature);
  expect(hydratedState.accounts.get(counterpartyId)?.pendingForwards).toEqual(account.pendingForwards);
  expect(hydratedState.accounts.get(counterpartyId)?.state.lendingIntents).toEqual(account.state.lendingIntents);
  expect(hydratedState.accounts.get(counterpartyId)?.state.subcontracts).toEqual(account.state.subcontracts);
  expect(hydratedState.accounts.get(counterpartyId)?.disputePrepare).toEqual(account.disputePrepare);
  expect(hydratedState.lending).toEqual(state.lending);
  expect(hydratedState.consumptionAccumulator).toEqual(state.consumptionAccumulator);
  expect(after.hash).toBe(before.hash);
});

test('replica metadata projection preserves in-flight consensus and layout state', () => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  replica.mempool = [{ type: 'broadcast', data: { message: 'pending' } }];
  replica.position = { x: 1, y: 2, z: 3, jurisdiction: 'Testnet' };
  replica.jHistory = {
    jurisdictionRef: 'testnet:1',
    scannedThroughHeight: 7,
    contiguousThroughHeight: 0,
    tipBlockHash: `0x${'07'.repeat(32)}`,
    eventBlocks: new Map(),
    blockHashes: new Map([[7, `0x${'07'.repeat(32)}`]]),
  };

  const meta = projectReplicaMeta(replica);

  expect('state' in meta).toBeFalse();
  expect(meta.mempool).toBe(replica.mempool);
  expect(meta.mempool).toEqual(replica.mempool);
  expect(meta.position).toEqual(replica.position);
  expect(meta.jHistory).toEqual(replica.jHistory);
  expect('entityEncPrivKey' in meta).toBeFalse();
});

test('immediate replica metadata encoding matches the persistent recovery view', () => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  Object.defineProperty(replica, Symbol('ephemeral-replica-marker'), {
    configurable: true,
    enumerable: true,
    value: true,
  });

  const expected = encodeBuffer(projectReplicaMeta(replica), { omitSymbolKeys: true });
  const actual = encodeReplicaMeta(replica);

  expect(actual.equals(expected)).toBeTrue();
});

test('live replica metadata omits transient commitment caches at every in-flight state level', () => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const validatorState = commitEntityFrameCandidateState(
    createEntityFrameCandidateState(replica.state),
  );
  const transientEntityCache = Symbol('xln.entity.account-commitment-cache');
  Object.defineProperty(validatorState, transientEntityCache, {
    configurable: true,
    enumerable: false,
    value: new Map(),
  });
  replica.candidate = {
    frameHash: `0x${'ab'.repeat(32)}`,
    height: validatorState.height + 1,
    state: validatorState,
    outputs: [],
    jOutputs: [],
    hashesToSign: [],
    storageChanges: [],
  };

  expect(() => buildStorageLiveReplicaMetaCommitment(env)).not.toThrow();
});
