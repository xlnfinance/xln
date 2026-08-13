import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { cloneAccountReplica } from '../../../account/state/state-clone';
import {
  cloneEntityReplica,
  forkEntityReplicaForInput,
} from '../../../entity/replica/replica-clone';
import {
  cloneEntityState,
  cloneTrustedEntityState,
  commitEntityFrameCandidateState,
  createEntityFrameCandidateState,
} from '../../../entity/state-clone';
import {
  commitEntityAccountCandidate,
  EntityAccountCandidateMap,
} from '../../../entity/state/candidate-map';
import {
  computeCanonicalEntityConsensusStateHash,
  computeCanonicalEntityConsensusStateHashCold,
} from '../../../entity/consensus/state-root';
import {
  applyRuntimeOwnedEntityFrame,
} from '../../../entity/consensus/frame/application';
import { materializeEntityInfraContext } from '../../../entity/consensus/proposal/infra-context';
import { applyEntityFrameWithMaterializedTestInfraContext } from '../../helpers/entity-frame';
import { EntityCandidateMap } from '../../../entity/state/candidate-map';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import {
  applyCommand,
  createBook,
  createOrderbookExtState,
} from '../../../orderbook';
import { buildCanonicalEntityReplicaSnapshot } from '../../../storage/wal/snapshot';
import { validateConsensusConfig } from '../../../entity/consensus/config-validation';
import { validateEntityReplica } from '../../../entity/replica/replica-validation';
import { createEmptyEnv } from '../../../runtime';
import type { AccountReplica } from '../../../types/account';
import type { EntityState } from '../../../entity/types';

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
    deltas: new Map([[1, {
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
    locks: new Map(),
    swapOffers: new Map([['offer-1', {
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
    pulls: new Map(),
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
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
  pendingSignatures: [],
  rollbackCount: 0,
  proofHeader: { fromEntity: 'left', toEntity: 'right', nextProofNonce: 0 },
  proofBody: { tokenIds: [1], deltas: [0n] },
  pendingWithdrawals: new Map(),
  swapOrderHistory: new Map(),
  swapClosedOrders: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
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
    accounts: new Map(),
    deferredAccountProposals: new Map(),
    lastFinalizedJHeight: 0,
    jBlockChain: [],
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
    account.state.leftEntity = source.entityId;
    account.state.rightEntity = counterpartyId;
    source.accounts.set(counterpartyId, account);

    const candidate = createEntityFrameCandidateState(source);
    expect(candidate.accounts).toBeInstanceOf(EntityAccountCandidateMap);
    expect((candidate.accounts as EntityAccountCandidateMap).stats()).toEqual({
      base: 1,
      changed: 0,
      deleted: 0,
    });

    const candidateAccount = candidate.accounts.get(counterpartyId);
    if (!candidateAccount) throw new Error('TEST_ENTITY_CANDIDATE_ACCOUNT_MISSING');
    candidateAccount.state.deltas.get(1)!.collateral = 99n;

    expect(source.accounts.get(counterpartyId)?.state.deltas.get(1)?.collateral).toBe(0n);
    expect((candidate.accounts as EntityAccountCandidateMap).stats().changed).toBe(1);
  });

  test('Entity root projection never claims untouched Accounts for mutation', () => {
    const source = makeProjectionReplica().state as EntityState;
    for (const byte of ['b1', 'b2', 'b3']) {
      const counterpartyId = `0x${byte.repeat(32)}`;
      const accountFixture = makeCanonicalAccountFixture();
      delete accountFixture.uncloneable;
      const account = accountFixture as unknown as AccountReplica;
      account.state.leftEntity = source.entityId;
      account.state.rightEntity = counterpartyId;
      source.accounts.set(counterpartyId, account);
    }

    const sourceRoot = computeCanonicalEntityConsensusStateHashCold(source);
    const candidate = createEntityFrameCandidateState(source);
    const accounts = candidate.accounts as EntityAccountCandidateMap;
    expect(accounts.stats().changed).toBe(0);
    expect(computeCanonicalEntityConsensusStateHash(candidate)).toBe(sourceRoot);
    expect(computeCanonicalEntityConsensusStateHashCold(candidate)).toBe(sourceRoot);
    expect(accounts.stats().changed).toBe(0);

    const touchedId = `0x${'b2'.repeat(32)}`;
    candidate.accounts.get(touchedId)!.state.deltas.get(1)!.collateral = 7n;
    expect(accounts.stats().changed).toBe(1);
    const incremental = computeCanonicalEntityConsensusStateHash(candidate);
    expect(incremental).toBe(computeCanonicalEntityConsensusStateHashCold(candidate));
    expect(accounts.stats().changed).toBe(1);
  });

  test('Entity Account candidate preserves the full-clone root and promotes only at commit', () => {
    const source = makeProjectionReplica().state as EntityState;
    const counterpartyId = `0x${'cc'.repeat(32)}`;
    const accountFixture = makeCanonicalAccountFixture();
    delete accountFixture.uncloneable;
    const account = accountFixture as unknown as AccountReplica;
    account.state.leftEntity = source.entityId;
    account.state.rightEntity = counterpartyId;
    source.accounts.set(counterpartyId, account);

    const fullClone = cloneTrustedEntityState(source);
    const candidate = createEntityFrameCandidateState(source);
    const fullAccount = fullClone.accounts.get(counterpartyId);
    const candidateAccount = candidate.accounts.get(counterpartyId);
    if (!fullAccount || !candidateAccount) {
      throw new Error('TEST_ENTITY_CANDIDATE_ACCOUNT_MISSING');
    }
    fullAccount.state.deltas.get(1)!.offdelta = 25n;
    candidateAccount.state.deltas.get(1)!.offdelta = 25n;

    expect(computeCanonicalEntityConsensusStateHash(candidate))
      .toBe(computeCanonicalEntityConsensusStateHash(fullClone));
    expect(source.accounts.get(counterpartyId)?.state.deltas.get(1)?.offdelta).toBe(0n);

    candidate.accounts = commitEntityAccountCandidate(candidate.accounts);
    expect(candidate.accounts).toBe(source.accounts);
    expect(source.accounts.get(counterpartyId)?.state.deltas.get(1)?.offdelta).toBe(25n);
  });

  test('a planner flattens a prior candidate without linking commit to certified state', () => {
    const source = makeProjectionReplica().state as EntityState;
    const counterpartyId = `0x${'cd'.repeat(32)}`;
    const accountFixture = makeCanonicalAccountFixture();
    delete accountFixture.uncloneable;
    const account = accountFixture as unknown as AccountReplica;
    account.state.leftEntity = source.entityId;
    account.state.rightEntity = counterpartyId;
    source.accounts.set(counterpartyId, account);

    const first = createEntityFrameCandidateState(source);
    first.accounts.get(counterpartyId)!.state.deltas.get(1)!.collateral = 11n;
    const second = createEntityFrameCandidateState(first);
    second.accounts.get(counterpartyId)!.state.deltas.get(1)!.collateral = 22n;
    second.accounts = commitEntityAccountCandidate(second.accounts);

    expect(source.accounts.get(counterpartyId)?.state.deltas.get(1)?.collateral).toBe(0n);
    expect(first.accounts.get(counterpartyId)?.state.deltas.get(1)?.collateral).toBe(11n);
    expect(second.accounts.get(counterpartyId)?.state.deltas.get(1)?.collateral).toBe(22n);
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

    const fullClone = cloneTrustedEntityState(source);
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
      const book = state.orderbookExt?.books.get(firstPair);
      if (!book) throw new Error('TEST_ENTITY_CANDIDATE_BOOK_MISSING');
      applyCommand(book, {
        kind: 0,
        ownerId: source.entityId,
        orderId: 'projection-order',
        side: 1,
        tif: 0,
        postOnly: false,
        priceTicks: 1_000n,
        qtyLots: 10n,
      });
    };
    addOrder(fullClone);
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
      .toBe(computeCanonicalEntityConsensusStateHash(fullClone));

    commitEntityFrameCandidateState(candidate);
    expect(candidate.orderbookExt?.books).toBe(source.orderbookExt.books);
    expect(source.orderbookExt.books.get(firstPair)?.orders.size).toBe(1);
    expect(source.orderbookExt.books.get(secondPair)?.orders.size).toBe(0);
  });

  test('single-signer Runtime ownership skips the Entity candidate shell', async () => {
    const env = createEmptyEnv('single-signer owned Entity frame');
    env.state.timestamp = 2;
    const isolatedSource = makeProjectionReplica().state as EntityState;
    const ownedSource = cloneTrustedEntityState(isolatedSource);

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
    }, []);
    const owned = await applyRuntimeOwnedEntityFrame(
      env,
      ownedSource,
      ownedContext,
      [],
      env.state.timestamp,
    );

    expect(isolatedSource.timestamp).toBe(1);
    expect(isolated.newState.accounts).toBeInstanceOf(EntityAccountCandidateMap);
    expect(ownedSource.timestamp).toBe(env.state.timestamp);
    expect(owned.newState.accounts).toBe(ownedSource.accounts);
    expect(owned.newState.accounts).not.toBeInstanceOf(EntityAccountCandidateMap);
    expect(computeCanonicalEntityConsensusStateHash(owned.newState))
      .toBe(computeCanonicalEntityConsensusStateHash(isolated.newState));
  });

  test('trusted same-Runtime cascades do not reuse the external replay context', async () => {
    const env = createEmptyEnv('same-Runtime replay context isolation');
    const replica = makeProjectionReplica();
    const persisted = await materializeEntityInfraContext(env, replica, [], {
      usePersistedReplayContext: false,
    });
    env.infrastructure.replayEntityContexts = new Map([
      [`${replica.entityId}:${replica.signerId}`, persisted],
    ]);
    replica.state.height += 1;
    replica.state.prevFrameHash = `0x${'99'.repeat(32)}`;

    const internal = await materializeEntityInfraContext(env, replica, [], {
      usePersistedReplayContext: false,
    });

    expect(persisted.height).toBe(1);
    expect(internal.height).toBe(2);
    expect(internal).not.toEqual(persisted);
  });

  test('clone diagnostics use structured logging only', () => {
    const source = [
      readFileSync('runtime/account/state/state-clone.ts', 'utf8'),
      readFileSync('runtime/entity/state-clone.ts', 'utf8'),
    ].join('\n');

    expect(source).toContain(
      "const cloneLog = createStructuredLogger('entity.state_clone');",
    );
    expect(source).toContain("cloneLog.error('entity_id_corrupt'");
    expect(source).toContain("cloneLog.error('last_finalized_j_height_corrupt'");
    expect(source).toContain('ACCOUNT_STATE_STRUCTURED_CLONE_FAILED');
    expect(source).not.toContain('manualClone');
    expect(source).not.toContain('console.');
  });

  test('entity state clone fails loudly when j-height is corrupt', () => {
    const corruptState = makeProjectionReplica().state as any;
    corruptState.lastFinalizedJHeight = undefined;

    expect(() => cloneEntityState(corruptState)).toThrow('lastFinalizedJHeight was not preserved');
  });

  test('entity clone preserves aliased cross-j route carriers from original state', () => {
    const state = makeProjectionReplica().state as any;
    state.entityId = 'left';
    const route = makeCrossJurisdictionRoute();
    const account = makeCanonicalAccountFixture() as any;
    delete account.uncloneable;
    account.state.swapOffers = new Map([[
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
    state.accounts.set('right', account);

    const cloned = cloneEntityState(state);
    const clonedRoute = cloned.crossJurisdictionSwaps!.get(route.orderId)!;
    const clonedOfferRoute = cloned.accounts.get('right')!.state.swapOffers.get(route.orderId)!.crossJurisdiction!;

    expect(clonedRoute).not.toBe(route);
    expect(clonedOfferRoute).not.toBe(route);
    expect(clonedRoute.source).toEqual(route.source);
    expect(clonedRoute.target).toEqual(route.target);
    expect(clonedOfferRoute.source).toEqual(route.source);
    expect(clonedOfferRoute.target).toEqual(route.target);
  });

  test('rejects non-canonical and mismatched Account map keys at the Entity boundary', () => {
    const state = makeProjectionReplica().state as any;
    state.entityId = 'left';
    const account = makeCanonicalAccountFixture() as any;
    delete account.uncloneable;

    state.accounts = new Map([['RIGHT', account]]);
    expect(() => cloneEntityState(state)).toThrow(
      'non-canonical counterparty key',
    );

    state.accounts = new Map([['other', account]]);
    expect(() => cloneEntityState(state)).toThrow(
      'counterparty key does not match Account participants',
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

  test('clones projection-shaped replicas without a transient mempool', () => {
    const cloned = cloneEntityReplica(makeProjectionReplica() as any);
    expect(cloned.mempool).toEqual([]);
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

  test('clones local Hanko witnesses without losing or aliasing committed proofs', () => {
    const replica = { ...makeProjectionReplica(), mempool: [] } as any;
    const hash = `0x${'ab'.repeat(32)}`;
    replica.hankoWitness = new Map([[hash, {
      hanko: '0x01',
      type: 'profile',
      entityHeight: 7,
      createdAt: 123,
    }]]);

    const cloned = cloneEntityReplica(replica);
    const clonedWitness = cloned.hankoWitness?.get(hash);
    if (!clonedWitness) throw new Error('TEST_CLONED_HANKO_WITNESS_MISSING');
    clonedWitness.createdAt = 456;

    expect(cloned.hankoWitness).not.toBe(replica.hankoWitness);
    expect(replica.hankoWitness.get(hash)?.createdAt).toBe(123);
  });

  test('runtime frame snapshot fails fast with the non-cloneable field path', () => {
    for (const absentField of ['deferredAccountProposals'] as const) {
      const replica = { ...makeProjectionReplica(), mempool: [] } as any;
      const account = makeCanonicalAccountFixture() as any;
      delete account.uncloneable;
      account.provider = { getBlockNumber: () => 1 };
      replica.state.accounts.set('left', account);
      delete replica.state[absentField];

      expect(() => buildCanonicalEntityReplicaSnapshot(replica))
        .toThrow('ENTITY_STATE_STRUCTURED_CLONE_FAILED:path=$.accounts.<map-value:0>.provider.getBlockNumber');
    }
  });

  test('clones validator-private J history without aliasing durable evidence', () => {
    const replica = makeProjectionReplica() as any;
    replica.jHistory = {
      jurisdictionRef: 'testnet:1',
      scannedThroughHeight: 12,
      contiguousThroughHeight: 0,
      tipBlockHash: `0x${'12'.repeat(32)}`,
      eventBlocks: new Map([[12, {
        jurisdictionRef: 'testnet:1',
        jHeight: 12,
        jBlockHash: `0x${'12'.repeat(32)}`,
        eventsHash: `0x${'34'.repeat(32)}`,
        events: [],
      }]]),
      blockHashes: new Map([[12, `0x${'12'.repeat(32)}`]]),
    };

    const cloned = cloneEntityReplica(replica);
    cloned.jHistory!.eventBlocks.get(12)!.eventsHash = `0x${'ff'.repeat(32)}`;
    cloned.jHistory!.blockHashes.set(13, `0x${'13'.repeat(32)}`);

    expect(replica.jHistory.eventBlocks.get(12).eventsHash).toBe(`0x${'34'.repeat(32)}`);
    expect(replica.jHistory.blockHashes.has(13)).toBe(false);
  });

  test('account clone fails fast instead of normalizing non-cloneable state', () => {
    const account = {
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
      deltas: new Map(),
      locks: new Map(),
      swapOffers: new Map(),
      pulls: new Map(),
      shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
      uncloneable: () => undefined,
    } as any;

    expect(() => cloneAccountReplica(account))
      .toThrow('ACCOUNT_STATE_STRUCTURED_CLONE_FAILED:path=$.uncloneable');
  });

  test('account clones preserve absence of optional pulls consensus state', () => {
    const account = makeCanonicalAccountFixture() as any;
    delete account.state.pulls;
    delete account.uncloneable;

    const cloned = cloneAccountReplica(account);

    expect(Object.hasOwn(cloned, 'pulls')).toBe(false);
  });

  test('account clone isolates mempool, dispute evidence, and cross-j routes', () => {
    const account = makeCanonicalAccountFixture();
    delete (account as Record<string, unknown>).uncloneable;
    const cloned = cloneAccountReplica(account as any);

    (cloned.mempool[0] as any).data.amount = 999n;
    (cloned.disputeProofBodiesByHash as any).proof.offdeltas[0] = 999n;
    (cloned.disputeArgumentSnapshotsByHash as any).proof.plan.paymentHashlocks.push('hashlock-2');
    (cloned.state.swapOffers.get('offer-1') as any).crossJurisdiction.source.amount = 999n;

    expect((account.mempool[0] as any).data.amount).toBe(10n);
    expect((account.disputeProofBodiesByHash as any).proof.offdeltas).toEqual([1n]);
    expect((account.disputeArgumentSnapshotsByHash as any).proof.plan.paymentHashlocks).toEqual(['hashlock-1']);
    expect((account.state.swapOffers.get('offer-1') as any).crossJurisdiction.source.amount).toBe(100n);
  });

  test('entity clone isolates pending cross-j fill ack tx data', () => {
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

    const cloned = cloneEntityState(state);
    cloned.crossJurisdictionSwaps!.get('order-1')!.source.amount = 999n;
    (cloned.pendingCrossJurisdictionFillAcks!.get('ack-1')!.tx as any).data.fillNumerator = 999n;

    expect(state.crossJurisdictionSwaps.get('order-1').source.amount).toBe(100n);
    expect(state.pendingCrossJurisdictionFillAcks.get('ack-1').tx.data.fillNumerator).toBe(1n);
  });
});
