import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { cloneAccountMachine, cloneEntityReplica, cloneEntityState } from '../state-helpers';
import { validateConsensusConfig, validateEntityReplica } from '../validation-utils';

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
  sourcePull: {
    pullId: 'source-pull',
    tokenId: 1,
    amount: 100n,
    signedAmount: 100n,
    revealedUntilTimestamp: 1_700_000_000,
    fullHash: `0x${'bb'.repeat(32)}`,
    partialRoot: `0x${'cc'.repeat(32)}`,
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

const makeManualFallbackAccount = () => ({
  leftEntity: 'left',
  rightEntity: 'right',
  watchSeed: `0x${'11'.repeat(32)}`,
  status: 'active',
  mempool: [{
    type: 'direct_payment',
    data: { tokenId: 1, amount: 10n, nested: { memo: 'original' } },
  }],
  currentFrame: {
    height: 0,
    timestamp: 0,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: 'genesis',
    stateHash: 'genesis',
    accountStateRoot: `0x${'00'.repeat(32)}`,
    byLeft: true,
    deltas: [],
  },
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
    crossJurisdiction: makeCrossJurisdictionRoute(),
  }]]),
  pulls: new Map(),
  globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
  currentHeight: 0,
  pendingSignatures: [],
  rollbackCount: 0,
  leftJObservations: [],
  rightJObservations: [],
  jEventChain: [],
  lastFinalizedJHeight: 0,
  proofHeader: { fromEntity: 'left', toEntity: 'right', nextProofNonce: 0 },
  proofBody: { tokenIds: [1], deltas: [0n] },
  disputeConfig: {},
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
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
      appliedSwapFillFingerprints: ['fill-1'],
    },
  },
  uncloneable: () => undefined,
});

const makeProjectionReplica = () => ({
  entityId: `0x${'aa'.repeat(32)}`,
  signerId: `0x${'11'.repeat(20)}`,
  isProposer: false,
  state: {
    entityId: `0x${'aa'.repeat(32)}`,
    height: 0,
    timestamp: 1,
    nonces: new Map(),
    messages: [],
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
    jBlockObservations: [],
    jBlockChain: [],
    entityEncPubKey: '',
    entityEncPrivKey: '',
    profile: { name: 'Projection', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
    swapTradingPairs: [],
    pendingSwapFillRatios: new Map(),
  },
});

describe('state helper cloning', () => {
  test('state helper diagnostics use structured logging only', () => {
    const source = readFileSync('runtime/state-helpers.ts', 'utf8');

    expect(source).toContain("const stateHelperLog = createStructuredLogger('state.helpers');");
    expect(source).toContain("stateHelperLog.error('clone.entity_state.entity_id_corrupt'");
    expect(source).toContain("stateHelperLog.error('clone.entity_state.last_finalized_j_height_corrupt'");
    expect(source).toContain("stateHelperLog.debug('clone.account_machine.structured_clone_failed'");
    expect(source).not.toContain('console.');
  });

  test('entity state clone fails loudly when j-height is corrupt', () => {
    const corruptState = makeProjectionReplica().state as any;
    corruptState.lastFinalizedJHeight = undefined;

    expect(() => cloneEntityState(corruptState)).toThrow('lastFinalizedJHeight was not preserved');
  });

  test('entity clone preserves aliased cross-j route carriers from original state', () => {
    const state = makeProjectionReplica().state as any;
    const route = makeCrossJurisdictionRoute();
    const account = makeManualFallbackAccount() as any;
    account.swapOffers = new Map([[
      route.orderId,
      {
        offerId: route.orderId,
        crossJurisdiction: route,
      },
    ]]);
    state.crossJurisdictionSwaps = new Map([[route.orderId, route]]);
    state.accounts.set('source', account);

    const cloned = cloneEntityState(state);
    const clonedRoute = cloned.crossJurisdictionSwaps!.get(route.orderId)!;
    const clonedOfferRoute = cloned.accounts.get('source')!.swapOffers.get(route.orderId)!.crossJurisdiction!;

    expect(clonedRoute).not.toBe(route);
    expect(clonedOfferRoute).not.toBe(route);
    expect(clonedRoute.source).toEqual(route.source);
    expect(clonedRoute.target).toEqual(route.target);
    expect(clonedOfferRoute.source).toEqual(route.source);
    expect(clonedOfferRoute.target).toEqual(route.target);
  });

  test('validates consensus config quorum shape', () => {
    expect(validateConsensusConfig({
      mode: 'proposer-based',
      threshold: 2n,
      validators: ['alice', 'bob'],
      shares: { alice: 1n, bob: 1n },
    })).toMatchObject({ threshold: 2n });

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

    const mismatched = {
      ...replica,
      state: {
        ...replica.state,
        entityId: `0x${'bb'.repeat(32)}`,
      },
    };

    expect(() => validateEntityReplica(mismatched)).toThrow('state.entityId must match replica.entityId');
  });

  test('clones projection-shaped replicas without a transient mempool', () => {
    const cloned = cloneEntityReplica(makeProjectionReplica() as any);
    expect(cloned.mempool).toEqual([]);
  });

  test('manual account clone fallback normalizes missing mempool', () => {
    const cloned = cloneAccountMachine({
      currentFrame: {
        height: 0,
        timestamp: 0,
        jHeight: 0,
        accountTxs: [],
        prevFrameHash: 'genesis',
        stateHash: 'genesis',
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
    } as any);

    expect(cloned.mempool).toEqual([]);
  });

  test('manual account clone fallback isolates mempool, dispute evidence, and cross-j routes', () => {
    const account = makeManualFallbackAccount();
    const cloned = cloneAccountMachine(account as any);

    (cloned.mempool[0] as any).data.nested.memo = 'mutated';
    (cloned.disputeProofBodiesByHash as any).proof.offdeltas[0] = 999n;
    (cloned.disputeArgumentSnapshotsByHash as any).proof.plan.paymentHashlocks.push('hashlock-2');
    (cloned.swapOffers.get('offer-1') as any).crossJurisdiction.source.amount = 999n;

    expect((account.mempool[0] as any).data.nested.memo).toBe('original');
    expect((account.disputeProofBodiesByHash as any).proof.offdeltas).toEqual([1n]);
    expect((account.disputeArgumentSnapshotsByHash as any).proof.plan.paymentHashlocks).toEqual(['hashlock-1']);
    expect((account.swapOffers.get('offer-1') as any).crossJurisdiction.source.amount).toBe(100n);
  });

  test('manual entity clone fallback isolates pending cross-j fill ack tx data', () => {
    const state = makeProjectionReplica().state as any;
    state.uncloneable = () => undefined;
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
