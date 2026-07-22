import { expect, test } from 'bun:test';

import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeCanonicalEntityConsensusStateHashCold,
  computeEntityFrameAuthorityRoot,
  encodeCanonicalEntityConsensusValue,
  ENTITY_CONSENSUS_STATE_FIELDS,
  ENTITY_STATE_ROOT_EXCLUDED_FIELDS,
  invalidateEntityAccountCommitment,
} from '../entity/consensus/state-root';
import { createEntityFrameHash } from '../entity/consensus/frame';
import type { EntityState } from '../types';

const entityId = `0x${'11'.repeat(32)}`;
const counterpartyId = `0x${'22'.repeat(32)}`;

const baseState = (): EntityState => ({
  entityId,
  height: 1,
  timestamp: 100,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: { mode: 'proposer-based', threshold: 1n, validators: ['1'], shares: { '1': 1n } },
  reserves: new Map(),
  accounts: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  certifiedBoardState: {
    stackKey: `0x${'01'.repeat(32)}`,
    boardRegistryRoot: `0x${'02'.repeat(32)}`,
    finalizedJHeight: 1,
    finalizedJBlockHash: `0x${'03'.repeat(32)}`,
    eventHistoryRoot: `0x${'04'.repeat(32)}`,
  },
  entityEncPubKey: 'validator-local-pub-a',
  entityEncPrivKey: 'validator-local-priv-a',
  profile: { name: 'state-root', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
});

type StateMutator = (state: EntityState) => void;

const mutators = {
  entityId: state => { state.entityId = `0x${'33'.repeat(32)}`; },
  height: state => { state.height = 2; },
  timestamp: state => { state.timestamp = 101; },
  nonces: state => { state.nonces.set('alice', 1); },
  entityCommandNonces: state => { state.entityCommandNonces = {
    version: 2,
    boardHash: `0x${'12'.repeat(32)}`,
    boardEpoch: 0,
    bySigner: new Map([['1', { nonce: 1n, commandHash: `0x${'13'.repeat(32)}` }]]),
  }; },
  messages: state => { state.messages.push('committed-message'); },
  proposals: state => { state.proposals.set('proposal', { provider: 'nested-consensus-value' } as never); },
  config: state => { state.config.threshold = 2n; },
  prevFrameHash: state => { state.prevFrameHash = `0x${'44'.repeat(32)}`; },
  leaderState: state => { state.leaderState = { activeValidatorId: '2', view: 1, changedAtHeight: 1 }; },
  reserves: state => { state.reserves.set(1, 10n); },
  accounts: state => {
    state.accounts.set(counterpartyId, { status: 'active', mempool: [], pendingWithdrawals: new Map() } as never);
  },
  externalWallet: state => { state.externalWallet = { balances: new Map(), allowances: new Map() }; },
  deferredAccountProposals: state => {
    state.deferredAccountProposals = new Map([[counterpartyId, `0x${'34'.repeat(32)}`]]);
  },
  lastFinalizedJHeight: state => { state.lastFinalizedJHeight = 9; },
  jBlockChain: state => { state.jBlockChain.push({ jHeight: 9, jBlockHash: `0x${'55'.repeat(32)}`, eventsHash: `0x${'66'.repeat(32)}` }); },
  jHistoryFinality: state => { state.jHistoryFinality = { scannedThroughHeight: 9, tipBlockHash: `0x${'55'.repeat(32)}`, eventHistoryRoot: `0x${'66'.repeat(32)}` }; },
  certifiedBoardState: state => { state.certifiedBoardState!.boardRegistryRoot = `0x${'77'.repeat(32)}`; },
  accountInputQueue: state => { state.accountInputQueue = [{ kind: 'ack' } as never]; },
  crontabState: state => { state.crontabState = { marker: 'cron' } as never; },
  jBatchState: state => { state.jBatchState = { marker: 'jbatch' } as never; },
  entityProviderActionState: state => { state.entityProviderActionState = {
    version: 1,
    confirmedNonce: 1n,
    generation: 1,
  }; },
  batchHistory: state => { state.batchHistory = [{ marker: 'batch-history' } as never]; },
  entityEncPubKey: state => { state.entityEncPubKey = 'validator-local-pub-b'; },
  entityEncPrivKey: state => { state.entityEncPrivKey = 'validator-local-priv-b'; },
  profileEncryptionManifest: state => { state.profileEncryptionManifest = {
    entityId,
    threshold: 1,
    attestations: [{
      version: 'xln:validator-encryption-key:v1',
      entityId,
      signer: '0x0000000000000000000000000000000000000001',
      signerId: '1',
      weight: 1,
      publicKey: `0x${'77'.repeat(32)}`,
      encryptionPublicKey: `0x${'99'.repeat(32)}`,
      signature: `0x${'11'.repeat(65)}`,
    }],
    hash: `0x${'88'.repeat(32)}`,
  }; },
  profile: state => { state.profile.bio = 'consensus-profile'; },
  htlcRoutes: state => { state.htlcRoutes.set('route', { marker: 'route' } as never); },
  htlcFeesEarned: state => { state.htlcFeesEarned = 1n; },
  htlcNotes: state => { state.htlcNotes = new Map([['note' as never, 'validator-local-note']]); },
  consumptionAccumulator: state => { state.consumptionAccumulator = {
    version: 2,
    root: `0x${'ab'.repeat(32)}`,
    count: 1n,
  }; },
  certifiedOutputSequences: state => { state.certifiedOutputSequences = new Map([[
    counterpartyId,
    { lastSequence: 1n, lastSemanticHash: `0x${'bc'.repeat(32)}` },
  ]]); },
  outDebtsByToken: state => { state.outDebtsByToken = new Map([[1, new Map([[counterpartyId, { marker: 'out-debt' } as never]])]]); },
  inDebtsByToken: state => { state.inDebtsByToken = new Map([[1, new Map([[counterpartyId, { marker: 'in-debt' } as never]])]]); },
  orderbookExt: state => { state.orderbookExt = {
    books: new Map(),
    orderPairs: new Map(),
    referrals: new Map(),
    hubProfile: { marker: 'orderbook' },
  } as never; },
  lockBook: state => { state.lockBook.set('lock', { marker: 'lock' } as never); },
  swapTradingPairs: state => { state.swapTradingPairs = [{ baseTokenId: 1, quoteTokenId: 2, pairId: '1:2' }]; },
  crossJurisdictionSwaps: state => { state.crossJurisdictionSwaps = new Map([['swap', { marker: 'cross-swap' } as never]]); },
  pendingCrossJurisdictionFillAcks: state => { state.pendingCrossJurisdictionFillAcks = new Map([['ack', { marker: 'cross-ack' } as never]]); },
  crossJurisdictionBookAdmissions: state => { state.crossJurisdictionBookAdmissions = new Map([['admission', { marker: 'cross-admission' } as never]]); },
  hubRebalanceConfig: state => { state.hubRebalanceConfig = { marker: 'rebalance' } as never; },
  lending: state => { state.lending = { marker: 'lending' } as never; },
} satisfies Record<keyof EntityState, StateMutator>;

const stateRootExcludedFields = new Set<keyof EntityState>(ENTITY_STATE_ROOT_EXCLUDED_FIELDS);

test('Entity consensus root covers every shared EntityState field', () => {
  expect(Object.keys(mutators).sort()).toEqual([...ENTITY_CONSENSUS_STATE_FIELDS].sort());
  const baseline = computeCanonicalEntityConsensusStateHash(baseState());
  for (const [field, mutate] of Object.entries(mutators) as Array<[keyof EntityState, StateMutator]>) {
    const changed = baseState();
    mutate(changed);
    const actual = computeCanonicalEntityConsensusStateHash(changed);
    if (stateRootExcludedFields.has(field)) expect(actual, field).toBe(baseline);
    else expect(actual, field).not.toBe(baseline);
  }
});

test('bounded J event bodies are a deletable display cache, not consensus authority', () => {
  const withDisplayBody = baseState();
  withDisplayBody.jBlockChain = [{
    jurisdictionRef: 'evm:31337',
    jHeight: 9,
    jBlockHash: `0x${'55'.repeat(32)}`,
    eventsHash: `0x${'66'.repeat(32)}`,
    events: [],
  }];
  const withoutDisplayBody = structuredClone(withDisplayBody);
  withoutDisplayBody.jBlockChain = [];

  expect(computeCanonicalEntityConsensusStateHash(withDisplayBody))
    .toBe(computeCanonicalEntityConsensusStateHash(withoutDisplayBody));
});

test('Entity commitments exclude validator-local jurisdiction locators but bind stack identity and policy', () => {
  const left = baseState();
  left.config.jurisdiction = {
    name: 'local display name A',
    address: 'http://127.0.0.1:18545',
    chainId: 31_337,
    depositoryAddress: `0x${'ab'.repeat(20)}`,
    entityProviderAddress: `0x${'cd'.repeat(20)}`,
    registrationBlock: 17,
    entityProviderDeploymentBlock: 3,
    blockTimeMs: 1_000,
    rebalancePolicyUsd: {
      r2cRequestSoftLimit: 100,
      hardLimit: 200,
      maxFee: 5,
    },
  };
  const right = structuredClone(left);
  right.config.jurisdiction!.name = 'validator B label';
  right.config.jurisdiction!.address = 'http://127.0.0.1:28545';

  const stateRoot = computeCanonicalEntityConsensusStateHash(left);
  const authorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(left));
  expect(computeCanonicalEntityConsensusStateHash(right)).toBe(stateRoot);
  expect(computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(right))).toBe(authorityRoot);

  const mutateCanonical = [
    (state: EntityState) => { state.config.jurisdiction!.chainId = 31_338; },
    (state: EntityState) => { state.config.jurisdiction!.depositoryAddress = `0x${'ef'.repeat(20)}`; },
    (state: EntityState) => { state.config.jurisdiction!.entityProviderAddress = `0x${'01'.repeat(20)}`; },
    (state: EntityState) => { state.config.jurisdiction!.registrationBlock = 18; },
    (state: EntityState) => { state.config.jurisdiction!.entityProviderDeploymentBlock = 4; },
    (state: EntityState) => { state.config.jurisdiction!.blockTimeMs = 2_000; },
    (state: EntityState) => { state.config.jurisdiction!.rebalancePolicyUsd!.maxFee = 6; },
  ];
  for (const mutate of mutateCanonical) {
    const changed = structuredClone(left);
    mutate(changed);
    expect(computeCanonicalEntityConsensusStateHash(changed)).not.toBe(stateRoot);
    expect(computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(changed))).not.toBe(authorityRoot);
  }
});

test('Entity config commitment rejects unmodelled fields instead of silently omitting them', () => {
  const configExtension = baseState();
  (configExtension.config as unknown as Record<string, unknown>)['hiddenConsensusRule'] = true;
  expect(() => computeCanonicalEntityConsensusStateHash(configExtension))
    .toThrow('ENTITY_STATE_ROOT_EXTRA_PROPERTY:hiddenConsensusRule');

  const jurisdictionExtension = baseState();
  jurisdictionExtension.config.jurisdiction = {
    name: 'local',
    address: 'http://127.0.0.1:8545',
    chainId: 31_337,
    depositoryAddress: `0x${'ab'.repeat(20)}`,
    entityProviderAddress: `0x${'cd'.repeat(20)}`,
  };
  (jurisdictionExtension.config.jurisdiction as unknown as Record<string, unknown>)['consensusExtension'] = 1;
  expect(() => computeCanonicalEntityConsensusStateHash(jurisdictionExtension))
    .toThrow('ENTITY_STATE_ROOT_EXTRA_PROPERTY:consensusExtension');
});

test('Entity config commitment fails loudly when a jurisdiction stack identity is incomplete', () => {
  const incomplete = baseState();
  incomplete.config.jurisdiction = {
    name: 'local',
    address: 'http://127.0.0.1:8545',
    chainId: 31_337,
    depositoryAddress: `0x${'ab'.repeat(20)}`,
    entityProviderAddress: '',
  };
  expect(() => computeCanonicalEntityConsensusStateHash(incomplete))
    .toThrow('ENTITY_STATE_ROOT_JURISDICTION_FIELD_REQUIRED:entityProviderAddress');
});

test('Entity consensus root is insertion-order independent without recursive key blacklists', () => {
  const left = baseState();
  left.nonces = new Map([['b', 2], ['a', 1]]);
  left.proposals.set('nested', { provider: 'consensus-a' } as never);
  const right = baseState();
  right.nonces = new Map([['a', 1], ['b', 2]]);
  right.proposals.set('nested', { provider: 'consensus-a' } as never);

  expect(computeCanonicalEntityConsensusStateHash(left))
    .toBe(computeCanonicalEntityConsensusStateHash(right));
  (right.proposals.get('nested') as unknown as { provider: string }).provider = 'consensus-b';
  expect(computeCanonicalEntityConsensusStateHash(left))
    .not.toBe(computeCanonicalEntityConsensusStateHash(right));
});

test('Entity consensus root excludes only typed Account replica caches', () => {
  const left = baseState();
  const right = baseState();
  left.accounts.set(counterpartyId, {
    status: 'active',
    mempool: [],
    pendingWithdrawals: new Map(),
    frameHistory: [{ stateHash: 'left-cache' }],
    clonedForValidation: { status: 'left-clone' },
  } as never);
  right.accounts.set(counterpartyId, {
    status: 'active',
    mempool: [],
    pendingWithdrawals: new Map(),
    frameHistory: [{ stateHash: 'right-cache' }],
    clonedForValidation: { status: 'right-clone' },
  } as never);
  expect(computeCanonicalEntityConsensusStateHash(left))
    .toBe(computeCanonicalEntityConsensusStateHash(right));

  (right.accounts.get(counterpartyId) as unknown as { status: string }).status = 'disputed';
  invalidateEntityAccountCommitment(right, counterpartyId);
  expect(computeCanonicalEntityConsensusStateHash(left))
    .not.toBe(computeCanonicalEntityConsensusStateHash(right));

  (right.accounts.get(counterpartyId) as unknown as { status: string }).status = 'active';
  (right.accounts.get(counterpartyId) as unknown as Record<string, unknown>).boardResealMigration = {
    activationJHeight: 9,
    activationLogIndex: 2,
    reason: 'bilateral-frame-uncertified',
  };
  invalidateEntityAccountCommitment(right, counterpartyId);
  expect(computeCanonicalEntityConsensusStateHash(left))
    .not.toBe(computeCanonicalEntityConsensusStateHash(right));
});

test('Entity Account commitment cache has a cold oracle for missed invalidation', () => {
  const state = baseState();
  state.accounts.set(counterpartyId, {
    status: 'active',
    mempool: [],
    pendingWithdrawals: new Map(),
  } as never);
  const before = computeCanonicalEntityConsensusStateHash(state);
  (state.accounts.get(counterpartyId) as unknown as { status: string }).status = 'disputed';
  expect(computeCanonicalEntityConsensusStateHash(state)).toBe(before);
  expect(computeCanonicalEntityConsensusStateHashCold(state)).not.toBe(before);
  invalidateEntityAccountCommitment(state, counterpartyId);
  expect(computeCanonicalEntityConsensusStateHash(state))
    .toBe(computeCanonicalEntityConsensusStateHashCold(state));
});

test('Entity consensus root binds incremental book commitments but not the derived cancel index', () => {
  const makeOrderbookExt = () => ({
    books: new Map([['1/2', {
      params: { bucketWidthTicks: 100n, maxOrders: 10, stpPolicy: 1 },
      orders: new Map(),
      bidBuckets: new Map(),
      askBuckets: new Map(),
      bidBucketIdsDesc: [],
      askBucketIdsAsc: [],
      nextSeq: 1,
      tradeCount: 0,
      tradeQtySum: 0n,
      eventHash: 0n,
    }]]),
    orderPairs: new Map(),
    referrals: new Map(),
    hubProfile: {
      entityId,
      name: 'hub',
      spreadDistribution: {
        makerBps: 0,
        takerBps: 10_000,
        hubBps: 0,
        makerReferrerBps: 0,
        takerReferrerBps: 0,
      },
      referenceTokenId: 1,
      minTradeSize: 0n,
      supportedPairs: ['1/2'],
    },
  }) as NonNullable<EntityState['orderbookExt']>;

  const baseline = baseState();
  baseline.orderbookExt = makeOrderbookExt();
  const baselineRoot = computeCanonicalEntityConsensusStateHash(baseline);

  const derivedIndexOnly = structuredClone(baseline);
  derivedIndexOnly.orderbookExt!.orderPairs.set('account:offer', ['1/2']);
  expect(computeCanonicalEntityConsensusStateHash(derivedIndexOnly)).toBe(baselineRoot);

  const bookChanged = structuredClone(baseline);
  bookChanged.orderbookExt!.books.get('1/2')!.eventHash = 99n;
  delete bookChanged.orderbookExt!.books.get('1/2')!.commitmentHash;
  expect(computeCanonicalEntityConsensusStateHash(bookChanged)).not.toBe(baselineRoot);

  const referralChanged = structuredClone(baseline);
  referralChanged.orderbookExt!.referrals.set('referral', { marker: 'bound' } as never);
  expect(computeCanonicalEntityConsensusStateHash(referralChanged)).not.toBe(baselineRoot);

  const policyChanged = structuredClone(baseline);
  policyChanged.orderbookExt!.hubProfile.minTradeSize = 1n;
  expect(computeCanonicalEntityConsensusStateHash(policyChanged)).not.toBe(baselineRoot);
});

test('Entity consensus root strips only typed post-hash Account witnesses', () => {
  const makeAccount = (hanko: string, frameHash: string) => {
    const pendingFrame = {
      height: 1,
      timestamp: 100,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: `0x${'66'.repeat(32)}`,
      accountStateRoot: `0x${'55'.repeat(32)}`,
      stateHash: frameHash,
      deltas: [],
      byLeft: true,
    };
    return ({
    status: 'active',
    mempool: [],
    currentFrameHanko: hanko,
    counterpartyFrameHanko: hanko,
    currentDisputeProofHanko: hanko,
    counterpartyDisputeProofHanko: hanko,
    counterpartySettlementHanko: hanko,
    hankoSignature: hanko,
    pendingWithdrawals: new Map([['withdrawal', {
      requestId: 'withdrawal',
      tokenId: 1,
      amount: 1n,
      requestedAt: 100,
      direction: 'outgoing',
      status: 'approved',
      signature: hanko,
    }]]),
    pendingFrame,
    pendingAccountInput: {
      kind: 'frame',
      fromEntityId: entityId,
      toEntityId: counterpartyId,
      proposal: { frame: pendingFrame, frameHanko: hanko },
    },
    pendingAccountInputSignerId: 'target-signer',
    lastOutboundFrameAck: {
      height: 1,
      counterpartyEntityId: counterpartyId,
      response: {
        kind: 'ack',
        fromEntityId: entityId,
        toEntityId: counterpartyId,
        ack: { height: 1, frameHash, frameHanko: hanko },
      },
    },
    settlementWorkspace: {
      ops: [],
      leftHanko: hanko,
      rightHanko: hanko,
      settlementHash: `0x${'77'.repeat(32)}`,
      lastModifiedByLeft: true,
      status: 'ready_to_submit',
      version: 1,
      createdAt: 100,
      lastUpdatedAt: 100,
      executorIsLeft: true,
      postSettlementDisputeProof: {
        leftHanko: hanko,
        rightHanko: hanko,
        disputeHash: `0x${'88'.repeat(32)}`,
        proofBodyHash: `0x${'99'.repeat(32)}`,
        nonce: 1,
      },
    },
    });
  };
  const left = baseState();
  const right = baseState();
  const frameHash = `0x${'aa'.repeat(32)}`;
  left.accounts.set(counterpartyId, makeAccount('0xleft-witness', frameHash) as never);
  right.accounts.set(counterpartyId, makeAccount('0xright-witness', frameHash) as never);
  expect(computeCanonicalEntityConsensusStateHash(left))
    .toBe(computeCanonicalEntityConsensusStateHash(right));

  right.accounts.set(
    counterpartyId,
    makeAccount('0xright-witness', `0x${'bb'.repeat(32)}`) as never,
  );
  expect(computeCanonicalEntityConsensusStateHash(left))
    .not.toBe(computeCanonicalEntityConsensusStateHash(right));
});

test('Entity consensus root rejects non-finite and cyclic state instead of omitting it', () => {
  const nonFinite = baseState();
  nonFinite.timestamp = Number.NaN;
  expect(() => computeCanonicalEntityConsensusStateHash(nonFinite))
    .toThrow('ENTITY_STATE_ROOT_NON_FINITE_NUMBER');

  const cyclic = baseState();
  const value: Record<string, unknown> = {};
  value['self'] = value;
  cyclic.proposals.set('cycle', value as never);
  expect(() => computeCanonicalEntityConsensusStateHash(cyclic))
    .toThrow('ENTITY_STATE_ROOT_CYCLE');
});

test('Entity frame hash binds the complete shared post-replay state root', async () => {
  const left = baseState();
  const right = baseState();
  right.nonces.set('validator-observed-nonce', 1);
  const leftHash = await createEntityFrameHash('genesis', 1, 100, [], left);
  const rightHash = await createEntityFrameHash('genesis', 1, 100, [], right);
  expect(rightHash).not.toBe(leftHash);

  right.nonces.clear();
  right.entityEncPrivKey = 'different-validator-local-secret';
  right.htlcNotes?.set('note' as never, 'different-validator-local-note');
  expect(await createEntityFrameHash('genesis', 1, 100, [], right)).toBe(leftHash);
  expect(await createEntityFrameHash('different-prev-frame', 1, 100, [], right)).not.toBe(leftHash);
});

test('Entity frame strict codec binds arbitrary transaction metadata keys', async () => {
  const state = baseState();
  const tx = (provider: string) => ({
    type: 'chatMessage' as const,
    data: {
      message: 'metadata-binding',
      timestamp: 100,
      metadata: { type: 'audit', provider },
    },
  });
  const left = await createEntityFrameHash('genesis', 1, 100, [tx('provider-a')], state);
  const right = await createEntityFrameHash('genesis', 1, 100, [tx('provider-b')], state);
  expect(right).not.toBe(left);
});

test('strict Entity codec is injective across tagged and adversarial values', () => {
  expect(encodeCanonicalEntityConsensusValue(new Map()))
    .not.toBe(encodeCanonicalEntityConsensusValue({ __xlnType: 'Map', value: [] }));
  expect(encodeCanonicalEntityConsensusValue(1n))
    .not.toBe(encodeCanonicalEntityConsensusValue({ __xlnType: 'BigInt', value: '1' }));
  expect(encodeCanonicalEntityConsensusValue({ x: undefined }))
    .not.toBe(encodeCanonicalEntityConsensusValue({}));
  expect(encodeCanonicalEntityConsensusValue(-0))
    .not.toBe(encodeCanonicalEntityConsensusValue(0));

  const protoKey = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(protoKey, '__proto__', { value: 'bound', enumerable: true });
  expect(encodeCanonicalEntityConsensusValue(protoKey))
    .not.toBe(encodeCanonicalEntityConsensusValue(Object.create(null)));
});

test('strict Entity codec rejects sparse, symbolic, hidden and accessor state', () => {
  expect(() => encodeCanonicalEntityConsensusValue(Array(1)))
    .toThrow('ENTITY_STATE_ROOT_SPARSE_ARRAY');
  expect(() => encodeCanonicalEntityConsensusValue({ [Symbol('hidden')]: 1 }))
    .toThrow('ENTITY_STATE_ROOT_SYMBOL_KEY');

  const hidden = {};
  Object.defineProperty(hidden, 'value', { value: 1, enumerable: false });
  expect(() => encodeCanonicalEntityConsensusValue(hidden))
    .toThrow('ENTITY_STATE_ROOT_OBJECT_DESCRIPTOR_INVALID');
  const accessor = {};
  Object.defineProperty(accessor, 'value', { get: () => 1, enumerable: true });
  expect(() => encodeCanonicalEntityConsensusValue(accessor))
    .toThrow('ENTITY_STATE_ROOT_OBJECT_DESCRIPTOR_INVALID');
});
