import { describe, expect, test } from 'bun:test';
import {
  forkEntityReplicaForInput,
} from '../../../entity/replica/replica-clone';
import {
  commitEntityFrameCandidateState,
  createEntityFrameCandidateState,
} from '../../../entity/state-clone';
import {
  commitEntityAccountCandidate,
  EntityAccountCandidateMap,
  getEntityCandidateValueForWrite,
} from '../../../entity/state/candidate-map';
import { getEntityAccountForWrite } from '../../../entity/state/persistent-account-map';
import { getEntityCollectionValueForWrite } from '../../../entity/state/persistent-collection-map';
import {
  computeCanonicalEntityConsensusStateHash,
  computeCanonicalEntityConsensusStateHashCold,
} from '../../../entity/consensus/state-root';
import {
  applyRuntimeOwnedEntityFrame,
} from '../../../entity/consensus/frame/application';
import { materializeEntityInfraContext } from '../../../entity/consensus/proposal/infra-context';
import { prepareEntityInputIngress } from '../../../entity/consensus/input/ingress';
import { applyEntityFrameWithMaterializedTestInfraContext } from '../../helpers/entity-frame';
import { EntityCandidateMap } from '../../../entity/state/candidate-map';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import {
  applyCommand,
  createBook,
  createOrderbookExtState,
} from '../../../orderbook';
import { buildCanonicalEntityReplicaSnapshot } from '../../../storage/wal/snapshot';
import { encodeBuffer } from '../../../storage/codec/codec';
import { validateConsensusConfig } from '../../../entity/consensus/config-validation';
import { validateEntityReplica } from '../../../entity/replica/replica-validation';
import { createEmptyEnv } from '../../../runtime';
import type { AccountReplica } from '../../../types/account';
import type { EntityState } from '../../../entity/types';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';

const TEST_RIGHT_ENTITY_ID = `0x${'bb'.repeat(32)}`;

const putCommittedAccount = (
  state: EntityState,
  counterpartyId: string,
  account: AccountReplica,
): void => {
  if (!(state.accounts instanceof PersistentEntityAccountMap)) {
    throw new Error('TEST_COMMITTED_ACCOUNT_MAP_REQUIRED');
  }
  state.accounts = state.accounts.updated(counterpartyId, account);
};

const makeCrossJurisdictionRoute = () => ({
  orderId: 'order-1',
  routeHash: `0x${'aa'.repeat(32)}`,
  makerEntityId: 'maker',
  hubEntityId: 'hub',
  source: {
    jurisdiction: 'source-j',
    entityId: 'source',
    counterpartyEntityId: 'source-counterparty',
    tokenId: 1,
    amount: 100n,
  },
  target: {
    jurisdiction: 'target-j',
    entityId: 'target',
    counterpartyEntityId: 'target-counterparty',
    tokenId: 2,
    amount: 200n,
  },
  sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  sourcePull: {
    pullId: 'source-pull',
    tokenId: 1,
    amount: 100n,
    signedAmount: 100n,
    fullHash: `0x${'bb'.repeat(32)}`,
    partialRoot: `0x${'cc'.repeat(32)}`,
  },
  targetPull: {
    pullId: 'target-pull',
    tokenId: 2,
    amount: 200n,
    signedAmount: 200n,
    fullHash: `0x${'dd'.repeat(32)}`,
    partialRoot: `0x${'ee'.repeat(32)}`,
  },
  status: 'resting',
  createdAt: 1,
  updatedAt: 2,
});

const makeProofBodyStruct = () => ({
  watchSeed: `0x${'11'.repeat(32)}`,
  offdeltas: [1n],
  tokenIds: [1],
  transformers: [{
    transformerAddress: `0x${'22'.repeat(20)}`,
    encodedBatch: '0x1234',
    allowances: [{ deltaIndex: 0, leftAllowance: 1n, rightAllowance: 2n }],
  }],
});

const makeCanonicalAccountFixture = () => ({
  state: {
    leftEntity: 'left',
    rightEntity: 'right',
    domain: {
      chainId: 31337,
      depositoryAddress: `0x${'dd'.repeat(20)}`,
    },
    watchSeed: `0x${'11'.repeat(32)}`,
    deltas: PersistentAccountStateMap.fromEntries('deltas', [[1, {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: 0n,
      rightCreditLimit: 0n,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 0n,
      rightHold: 0n,
    }]]),
    locks: PersistentAccountStateMap.empty('locks'),
    swapOffers: PersistentAccountStateMap.fromEntries('swapOffers', [['offer-1', {
      offerId: 'offer-1',
      giveTokenId: 1,
      giveAmount: 10n,
      wantTokenId: 2,
      wantAmount: 20n,
      maxFee: 0n,
      minNetReceive: 20n,
      priceTicks: 2_000_000n,
      timeInForce: 0,
      makerIsLeft: true,
      createdHeight: 1,
      quantizedGive: 10n,
      quantizedWant: 20n,
      crossJurisdiction: makeCrossJurisdictionRoute(),
    }]]),
    pulls: PersistentAccountStateMap.empty('pulls'),
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
    requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
  },
  status: 'active',
  mempool: [{
    type: 'direct_payment',
    data: {
      tokenId: 1,
      amount: 10n,
      route: ['left'],
      deliveryMode: 'direct',
      fromEntityId: 'left',
      toEntityId: 'right',
    },
  }],
  currentFrame: {
    height: 0,
    timestamp: 0,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: '',
    stateHash: '',
    accountStateRoot: `0x${'00'.repeat(32)}`,
    byLeft: true,
    deltas: [],
  },
  currentHeight: 0,
  rollbackCount: 0,
  proofHeader: { fromEntity: 'left', toEntity: 'right', nextProofNonce: 0 },
  proofBody: { tokenIds: [1], deltas: [0n] },
  pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
  shadow: { rebalance: {
    policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
    submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
  } },
  disputeProofBodiesByHash: {
    proof: makeProofBodyStruct(),
  },
  disputeArgumentSnapshotsByHash: {
    proof: {
      proofbodyHash: 'proof',
      nonce: 1,
      side: 'left',
      proofBodyStruct: makeProofBodyStruct(),
      plan: {
        paymentHashlocks: ['hashlock-1'],
        leftSwapOfferIds: ['left-offer-1'],
        rightSwapOfferIds: [],
        leftPullIds: [],
        rightPullIds: [],
      },
    },
  },
  uncloneable: () => undefined,
});

const bindAccountParticipants = (
  account: ReturnType<typeof makeCanonicalAccountFixture>,
  localEntityId: string,
  counterpartyId: string,
): void => {
  account.state.leftEntity = localEntityId;
  account.state.rightEntity = counterpartyId;
  account.proofHeader.fromEntity = localEntityId;
  account.proofHeader.toEntity = counterpartyId;
};

const makeProjectionReplica = () => ({
  entityId: `0x${'aa'.repeat(32)}`,
  signerId: `0x${'11'.repeat(20)}`,
  entityEncPubKey: '',
  isProposer: false,
  state: {
    entityId: `0x${'aa'.repeat(32)}`,
    entityEncryptionPublicKey: `0x${'44'.repeat(32)}`,
    height: 0,
    timestamp: 1,
    nonces: new Map(),
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: 1n,
      validators: [`0x${'11'.repeat(20)}`],
      shares: { [`0x${'11'.repeat(20)}`]: 1n },
    },
    reserves: new Map(),
    accounts: PersistentEntityAccountMap.empty(
      `0x${'aa'.repeat(32)}`,
      computeEntityAccountValueHash,
    ),
    deferredAccountProposals: new Map(),
    lastFinalizedJHeight: 0,
    profile: { name: 'Projection', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
    swapTradingPairs: [],
  },
});

describe('state cloning', () => {
  test('Entity frame candidate clones only an Account it touches', () => {
    const source = makeProjectionReplica().state as EntityState;
    const counterpartyId = `0x${'bb'.repeat(32)}`;
    const accountFixture = makeCanonicalAccountFixture();
    delete accountFixture.uncloneable;
    const account = accountFixture as unknown as AccountReplica;
    bindAccountParticipants(accountFixture, source.entityId, counterpartyId);
    putCommittedAccount(source, counterpartyId, account);

    const candidate = createEntityFrameCandidateState(source);
    expect(candidate.accounts).toBeInstanceOf(EntityAccountCandidateMap);
    expect((candidate.accounts as EntityAccountCandidateMap).stats()).toEqual({
      base: 1,
      changed: 0,
      deleted: 0,
    });

    const candidateAccount = getEntityAccountForWrite(candidate.accounts, counterpartyId);
    if (!candidateAccount) throw new Error('TEST_ENTITY_CANDIDATE_ACCOUNT_MISSING');
    candidateAccount.currentHeight = 99;

    expect(source.accounts.get(counterpartyId)?.currentHeight).toBe(0);
    expect((candidate.accounts as EntityAccountCandidateMap).stats().changed).toBe(1);
  });

  test('Entity root projection never claims untouched Accounts for mutation', () => {
    const source = makeProjectionReplica().state as EntityState;
    for (const byte of ['b1', 'b2', 'b3']) {
      const counterpartyId = `0x${byte.repeat(32)}`;
      const accountFixture = makeCanonicalAccountFixture();
      delete accountFixture.uncloneable;
      const account = accountFixture as unknown as AccountReplica;
      bindAccountParticipants(accountFixture, source.entityId, counterpartyId);
      putCommittedAccount(source, counterpartyId, account);
    }

    const sourceRoot = computeCanonicalEntityConsensusStateHashCold(source);
    const candidate = createEntityFrameCandidateState(source);
    const accounts = candidate.accounts as EntityAccountCandidateMap;
    expect(accounts.stats().changed).toBe(0);
    expect(computeCanonicalEntityConsensusStateHash(candidate)).toBe(sourceRoot);
    expect(computeCanonicalEntityConsensusStateHashCold(candidate)).toBe(sourceRoot);
    expect(accounts.stats().changed).toBe(0);

    const touchedId = `0x${'b2'.repeat(32)}`;
    getEntityAccountForWrite(candidate.accounts, touchedId)!.currentHeight = 7;
    expect(accounts.stats().changed).toBe(1);
    const incremental = computeCanonicalEntityConsensusStateHash(candidate);
    expect(incremental).toBe(computeCanonicalEntityConsensusStateHashCold(candidate));
    expect(accounts.stats().changed).toBe(1);
  });

  test('independent Entity Account candidates preserve roots and promote only at commit', () => {
    const source = makeProjectionReplica().state as EntityState;
    const counterpartyId = `0x${'cc'.repeat(32)}`;
    const accountFixture = makeCanonicalAccountFixture();
    delete accountFixture.uncloneable;
    const account = accountFixture as unknown as AccountReplica;
    bindAccountParticipants(accountFixture, source.entityId, counterpartyId);
    putCommittedAccount(source, counterpartyId, account);

    const independent = createEntityFrameCandidateState(source);
    const candidate = createEntityFrameCandidateState(source);
    const independentAccount = getEntityAccountForWrite(independent.accounts, counterpartyId);
    const candidateAccount = getEntityAccountForWrite(candidate.accounts, counterpartyId);
    if (!independentAccount || !candidateAccount) {
      throw new Error('TEST_ENTITY_CANDIDATE_ACCOUNT_MISSING');
    }
    independentAccount.currentHeight = 25;
    candidateAccount.currentHeight = 25;

    expect(computeCanonicalEntityConsensusStateHash(candidate))
      .toBe(computeCanonicalEntityConsensusStateHash(independent));
    expect(source.accounts.get(counterpartyId)?.currentHeight).toBe(0);

    candidate.accounts = commitEntityAccountCandidate(candidate.accounts);
    expect(candidate.accounts).not.toBe(source.accounts);
    expect(candidate.accounts.get(counterpartyId)?.currentHeight).toBe(25);
    expect(source.accounts.get(counterpartyId)?.currentHeight).toBe(0);
  });

  test('a planner flattens a prior candidate without linking commit to certified state', () => {
    const source = makeProjectionReplica().state as EntityState;
    const counterpartyId = `0x${'cd'.repeat(32)}`;
    const accountFixture = makeCanonicalAccountFixture();
    delete accountFixture.uncloneable;
    const account = accountFixture as unknown as AccountReplica;
    bindAccountParticipants(accountFixture, source.entityId, counterpartyId);
    putCommittedAccount(source, counterpartyId, account);

    const first = createEntityFrameCandidateState(source);
    getEntityAccountForWrite(first.accounts, counterpartyId)!.currentHeight = 11;
    const second = createEntityFrameCandidateState(first);
    getEntityAccountForWrite(second.accounts, counterpartyId)!.currentHeight = 22;
    second.accounts = commitEntityAccountCandidate(second.accounts);

    expect(source.accounts.get(counterpartyId)?.currentHeight).toBe(0);
    expect(first.accounts.get(counterpartyId)?.currentHeight).toBe(11);
    expect(second.accounts.get(counterpartyId)?.currentHeight).toBe(22);
    expect(second.accounts).not.toBe(source.accounts);
  });

  test('Entity frame candidate isolates only the touched Orderbook pair', () => {
    const source = makeProjectionReplica().state as EntityState;
    const firstPair = '1/2';
    const secondPair = '1/3';
    const createPairBook = () => createBook({
      bucketWidthTicks: 100n,
      maxOrders: 32,
      stpPolicy: 1,
    });
    source.orderbookExt = createOrderbookExtState({
      entityId: source.entityId,
      name: 'Projection Hub',
      spreadDistribution: {
        makerBps: 0,
        takerBps: 10_000,
        hubBps: 0,
        makerReferrerBps: 0,
        takerReferrerBps: 0,
      },
      referenceTokenId: 1,
      usdQuoteAuthorityEntityId: 'market-maker',
      minTradeSize: 0n,
      supportedPairs: [firstPair, secondPair],
    });
    source.orderbookExt.books.set(firstPair, createPairBook());
    source.orderbookExt.books.set(secondPair, createPairBook());

    const independent = createEntityFrameCandidateState(source);
    const candidate = createEntityFrameCandidateState(source);
    const candidateBooks = candidate.orderbookExt?.books;
    if (!(candidateBooks instanceof EntityCandidateMap)) {
      throw new Error('TEST_ENTITY_CANDIDATE_ORDERBOOK_MISSING');
    }
    expect(candidateBooks.stats()).toEqual({
      base: 2,
      changed: 0,
      deleted: 0,
    });

    const addOrder = (state: EntityState): void => {
      const books = state.orderbookExt?.books;
      if (!books) throw new Error('TEST_ENTITY_CANDIDATE_BOOKS_MISSING');
      const book = getEntityCandidateValueForWrite(books, firstPair);
      if (!book) throw new Error('TEST_ENTITY_CANDIDATE_BOOK_MISSING');
      const applied = applyCommand(book, {
        kind: 0,
        ownerId: source.entityId,
        orderId: 'projection-order',
        side: 1,
        tif: 0,
        postOnly: false,
        priceTicks: 1_000n,
        qtyLots: 10n,
      });
      books.set(firstPair, applied.state);
    };
    addOrder(independent);
    addOrder(candidate);

    expect(candidateBooks.stats()).toEqual({
      base: 2,
      changed: 1,
      deleted: 0,
    });
    expect(source.orderbookExt.books.get(firstPair)?.orders.size).toBe(0);
    const untouchedCandidateBook = Array.from(candidateBooks.entries())
      .find(([pairId]) => pairId === secondPair)?.[1];
    expect(untouchedCandidateBook).toBe(source.orderbookExt.books.get(secondPair));
    expect(computeCanonicalEntityConsensusStateHash(candidate))
      .toBe(computeCanonicalEntityConsensusStateHash(independent));

    commitEntityFrameCandidateState(candidate);
    expect(candidate.orderbookExt?.books).not.toBe(source.orderbookExt.books);
    expect(candidate.orderbookExt?.books.get(firstPair)?.orders.size).toBe(1);
    expect(source.orderbookExt.books.get(firstPair)?.orders.size).toBe(0);
    expect(source.orderbookExt.books.get(secondPair)?.orders.size).toBe(0);
  });

  test('single-signer Runtime ownership preserves the certified Entity root', async () => {
    const env = createEmptyEnv('single-signer owned Entity frame');
    env.state.timestamp = 2;
    const isolatedSource = makeProjectionReplica().state as EntityState;
    const ownedSource = commitEntityFrameCandidateState(
      createEntityFrameCandidateState(isolatedSource),
    );

    const isolated = await applyEntityFrameWithMaterializedTestInfraContext(
      env,
      isolatedSource,
      [],
      env.state.timestamp,
    );
    const ownedContext = await materializeEntityInfraContext(env, {
      ...makeProjectionReplica(),
      state: ownedSource,
      isProposer: true,
    }, [], { usePersistedReplayContext: true });
    const owned = await applyRuntimeOwnedEntityFrame(
      env,
      ownedSource,
      ownedContext,
      [],
      env.state.timestamp,
    );

    expect(isolatedSource.timestamp).toBe(1);
    expect(isolated.newState.accounts).toBeInstanceOf(EntityAccountCandidateMap);
    expect(ownedSource.timestamp).toBe(1);
    expect(owned.newState.accounts).not.toBe(ownedSource.accounts);
    expect(owned.newState.accounts).toBeInstanceOf(EntityAccountCandidateMap);
    expect(computeCanonicalEntityConsensusStateHash(owned.newState))
      .toBe(computeCanonicalEntityConsensusStateHash(isolated.newState));
  });

  test('trusted same-Runtime cascades do not reuse the external replay context', async () => {
    const env = createEmptyEnv('same-Runtime replay context isolation');
    const replica = makeProjectionReplica();
    const input = {
      entityId: replica.entityId,
      signerId: replica.signerId,
      entityTxs: [],
    };
    const externalIngress = prepareEntityInputIngress(env, replica, input, undefined, true);
    const crossJurisdictionIngress = prepareEntityInputIngress(env, replica, input, 'cross-j', true);
    const accountWorkIngress = prepareEntityInputIngress(env, replica, input, 'account-work', true);
    if (!externalIngress.accepted || !crossJurisdictionIngress.accepted || !accountWorkIngress.accepted) {
      throw new Error('TEST_ENTITY_INPUT_INGRESS_REJECTED');
    }

    expect(externalIngress.context.usePersistedReplayContext).toBe(true);
    expect(crossJurisdictionIngress.context.usePersistedReplayContext).toBe(false);
    expect(accountWorkIngress.context.usePersistedReplayContext).toBe(false);

    const persisted = await materializeEntityInfraContext(env, replica, [], {
      usePersistedReplayContext: false,
    });
    // A persisted context is bound to the exact height it applied at: the
    // external replay of the recorded input reuses it at that height.
    env.infrastructure.replayEntityContexts = new Map([
      [`${replica.entityId}:${replica.signerId}`, persisted],
    ]);
    const externalReplay = await materializeEntityInfraContext(env, replica, [], {
      usePersistedReplayContext: true,
    });

    // A Runtime-derived follow-up frame never consults the replay map, even
    // when an entry is recorded for exactly its height.
    replica.state.height += 1;
    replica.state.prevFrameHash = `0x${'99'.repeat(32)}`;
    env.infrastructure.replayEntityContexts.set(`${replica.entityId}:${replica.signerId}:2`, persisted);
    const internal = await materializeEntityInfraContext(env, replica, [], {
      usePersistedReplayContext: false,
    });

    expect(persisted.height).toBe(1);
    expect(externalReplay).toEqual(persisted);
    expect(internal.height).toBe(2);
    expect(internal).not.toEqual(persisted);
  });

  test('Entity candidate shares untouched Accounts and forks the exact growing leaf claimed for write', () => {
    const state = makeProjectionReplica().state as any;
    const route = makeCrossJurisdictionRoute();
    const account = makeCanonicalAccountFixture() as any;
    delete account.uncloneable;
    bindAccountParticipants(account, state.entityId, TEST_RIGHT_ENTITY_ID);
    account.state.swapOffers = PersistentAccountStateMap.fromEntries('swapOffers', [[
      route.orderId,
      {
        offerId: route.orderId,
        giveTokenId: 1,
        giveAmount: 10n,
        wantTokenId: 2,
        wantAmount: 20n,
        maxFee: 0n,
        minNetReceive: 20n,
        priceTicks: 2_000_000n,
        timeInForce: 0,
        makerIsLeft: true,
        createdHeight: 1,
        quantizedGive: 10n,
        quantizedWant: 20n,
        crossJurisdiction: route,
      },
    ]]);
    state.crossJurisdictionSwaps = new Map([[route.orderId, route]]);
    putCommittedAccount(state, TEST_RIGHT_ENTITY_ID, account);

    const candidate = createEntityFrameCandidateState(state);
    expect(candidate.accounts.get(TEST_RIGHT_ENTITY_ID)).toBe(state.accounts.get(TEST_RIGHT_ENTITY_ID));
    const writableRoute = getEntityCollectionValueForWrite(
      candidate.crossJurisdictionSwaps!,
      route.orderId,
    );
    if (!writableRoute) throw new Error('TEST_ENTITY_CANDIDATE_ROUTE_MISSING');
    writableRoute.source.amount = 999n;

    expect(candidate.crossJurisdictionSwaps!.get(route.orderId)!.source.amount).toBe(999n);
    expect(state.crossJurisdictionSwaps.get(route.orderId).source.amount).toBe(100n);
  });

  test('rejects a non-persistent Account map at the Entity candidate boundary', () => {
    const state = makeProjectionReplica().state as any;
    const account = makeCanonicalAccountFixture() as any;
    delete account.uncloneable;
    bindAccountParticipants(account, state.entityId, TEST_RIGHT_ENTITY_ID);

    state.accounts = new Map([[TEST_RIGHT_ENTITY_ID.toUpperCase(), account]]);
    expect(() => createEntityFrameCandidateState(state)).toThrow(
      'ENTITY_FRAME_CANDIDATE_ACCOUNTS_INVALID',
    );
  });

  test('preserves the exact configured board threshold', () => {
    const configuredBoards = [
      {
        mode: 'proposer-based' as const,
        threshold: 1n,
        validators: ['alice', 'bob'],
        shares: { alice: 1n, bob: 1n },
      },
      {
        mode: 'proposer-based' as const,
        threshold: 2n,
        validators: ['alice', 'bob', 'carol'],
        shares: { alice: 1n, bob: 1n, carol: 1n },
      },
      {
        mode: 'proposer-based' as const,
        threshold: 3n,
        validators: ['alice', 'bob', 'carol', 'dave'],
        shares: { alice: 1n, bob: 1n, carol: 1n, dave: 1n },
      },
    ];
    expect(configuredBoards.map((board) => validateConsensusConfig(board).threshold)).toEqual([
      1n,
      2n,
      3n,
    ]);

    expect(() => validateConsensusConfig({
      mode: 'proposer-based',
      threshold: 3n,
      validators: ['alice', 'bob'],
      shares: { alice: 1n, bob: 1n },
    })).toThrow('threshold exceeds total validator power');
  });

  test('validates entity replica shell and state identity', () => {
    const replica = { ...makeProjectionReplica(), mempool: [] };
    expect(validateEntityReplica(replica)).toBe(replica);

    expect(() => validateEntityReplica({ ...replica, mempool: undefined }))
      .toThrow('mempool must be an array');
    expect(() => validateEntityReplica({ ...replica, hankoWitness: 'not-a-map' }))
      .toThrow('hankoWitness must be a Map');

    const mismatched = {
      ...replica,
      state: {
        ...replica.state,
        entityId: `0x${'bb'.repeat(32)}`,
      },
    };

    expect(() => validateEntityReplica(mismatched)).toThrow('state.entityId must match replica.entityId');
  });

  test('rejects malformed validator-local submit receipts at the restore boundary', () => {
    const replica = { ...makeProjectionReplica(), mempool: [] };
    expect(() => validateEntityReplica({
      ...replica,
      jSubmitState: {
        jurisdictionName: 'Testnet',
        batchHash: `0x${'12'.repeat(32)}`,
        entityNonce: 1,
        batchGeneration: 1,
        submitAttempts: 1,
        lastSubmittedAt: 100,
        terminalFailure: {
          message: 'terminal',
          failedAt: 101,
          failure: {
            category: 'Contradiction',
            code: 'J_SUBMIT_FATAL',
            message: 'terminal',
            retryable: true,
            fatal: true,
          },
        },
      },
    })).toThrow('must be canonical RuntimeFailureSignal');

    expect(() => validateEntityReplica({
      ...replica,
      entityProviderActionSubmitState: {
        jurisdictionName: 'Testnet',
        actionHash: `0x${'34'.repeat(32)}`,
        actionNonce: 1n,
        generation: 1,
        submitAttempts: 1,
        lastSubmittedAt: 100,
        resultFingerprints: { attempt1: 'fingerprint1' },
        resultFingerprintOrder: ['attempt2'],
      },
    })).toThrow('contains unknown attempt2');
  });

  test('Entity input fork shares frame State but isolates mutable envelope maps', () => {
    const replica = {
      ...makeProjectionReplica(),
      mempool: [],
      candidate: {
        frameHash: `0x${'ab'.repeat(32)}`,
        height: 1,
        state: makeProjectionReplica().state,
        outputs: [],
        jOutputs: [],
        hashesToSign: [],
        candidateEffects: [],
        storageChanges: [],
      },
      hankoWitness: new Map([[
        `0x${'cd'.repeat(32)}`,
        {
          hanko: '0x01',
          type: 'profile',
          entityHeight: 1,
          createdAt: 1,
        },
      ]]),
      htlcNotes: new Map([['hashlock:0x01', 'private invoice']]),
    } as any;

    const fork = forkEntityReplicaForInput(replica);
    fork.hankoWitness!.clear();
    fork.htlcNotes!.set('lock:0x02', 'second invoice');

    expect(fork).not.toBe(replica);
    expect(fork.state).toBe(replica.state);
    expect(fork.candidate).toBe(replica.candidate);
    expect(fork.mempool).not.toBe(replica.mempool);
    expect(replica.hankoWitness.size).toBe(1);
    expect(fork.htlcNotes).not.toBe(replica.htlcNotes);
    expect(replica.htlcNotes.has('lock:0x02')).toBe(false);
    expect(fork.htlcNotes.get('hashlock:0x01')).toBe('private invoice');
  });

  test('runtime frame snapshot fails fast with the non-cloneable field path', () => {
    for (const absentField of ['deferredAccountProposals'] as const) {
      const replica = { ...makeProjectionReplica(), mempool: [] } as any;
      const account = makeCanonicalAccountFixture() as any;
      delete account.uncloneable;
      account.provider = { getBlockNumber: () => 1 };
      putCommittedAccount(replica.state, TEST_RIGHT_ENTITY_ID, account);
      delete replica.state[absentField];

      expect(() => encodeBuffer(buildCanonicalEntityReplicaSnapshot(replica)))
        .toThrow();
    }
  });

  test('Entity candidate isolates only claimed cross-j leaves', () => {
    const state = makeProjectionReplica().state as any;
    state.crossJurisdictionSwaps = new Map([['order-1', makeCrossJurisdictionRoute()]]);
    state.pendingCrossJurisdictionFillAcks = new Map([[
      'ack-1',
      {
        accountId: 'account-1',
        tx: {
          type: 'cross_swap_fill_ack',
          data: {
            offerId: 'order-1',
            fillSeq: 1,
            cumulativeFillRatio: 10,
            fillNumerator: 1n,
            fillDenominator: 2n,
          },
        },
        storedAt: 1,
        reason: 'test',
      },
    ]]);

    const candidate = createEntityFrameCandidateState(state);
    const route = getEntityCollectionValueForWrite(candidate.crossJurisdictionSwaps!, 'order-1');
    const pending = getEntityCollectionValueForWrite(candidate.pendingCrossJurisdictionFillAcks!, 'ack-1');
    if (!route || !pending) throw new Error('TEST_ENTITY_CANDIDATE_CROSS_J_LEAF_MISSING');
    route.source.amount = 999n;
    (pending.tx as any).data.fillNumerator = 999n;

    expect(state.crossJurisdictionSwaps.get('order-1').source.amount).toBe(100n);
    expect(state.pendingCrossJurisdictionFillAcks.get('ack-1').tx.data.fillNumerator).toBe(1n);
  });
});
