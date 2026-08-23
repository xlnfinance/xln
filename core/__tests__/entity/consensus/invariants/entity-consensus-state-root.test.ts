import { encodeCanonicalConsensusValue } from '../../../../protocol/serialization/canonical-consensus-value';
import { expect, test } from 'bun:test';

import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeCanonicalEntityConsensusStateHashCold,
  computeEntityFrameAuthorityRoot,
  ENTITY_STATE_ROOT_FIELDS,
  ENTITY_STATE_ROOT_EXCLUDED_FIELDS,
  invalidateEntityAccountCommitment,
  computeEntityAccountValueHash,
  ENTITY_ACCOUNT_LEAF_FIELDS,
} from '../../../../entity/consensus/state-root';
import { createEntityFrameHash } from '../../../../entity/consensus/frame';
import { certifiedEntityFrameLinkFingerprint } from '../../../../entity/consensus/frame/lineage';
import type { EntityFrame, EntityState } from '../../../../entity/types';
import { makeAccount as makeAccountReplica } from '../../../helpers/cross-j';
import { PersistentEntityAccountMap } from '../../../../entity/state/persistent-account-map';
import { createBook } from '../../../../orderbook/core';
import { PersistentAccountStateMap } from '../../../../account/state/persistent-state-map';
import { initCrontab } from '../../../../entity/scheduler';
import { computeIntegrityDigest } from '../../../../support/integrity-checksum';

const entityId = `0x${'11'.repeat(32)}`;
const counterpartyId = `0x${'22'.repeat(32)}`;
const signerId = `0x${'33'.repeat(20)}`;


const persistentEnvelope = (account: ReturnType<typeof makeAccountReplica>) => {
  delete (account as { swapOrderHistory?: unknown }).swapOrderHistory;
  delete (account as { swapClosedOrders?: unknown }).swapClosedOrders;
  account.pendingWithdrawals = PersistentAccountStateMap.fromEntries(
    'pendingWithdrawals',
    account.pendingWithdrawals,
  );
  account.shadow.rebalance.policy = PersistentAccountStateMap.fromEntries(
    'rebalanceShadowPolicy',
    account.shadow.rebalance.policy,
  );
  account.shadow.rebalance.submittedAtByToken = PersistentAccountStateMap.fromEntries(
    'rebalanceShadowSubmitted',
    account.shadow.rebalance.submittedAtByToken,
  );
  return account;
};

const persistentAccounts = (
  entries: Iterable<readonly [string, ReturnType<typeof makeAccountReplica>]> = [],
): PersistentEntityAccountMap => PersistentEntityAccountMap.fromMap(
  new Map([...entries].map(([accountId, account]) => [accountId, persistentEnvelope(account)])),
  entityId,
  computeEntityAccountValueHash,
);

const frameContext = (height: number, parentFrameHash: string) => ({
  version: 1 as const,
  proposerReplicaId: `${entityId}:${signerId}`,
  entityId,
  proposerSignerId: signerId,
  parentFrameHash,
  height,
  gossipProfiles: [],
  peerAssertions: [],
  htlc: { version: 1 as const, entries: [], originated: [] },
});

const baseState = (): EntityState => ({
  entityId,
  entityEncryptionPublicKey: `0x${'44'.repeat(32)}`,
  height: 1,
  timestamp: 100,
  nonces: new Map(),
  proposals: new Map(),
  config: { mode: 'proposer-based', threshold: 1n, validators: ['1'], shares: { '1': 1n } },
  reserves: new Map(),
  accounts: persistentAccounts(),
  lastFinalizedJHeight: 0,
  certifiedBoardState: {
    stackKey: `0x${'01'.repeat(32)}`,
    boardRegistryRoot: `0x${'02'.repeat(32)}`,
    finalizedJHeight: 1,
    finalizedJBlockHash: `0x${'03'.repeat(32)}`,
    eventHistoryRoot: `0x${'04'.repeat(32)}`,
  },
  profile: { name: 'state-root', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
});

type StateMutator = (state: EntityState) => void;

const mutators = {
  entityEncryptionPublicKey: state => {
    state.entityEncryptionPublicKey = `0x${'55'.repeat(32)}`;
  },
  entityId: state => {
    state.entityId = `0x${'33'.repeat(32)}`;
  },
  height: state => {
    state.height = 2;
  },
  timestamp: state => {
    state.timestamp = 101;
  },
  nonces: state => {
    state.nonces.set('alice', 1);
  },
  entityCommandNonces: state => {
    state.entityCommandNonces = {
      version: 1,
      boardHash: `0x${'12'.repeat(32)}`,
      boardEpoch: 0,
      bySigner: new Map([['1', { nonce: 1n, commandHash: `0x${'13'.repeat(32)}` }]]),
    };
  },
  proposals: state => {
    state.proposals.set('proposal', { provider: 'nested-consensus-value' } as never);
  },
  config: state => {
    state.config.threshold = 2n;
  },
  prevFrameHash: state => {
    state.prevFrameHash = `0x${'44'.repeat(32)}`;
  },
  leaderState: state => {
    state.leaderState = { activeValidatorId: '2', view: 1, changedAtHeight: 1 };
  },
  reserves: state => {
    state.reserves.set(1, 10n);
  },
  accounts: state => {
    state.accounts = persistentAccounts([[counterpartyId, makeAccountReplica(entityId, counterpartyId)]]);
  },
  externalWallet: state => {
    state.externalWallet = { balances: new Map(), allowances: new Map() };
  },
  deferredAccountProposals: state => {
    state.deferredAccountProposals = new Map([[counterpartyId, `0x${'34'.repeat(32)}`]]);
  },
  lastFinalizedJHeight: state => {
    state.lastFinalizedJHeight = 9;
  },
  jHistoryFinality: state => {
    state.jHistoryFinality = {
      jurisdictionRef: 'evm:31337',
      baseHeight: 1,
      finalizedThroughHeight: 9,
      tipBlockHash: `0x${'55'.repeat(32)}`,
      eventHistoryRoot: `0x${'66'.repeat(32)}`,
      proposerSignerId: '1',
      proposerSignature: `0x${'77'.repeat(65)}`,
      entityHeight: 1,
    };
  },
  certifiedBoardState: state => {
    state.certifiedBoardState!.boardRegistryRoot = `0x${'77'.repeat(32)}`;
  },
  crontabState: state => {
    state.crontabState = initCrontab();
    const task = state.crontabState.tasks.get('hubRebalance');
    if (!task) throw new Error('TEST_CRONTAB_TASK_MISSING');
    task.lastRun = 1;
  },
  jBatchState: state => {
    state.jBatchState = { marker: 'jbatch' } as never;
  },
  entityProviderActionState: state => {
    state.entityProviderActionState = {
      version: 1,
      confirmedNonce: 1n,
      generation: 1,
    };
  },
  profile: state => {
    state.profile.bio = 'consensus-profile';
  },
  htlcRoutes: state => {
    state.htlcRoutes.set('route', { marker: 'route' } as never);
  },
  htlcFeesEarned: state => {
    state.htlcFeesEarned = 1n;
  },
  consumptionAccumulator: state => {
    state.consumptionAccumulator = {
      version: 1,
      root: `0x${'ab'.repeat(32)}`,
      count: 1n,
    };
  },
  certifiedOutputSequences: state => {
    state.certifiedOutputSequences = new Map([
      [counterpartyId, { lastSequence: 1n, lastSemanticHash: `0x${'bc'.repeat(32)}` }],
    ]);
  },
  outDebtsByToken: state => {
    state.outDebtsByToken = new Map([[1, new Map([[counterpartyId, { marker: 'out-debt' } as never]])]]);
  },
  inDebtsByToken: state => {
    state.inDebtsByToken = new Map([[1, new Map([[counterpartyId, { marker: 'in-debt' } as never]])]]);
  },
  orderbookExt: state => {
    state.orderbookExt = {
      books: new Map(),
      orderPairs: new Map(),
      pairDimensions: new Map(),
      referrals: new Map(),
      hubProfile: { marker: 'orderbook' },
    } as never;
  },
  lockBook: state => {
    state.lockBook.set('lock', { marker: 'lock' } as never);
  },
  swapTradingPairs: state => {
    state.swapTradingPairs = [{ baseTokenId: 1, quoteTokenId: 2, pairId: '1:2' }];
  },
  crossJurisdictionSwaps: state => {
    state.crossJurisdictionSwaps = new Map([['swap', { marker: 'cross-swap' } as never]]);
  },
  crossJurisdictionAuthorizations: state => {
    state.crossJurisdictionAuthorizations = new Map([['auth', { marker: 'cross-auth' } as never]]);
  },
  pendingCrossJurisdictionFillAcks: state => {
    state.pendingCrossJurisdictionFillAcks = new Map([['ack', { marker: 'cross-ack' } as never]]);
  },
  settlementContinuations: state => {
    state.settlementContinuations = new Map([['settlement', { marker: 'continuation' } as never]]);
  },
  crossJurisdictionBookAdmissions: state => {
    state.crossJurisdictionBookAdmissions = new Map([['admission', { marker: 'cross-admission' } as never]]);
  },
  hubRebalanceConfig: state => {
    state.hubRebalanceConfig = { marker: 'rebalance' } as never;
  },
  lending: state => {
    state.lending = { marker: 'lending' } as never;
  },
} satisfies Record<keyof EntityState, StateMutator>;

const stateRootExcludedFields = new Set<keyof EntityState>(ENTITY_STATE_ROOT_EXCLUDED_FIELDS);

test('Entity consensus root covers every shared EntityState field', () => {
  expect(Object.keys(mutators).sort()).toEqual([
    ...ENTITY_STATE_ROOT_FIELDS,
    ...ENTITY_STATE_ROOT_EXCLUDED_FIELDS,
  ].sort());
  const baseline = computeCanonicalEntityConsensusStateHash(baseState());
  for (const [field, mutate] of Object.entries(mutators) as Array<[keyof EntityState, StateMutator]>) {
    const changed = baseState();
    mutate(changed);
    const actual = computeCanonicalEntityConsensusStateHash(changed);
    if (stateRootExcludedFields.has(field)) expect(actual, field).toBe(baseline);
    else expect(actual, field).not.toBe(baseline);
  }
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
  const right = baseState();
  right.config = structuredClone(left.config);
  right.config.jurisdiction!.name = 'validator B label';
  right.config.jurisdiction!.address = 'http://127.0.0.1:28545';

  const stateRoot = computeCanonicalEntityConsensusStateHash(left);
  const authorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(left));
  expect(computeCanonicalEntityConsensusStateHash(right)).toBe(stateRoot);
  expect(computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(right))).toBe(authorityRoot);

  const mutateCanonical = [
    (state: EntityState) => {
      state.config.jurisdiction!.chainId = 31_338;
    },
    (state: EntityState) => {
      state.config.jurisdiction!.depositoryAddress = `0x${'ef'.repeat(20)}`;
    },
    (state: EntityState) => {
      state.config.jurisdiction!.entityProviderAddress = `0x${'01'.repeat(20)}`;
    },
    (state: EntityState) => {
      state.config.jurisdiction!.registrationBlock = 18;
    },
    (state: EntityState) => {
      state.config.jurisdiction!.entityProviderDeploymentBlock = 4;
    },
    (state: EntityState) => {
      state.config.jurisdiction!.blockTimeMs = 2_000;
    },
    (state: EntityState) => {
      state.config.jurisdiction!.rebalancePolicyUsd!.maxFee = 6;
    },
  ];
  for (const mutate of mutateCanonical) {
    const changed = baseState();
    changed.config = structuredClone(left.config);
    mutate(changed);
    expect(computeCanonicalEntityConsensusStateHash(changed)).not.toBe(stateRoot);
    expect(computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(changed))).not.toBe(authorityRoot);
  }
});

test('Entity config commitment rejects unmodelled fields instead of silently omitting them', () => {
  const configExtension = baseState();
  (configExtension.config as unknown as Record<string, unknown>)['hiddenConsensusRule'] = true;
  expect(() => computeCanonicalEntityConsensusStateHash(configExtension)).toThrow(
    'ENTITY_STATE_ROOT_EXTRA_PROPERTY:hiddenConsensusRule',
  );

  const jurisdictionExtension = baseState();
  jurisdictionExtension.config.jurisdiction = {
    name: 'local',
    address: 'http://127.0.0.1:8545',
    chainId: 31_337,
    depositoryAddress: `0x${'ab'.repeat(20)}`,
    entityProviderAddress: `0x${'cd'.repeat(20)}`,
  };
  (jurisdictionExtension.config.jurisdiction as unknown as Record<string, unknown>)['consensusExtension'] = 1;
  expect(() => computeCanonicalEntityConsensusStateHash(jurisdictionExtension)).toThrow(
    'ENTITY_STATE_ROOT_EXTRA_PROPERTY:consensusExtension',
  );
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
  expect(() => computeCanonicalEntityConsensusStateHash(incomplete)).toThrow(
    'ENTITY_STATE_ROOT_JURISDICTION_FIELD_REQUIRED:entityProviderAddress',
  );
});

test('Entity consensus root is insertion-order independent without recursive key blacklists', () => {
  const left = baseState();
  left.nonces = new Map([
    ['b', 2],
    ['a', 1],
  ]);
  left.proposals.set('nested', { provider: 'consensus-a' } as never);
  const right = baseState();
  right.nonces = new Map([
    ['a', 1],
    ['b', 2],
  ]);
  right.proposals.set('nested', { provider: 'consensus-a' } as never);

  expect(computeCanonicalEntityConsensusStateHash(left)).toBe(computeCanonicalEntityConsensusStateHash(right));
  const mutated = { ...right };
  (mutated.proposals.get('nested') as unknown as { provider: string }).provider = 'consensus-b';
  expect(computeCanonicalEntityConsensusStateHash(left)).not.toBe(computeCanonicalEntityConsensusStateHash(mutated));
});

test('Entity consensus root excludes only typed Account replica caches', () => {
  const left = baseState();
  const right = baseState();
  const leftAccount = {
    ...makeAccountReplica(entityId, counterpartyId),
    frameHistory: [{ stateHash: 'left-cache' }],
  } as never;
  const rightAccount = {
    ...makeAccountReplica(entityId, counterpartyId),
    frameHistory: [{ stateHash: 'right-cache' }],
  } as never;
  left.accounts = persistentAccounts([[counterpartyId, leftAccount]]);
  right.accounts = persistentAccounts([[counterpartyId, rightAccount]]);
  expect(computeCanonicalEntityConsensusStateHash(left)).toBe(computeCanonicalEntityConsensusStateHash(right));

  const disputed = { ...makeAccountReplica(entityId, counterpartyId), status: 'disputed' as const };
  right.accounts = persistentAccounts([[counterpartyId, disputed]]);
  expect(computeCanonicalEntityConsensusStateHash(left)).not.toBe(computeCanonicalEntityConsensusStateHash(right));

  const reseal = { ...makeAccountReplica(entityId, counterpartyId), boardResealMigration: {
    activationJHeight: 9,
    activationLogIndex: 2,
    reason: 'bilateral-frame-uncertified' as const,
  } };
  right.accounts = persistentAccounts([[counterpartyId, reseal]]);
  expect(computeCanonicalEntityConsensusStateHash(left)).not.toBe(computeCanonicalEntityConsensusStateHash(right));
});

test('Entity Account commitment is immutable and its cold oracle matches the Patricia root', () => {
  const state = baseState();
  state.accounts = persistentAccounts([[counterpartyId, makeAccountReplica(entityId, counterpartyId)]]);
  const before = computeCanonicalEntityConsensusStateHash(state);
  expect(() => {
    (state.accounts.get(counterpartyId) as unknown as { status: string }).status = 'disputed';
  }).toThrow();
  invalidateEntityAccountCommitment(state, counterpartyId);
  expect(computeCanonicalEntityConsensusStateHash(state)).toBe(before);
  expect(computeCanonicalEntityConsensusStateHash(state)).toBe(computeCanonicalEntityConsensusStateHashCold(state));
});

test('Entity consensus root binds incremental book commitments but not the derived cancel index', () => {
  const makeOrderbookExt = (): NonNullable<EntityState['orderbookExt']> =>
    ({
      books: new Map([
        [
          '1/2',
          createBook({ bucketWidthTicks: 100n, maxOrders: 10, stpPolicy: 1 }),
        ],
      ]),
      orderPairs: new Map(),
      pairDimensions: new Map(),
      referrals: new Map(),
      hubProfile: {
        entityId,
        name: 'hub',
        usdQuoteAuthorityEntityId: entityId,
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
    }) satisfies NonNullable<EntityState['orderbookExt']>;

  const baseline = baseState();
  baseline.orderbookExt = makeOrderbookExt();
  const baselineRoot = computeCanonicalEntityConsensusStateHash(baseline);

  const derivedIndexOnly = baseState();
  derivedIndexOnly.orderbookExt = makeOrderbookExt();
  derivedIndexOnly.orderbookExt!.orderPairs.set('account:offer', ['1/2']);
  expect(computeCanonicalEntityConsensusStateHash(derivedIndexOnly)).toBe(baselineRoot);

  const bookChanged = baseState();
  bookChanged.orderbookExt = makeOrderbookExt();
  const changedBook = bookChanged.orderbookExt!.books.get('1/2')!;
  const { commitmentHash: _commitmentHash, ...bookWithoutCachedCommitment } = changedBook;
  bookChanged.orderbookExt!.books.set('1/2', {
    ...bookWithoutCachedCommitment,
    eventHash: 99n,
  });
  expect(computeCanonicalEntityConsensusStateHash(bookChanged)).not.toBe(baselineRoot);

  const referralChanged = baseState();
  referralChanged.orderbookExt = makeOrderbookExt();
  referralChanged.orderbookExt!.referrals.set('referral', { marker: 'bound' } as never);
  expect(computeCanonicalEntityConsensusStateHash(referralChanged)).not.toBe(baselineRoot);

  const policyChanged = baseState();
  policyChanged.orderbookExt = makeOrderbookExt();
  policyChanged.orderbookExt!.hubProfile.minTradeSize = 1n;
  expect(computeCanonicalEntityConsensusStateHash(policyChanged)).not.toBe(baselineRoot);
});

test('Entity consensus root commits peer Hankos while own post-quorum subsets stay shadow', () => {
  const makeWitnessAccount = (ownHanko: string, peerHanko: string, frameHash: string) => {
    const pendingFrame = {
      height: 1,
      timestamp: 100,
      jHeight: 0,
      accountTxs: [{
        type: 'settle_transition' as const,
        data: {
          kind: 'seal' as const,
          revision: 1,
          workspaceHash: `0x${'71'.repeat(32)}`,
          settlementNonce: 1,
          settlementHash: `0x${'72'.repeat(32)}`,
          settlementHanko: ownHanko,
          postProof: {
            proofBodyHash: `0x${'73'.repeat(32)}`,
            disputeHash: `0x${'74'.repeat(32)}`,
            nonce: 1,
            proposerIsLeft: true,
            hanko: ownHanko,
          },
        },
      }],
      prevFrameHash: `0x${'66'.repeat(32)}`,
      accountStateRoot: `0x${'55'.repeat(32)}`,
      stateHash: frameHash,
      deltas: [],
      byLeft: true,
    };
    const account = makeAccountReplica(entityId, counterpartyId);
    account.currentFrame = pendingFrame;
    account.currentHeight = pendingFrame.height;
    account.currentFrameHanko = ownHanko;
    account.counterpartyFrameHanko = peerHanko;
    account.currentDisputeProofHanko = ownHanko;
    account.counterpartyDisputeProofHanko = peerHanko;
    account.counterpartySettlementHanko = peerHanko;
    account.pendingWithdrawals = PersistentAccountStateMap.fromEntries('pendingWithdrawals', [
        [
          'withdrawal',
          {
            requestId: 'withdrawal',
            tokenId: 1,
            amount: 1n,
            requestedAt: 100,
            direction: 'outgoing',
            status: 'approved',
            signature: ownHanko,
          },
        ],
      ]);
    account.pendingFrame = pendingFrame;
    account.pendingAccountInput = {
        kind: 'frame',
        fromEntityId: entityId,
        toEntityId: counterpartyId,
        domain: account.state.domain,
        disputeConfig: account.state.disputeConfig,
        proposal: { frame: pendingFrame, frameHanko: ownHanko },
      };
    account.lastOutboundFrameAck = {
        height: 1,
        counterpartyEntityId: counterpartyId,
        response: {
          kind: 'ack',
          fromEntityId: entityId,
          toEntityId: counterpartyId,
          domain: account.state.domain,
          disputeConfig: account.state.disputeConfig,
          ack: { height: 1, frameHash, frameHanko: ownHanko },
        },
      };
    account.state.settlementWorkspace = {
      ops: [],
      workspaceHash: `0x${'76'.repeat(32)}`,
      revision: 1,
      leftHanko: ownHanko,
        rightHanko: peerHanko,
        settlementHash: `0x${'77'.repeat(32)}`,
        lastModifiedByLeft: true,
        status: 'ready_to_submit',
        createdAt: 100,
        lastUpdatedAt: 100,
        executorIsLeft: true,
        postSettlementDisputeProof: {
          leftHanko: ownHanko,
          rightHanko: peerHanko,
          disputeHash: `0x${'88'.repeat(32)}`,
          proofBodyHash: `0x${'99'.repeat(32)}`,
          nonce: 1,
          proposerIsLeft: true,
        },
      };
    return account;
  };
  const left = baseState();
  const right = baseState();
  const frameHash = `0x${'aa'.repeat(32)}`;
  left.accounts = persistentAccounts([[
    counterpartyId,
    makeWitnessAccount('0xown-subset-a', '0xpeer-fixed', frameHash),
  ]]);
  right.accounts = persistentAccounts([[
    counterpartyId,
    makeWitnessAccount('0xown-subset-b', '0xpeer-fixed', frameHash),
  ]]);
  expect(computeCanonicalEntityConsensusStateHash(left)).toBe(computeCanonicalEntityConsensusStateHash(right));

  right.accounts = persistentAccounts([[
    counterpartyId,
    makeWitnessAccount('0xown-subset-b', '0xpeer-changed', frameHash),
  ]]);
  // Account Map writes are reducer-owned dirty-page operations. The
  // incremental parent commitment never scans a million untouched Accounts
  // merely to discover an object replacement.
  invalidateEntityAccountCommitment(right, counterpartyId);
  expect(computeCanonicalEntityConsensusStateHash(left)).not.toBe(computeCanonicalEntityConsensusStateHash(right));
});

const fatPayment = (padding: string) => ({
  type: 'direct_payment' as const,
  data: {
    tokenId: 1,
    amount: 1n,
    route: [entityId],
    deliveryMode: 'direct' as const,
    fromEntityId: entityId,
    toEntityId: counterpartyId,
    description: padding,
  },
});

const hashedFrame = (stateHash: string, padding: string) => ({
  height: 1,
  timestamp: 100,
  jHeight: 0,
  accountTxs: [fatPayment(padding)],
  prevFrameHash: `0x${'66'.repeat(32)}`,
  accountStateRoot: `0x${'55'.repeat(32)}`,
  stateHash,
  deltas: [],
  byLeft: true,
});

test('Entity account leaf binds frame hashes and money roots, not frame bodies', () => {
  const frameHash = `0x${'ab'.repeat(32)}`;
  const account = persistentEnvelope(makeAccountReplica(entityId, counterpartyId));
  account.currentFrame = hashedFrame(frameHash, 'A'.repeat(8_192));
  account.pendingFrame = hashedFrame(frameHash, 'A'.repeat(8_192));
  account.pendingAccountInput = {
    kind: 'frame',
    fromEntityId: entityId,
    toEntityId: counterpartyId,
    domain: account.state.domain,
    disputeConfig: account.state.disputeConfig,
    proposal: { frame: hashedFrame(frameHash, 'A'.repeat(8_192)) },
  };
  const before = computeEntityAccountValueHash(account);

  account.currentFrame = hashedFrame(frameHash, 'B'.repeat(8_192));
  account.pendingFrame = hashedFrame(frameHash, 'B'.repeat(8_192));
  account.pendingAccountInput = {
    kind: 'frame',
    fromEntityId: entityId,
    toEntityId: counterpartyId,
    domain: account.state.domain,
    disputeConfig: account.state.disputeConfig,
    proposal: { frame: hashedFrame(frameHash, 'B'.repeat(8_192)) },
  };
  expect(computeEntityAccountValueHash(account)).toBe(before);

  account.currentFrame = hashedFrame(`0x${'cd'.repeat(32)}`, 'B'.repeat(8_192));
  expect(computeEntityAccountValueHash(account)).not.toBe(before);

  const money = persistentEnvelope(makeAccountReplica(entityId, counterpartyId));
  const moneyBefore = computeEntityAccountValueHash(money);
  const deltas = money.state.deltas;
  if (!(deltas instanceof PersistentAccountStateMap)) throw new Error('TEST_DELTAS_NOT_PERSISTENT');
  const delta = deltas.get(1);
  if (!delta) throw new Error('TEST_DELTA_MISSING');
  money.state.deltas = deltas.updated(1, { ...delta, leftCreditLimit: 1n });
  expect(computeEntityAccountValueHash(money)).not.toBe(moneyBefore);
});

test('certified Entity frame link fingerprint ignores nested tx bodies', () => {
  const frame = (padding: string): EntityFrame => ({
    height: 1,
    parentFrameHash: 'genesis',
    stateRoot: `0x${'11'.repeat(32)}`,
    authorityRoot: `0x${'22'.repeat(32)}`,
    timestamp: 100,
    entityContext: frameContext(1, 'genesis'),
    txs: [{ type: 'chatMessage', data: { message: padding, timestamp: 100 } }],
    events: [],
    hash: `0x${'33'.repeat(32)}`,
    leader: { proposerSignerId: signerId, view: 0 },
    hashesToSign: [{ type: 'entityFrame', hash: `0x${'33'.repeat(32)}`, context: 'frame' }],
    collectedSigs: new Map([[signerId, ['0xsig']]]),
  });
  const postAuthority = buildEntityFrameAuthority(baseState());
  expect(certifiedEntityFrameLinkFingerprint({ frame: frame('A'.repeat(4_096)), postAuthority })).toBe(
    certifiedEntityFrameLinkFingerprint({ frame: frame('B'.repeat(4_096)), postAuthority }),
  );
});

test('100 fat Account leaves reseal in under 100ms including cached repeats', () => {
  const frameHash = `0x${'ab'.repeat(32)}`;
  const entries: Array<readonly [string, ReturnType<typeof makeAccountReplica>]> = [];
  for (let index = 0; index < 100; index += 1) {
    const counterparty = `0x${index.toString(16).padStart(64, '0')}`;
    const account = persistentEnvelope(makeAccountReplica(entityId, counterparty));
    account.currentFrame = hashedFrame(frameHash, 'A'.repeat(8_192));
    account.pendingFrame = hashedFrame(frameHash, 'A'.repeat(8_192));
    entries.push([counterparty, account]);
  }
  const fat = baseState();
  fat.accounts = persistentAccounts(entries);
  const started = performance.now();
  const first = computeCanonicalEntityConsensusStateHash(fat);
  for (let round = 0; round < 6; round += 1) {
    expect(computeCanonicalEntityConsensusStateHash(fat)).toBe(first);
  }
  expect(performance.now() - started).toBeLessThan(100);

  const thin = baseState();
  thin.accounts = persistentAccounts(entries.map(([counterparty]) => {
    const account = persistentEnvelope(makeAccountReplica(entityId, counterparty));
    account.currentFrame = hashedFrame(frameHash, 'B');
    account.pendingFrame = hashedFrame(frameHash, 'B');
    return [counterparty, account] as const;
  }));
  expect(computeCanonicalEntityConsensusStateHash(thin)).toBe(first);
});

test('Entity consensus root rejects non-finite and cyclic state instead of omitting it', () => {
  const nonFinite = baseState();
  nonFinite.timestamp = Number.NaN;
  expect(() => computeCanonicalEntityConsensusStateHash(nonFinite)).toThrow('ENTITY_STATE_ROOT_NON_FINITE_NUMBER');

  const cyclic = baseState();
  const value: Record<string, unknown> = {};
  value['self'] = value;
  cyclic.proposals.set('cycle', value as never);
  expect(() => computeCanonicalEntityConsensusStateHash(cyclic)).toThrow('ENTITY_STATE_ROOT_CYCLE');
});

test('Entity frame hash binds the complete shared post-replay state root', async () => {
  const left = baseState();
  const right = baseState();
  right.nonces.set('validator-observed-nonce', 1);
  const leftHash = await createEntityFrameHash('genesis', 1, 100, [], left, frameContext(1, 'genesis'));
  const rightHash = await createEntityFrameHash('genesis', 1, 100, [], right, frameContext(1, 'genesis'));
  expect(rightHash).not.toBe(leftHash);

  const cleared = { ...right, nonces: new Map() };
  expect(await createEntityFrameHash('genesis', 1, 100, [], cleared, frameContext(1, 'genesis'))).toBe(leftHash);
  expect(await createEntityFrameHash('different-prev-frame', 1, 100, [], cleared, frameContext(1, 'different-prev-frame'))).not.toBe(leftHash);
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
  const left = await createEntityFrameHash('genesis', 1, 100, [tx('provider-a')], state, frameContext(1, 'genesis'));
  const right = await createEntityFrameHash('genesis', 1, 100, [tx('provider-b')], state, frameContext(1, 'genesis'));
  expect(right).not.toBe(left);
});

test('strict Entity codec is injective across tagged and adversarial values', () => {
  expect(encodeCanonicalConsensusValue(new Map())).not.toBe(
    encodeCanonicalConsensusValue({ __xlnType: 'Map', value: [] }),
  );
  expect(encodeCanonicalConsensusValue(1n)).not.toBe(
    encodeCanonicalConsensusValue({ __xlnType: 'BigInt', value: '1' }),
  );
  expect(encodeCanonicalConsensusValue({ x: undefined })).not.toBe(encodeCanonicalConsensusValue({}));
  expect(encodeCanonicalConsensusValue(-0)).not.toBe(encodeCanonicalConsensusValue(0));

  const protoKey = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(protoKey, '__proto__', { value: 'bound', enumerable: true });
  expect(encodeCanonicalConsensusValue(protoKey)).not.toBe(encodeCanonicalConsensusValue(Object.create(null)));
});

test('strict Entity codec rejects sparse, symbolic, hidden and accessor state', () => {
  expect(() => encodeCanonicalConsensusValue(Array(1))).toThrow('ENTITY_STATE_ROOT_SPARSE_ARRAY');
  expect(() => encodeCanonicalConsensusValue({ [Symbol('hidden')]: 1 })).toThrow('ENTITY_STATE_ROOT_SYMBOL_KEY');

  const hidden = {};
  Object.defineProperty(hidden, 'value', { value: 1, enumerable: false });
  expect(() => encodeCanonicalConsensusValue(hidden)).toThrow('ENTITY_STATE_ROOT_OBJECT_DESCRIPTOR_INVALID');
  const accessor = {};
  Object.defineProperty(accessor, 'value', { get: () => 1, enumerable: true });
  expect(() => encodeCanonicalConsensusValue(accessor)).toThrow('ENTITY_STATE_ROOT_OBJECT_DESCRIPTOR_INVALID');
});
