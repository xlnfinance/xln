import { expect, test } from 'bun:test';

import { computeCanonicalEntityHash, computeCanonicalStateHashFromEnv } from '../storage/canonical-hash';
import { computeStorageFrameHash } from '../storage/hashes';
import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';
import { encodeBoard, hashBoard } from '../entity/factory';
import { applyCommand, createBook, replaceOrderbookPair } from '../orderbook';
import { hydrateEntityStateFromStorage, projectAccountDoc, projectEntityCoreDoc, projectReplicaMeta } from '../storage/projections';
import { cloneEntityState } from '../state-helpers';
import type { StorageFrameRecord } from '../storage/types';
import type { AccountMachine, EntityReplica, Env } from '../types';

const signerIds = [`0x${'11'.repeat(20)}`, `0x${'12'.repeat(20)}`];
const consensusConfig = {
  mode: 'proposer-based' as const,
  threshold: 2n,
  validators: signerIds,
  shares: Object.fromEntries(signerIds.map(signerId => [signerId, 1n])),
};
const entityId = hashBoard(encodeBoard(consensusConfig)).toLowerCase();
const counterpartyId = `0x${'ff'.repeat(32)}`;

const makeAccount = (frameStateHash: string): AccountMachine =>
  ({
    leftEntity: entityId,
    rightEntity: counterpartyId,
    domain: { chainId: 31337, depositoryAddress: `0x${'de'.repeat(20)}` },
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 1,
      timestamp: 100,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '0x0',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      stateHash: '0x1',
      deltas: [],
    },
    deltas: new Map([[1, {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 10n,
      leftCreditLimit: 0n,
      rightCreditLimit: 0n,
      leftAllowance: 0n,
      rightAllowance: 0n,
    }]]),
    locks: new Map(),
    swapOffers: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 1,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: entityId, toEntity: counterpartyId, nextProofNonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [{
      height: 1,
      timestamp: 100,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '0x0',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      stateHash: frameStateHash,
      deltas: [],
    }],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    jNonce: 0,
  }) as AccountMachine;

const makeEnv = (account: AccountMachine, reserves: Array<[number, bigint]>): Env =>
  ({
    height: 7,
    timestamp: 1234,
    eReplicas: new Map<string, EntityReplica>([
      [`${entityId}:${signerIds[0]}`, {
        entityId,
        signerId: signerIds[0]!,
        mempool: [],
        isProposer: true,
        state: {
          entityId,
          height: 0,
          timestamp: 1234,
          messages: [],
          nonces: new Map([['1', 1]]),
          proposals: new Map(),
          config: consensusConfig,
          reserves: new Map(reserves),
          accounts: new Map([[counterpartyId, account]]),
          deferredAccountProposals: new Map(),
          lastFinalizedJHeight: 0,
          jBlockChain: [],
          entityEncPubKey: 'pub',
          entityEncPrivKey: 'priv',
          profile: { name: 'canonical-test', isHub: false, avatar: '', bio: '', website: '' },
          htlcRoutes: new Map(),
          htlcFeesEarned: 0n,
          htlcNotes: new Map(),
          lockBook: new Map(),
          swapTradingPairs: [],
          pendingSwapFillRatios: new Map(),
        },
      } as EntityReplica],
    ]),
  }) as Env;

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

const makeEnvWithOrderbookPairs = (pairIds: string[]): Env => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const replica = Array.from(env.eReplicas.values())[0]!;
  const orderbookExt = {
    books: new Map(),
    orderPairs: new Map(),
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

test('storage frame integrity commits every named runtime-machine field', () => {
  const base: StorageFrameRecord = {
    height: 1,
    timestamp: 100,
    replicaMetaDigest: `0x${'22'.repeat(32)}`,
    stateHash: `0x${'33'.repeat(32)}`,
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    touchedEntities: [],
    touchedAccounts: [],
    touchedBookEntities: [],
  };

  const alpha = computeStorageFrameHash({ ...base, runtimeMachine: { provider: 'alpha' } });
  const beta = computeStorageFrameHash({ ...base, runtimeMachine: { provider: 'beta' } });

  // xln.storage.frame.v2 golden. Changing this requires a schema/domain bump and
  // an independently reviewed preimage, never a mechanical fixture refresh.
  expect(alpha).toBe('0x71cafe56cd8cfe4145cf0c760d98ad06db43fe4f518648fd0ac8ff34a1f24d87');
  expect(alpha).not.toBe(beta);
  const ownUndefined = computeStorageFrameHash({ ...base, runtimeMachine: { hidden: undefined } });
  // Authoritative MessagePack preserves an explicitly named undefined field;
  // it must therefore remain distinguishable from both an empty and an absent
  // runtime-machine record in the WAL integrity preimage.
  expect(ownUndefined).toBe('0x169386e99dbcdb6ef40f4b332967751296060064d6b3a8daf25667e25bf17910');
  expect(ownUndefined).not.toBe(computeStorageFrameHash({ ...base, runtimeMachine: {} }));
  expect(ownUndefined).not.toBe(computeStorageFrameHash(base));
});

test('canonical storage hash is deterministic across orderbook pair index insertion order', () => {
  const left = makeEnvWithOrderbookPairs(['b-pair', 'a-pair']);
  const right = makeEnvWithOrderbookPairs(['a-pair', 'b-pair']);

  const leftIndex = Array.from(left.eReplicas.values())[0]!.state.orderbookExt!.orderPairs.get(sharedOrderId);
  const rightIndex = Array.from(right.eReplicas.values())[0]!.state.orderbookExt!.orderPairs.get(sharedOrderId);

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
  const replica = Array.from(env.eReplicas.values())[0]!;
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
  const first = Array.from(env.eReplicas.values())[0]!;
  const second = structuredClone(first);
  second.signerId = signerIds[1]!;
  first.state.htlcNotes = new Map([[`lock:0x${'33'.repeat(32)}`, 'validator-one']]);
  second.state.htlcNotes = new Map([[`lock:0x${'33'.repeat(32)}`, 'validator-two']]);
  env.eReplicas.set(`${entityId}:${signerIds[1]}`, second);

  expect(computeCanonicalEntityHash(first).hash).toBe(computeCanonicalEntityHash(second).hash);
  expect(() => computeCanonicalStateHashFromEnv(env)).not.toThrow();
  expect('htlcNotes' in projectEntityCoreDoc(first.state)).toBeFalse();
  expect(projectReplicaMeta(first).state.htlcNotes).toEqual(first.state.htlcNotes);
  expect(projectReplicaMeta(second).state.htlcNotes).toEqual(second.state.htlcNotes);
});

test('canonical storage rejects conflicting validator replicas of one Entity', () => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const first = Array.from(env.eReplicas.values())[0]!;
  const conflicting = structuredClone(first);
  conflicting.signerId = signerIds[1]!;
  conflicting.state.messages = ['validator-local-conflict'];
  env.eReplicas.set(`${entityId}:${signerIds[1]}`, conflicting);

  expect(() => computeCanonicalStateHashFromEnv(env))
    .toThrow('STORAGE_ENTITY_REPLICA_STATE_DIVERGENCE');
});

test('storage projection round-trip preserves canonical account optional-field shape', () => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const replica = Array.from(env.eReplicas.values())[0]!;
  const state = replica.state;
  const account = state.accounts.get(counterpartyId)!;
  account.hankoSignature = '0xaccount-proof-hanko';
  account.pendingForward = {
    tokenId: 1,
    amount: 25n,
    route: [entityId, counterpartyId],
    description: 'projection-round-trip',
  };
  account.lendingIntents = new Map([['lend-0123456789abcdef', 'fund']]);
  account.subcontracts = new Map([['custom-transformer', {
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
    version: 2,
    root: `0x${'44'.repeat(32)}`,
    count: 1n,
  };
  state.profileEncryptionManifest = {
    entityId,
    threshold: 1,
    attestations: [{
      version: 'xln:validator-encryption-key:v1',
      entityId,
      signerId: '1',
      signer: '0x0000000000000000000000000000000000000001',
      publicKey: `0x04${'33'.repeat(64)}`,
      weight: 1,
      encryptionPublicKey: `0x${'55'.repeat(32)}`,
      signature: `0x${'66'.repeat(65)}`,
    }],
    hash: `0x${'77'.repeat(32)}`,
  };

  expect(account.pulls).toBeUndefined();
  expect(account.swapOrderHistory).toBeUndefined();
  expect(account.swapClosedOrders).toBeUndefined();

  const hydratedState = hydrateEntityStateFromStorage({
    core: projectEntityCoreDoc(state),
    accounts: new Map([[counterpartyId, projectAccountDoc(account)]]),
    books: new Map(),
  });

  expect(hydratedState.profileEncryptionManifest).toEqual(state.profileEncryptionManifest);

  const before = computeCanonicalEntityHash(replica);
  const after = computeCanonicalEntityHash({ ...replica, state: hydratedState });

  expect(hydratedState.accounts.get(counterpartyId)?.pulls).toBeUndefined();
  expect(hydratedState.accounts.get(counterpartyId)?.domain).toEqual(account.domain);
  expect(hydratedState.accounts.get(counterpartyId)?.swapOrderHistory).toBeUndefined();
  expect(hydratedState.accounts.get(counterpartyId)?.swapClosedOrders).toBeUndefined();
  expect(hydratedState.accounts.get(counterpartyId)?.hankoSignature).toBe(account.hankoSignature);
  expect(hydratedState.accounts.get(counterpartyId)?.pendingForward).toEqual(account.pendingForward);
  expect(hydratedState.accounts.get(counterpartyId)?.lendingIntents).toEqual(account.lendingIntents);
  expect(hydratedState.accounts.get(counterpartyId)?.subcontracts).toEqual(account.subcontracts);
  expect(hydratedState.accounts.get(counterpartyId)?.disputePrepare).toEqual(account.disputePrepare);
  expect(hydratedState.lending).toEqual(state.lending);
  expect(hydratedState.consumptionAccumulator).toEqual(state.consumptionAccumulator);
  expect(after.hash).toBe(before.hash);
});

test('replica metadata projection preserves in-flight consensus and layout state', () => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const replica = Array.from(env.eReplicas.values())[0]!;
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

  expect(meta.mempool).toEqual(replica.mempool);
  expect(meta.position).toEqual(replica.position);
  expect(meta.jHistory).toEqual(replica.jHistory);
  expect(meta.state).toEqual(cloneEntityState(replica.state, true));
  expect(meta.state.accounts.get(counterpartyId)?.pulls).toBeUndefined();
});
