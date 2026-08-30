import { expect, test } from 'bun:test';

import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { EMPTY_ACCOUNT_STATE_ROOT } from '../../../account/commitment/state-root';
import { LIMITS } from '../../../config/constants';
import {
  consumeHtlcRuntimeEvent,
  indexCertifiedEntityFrameNotes,
} from '../../../entity/paybook/note-index';
import { terminateHtlcRoute } from '../../../entity/tx/j-events-htlc/route-lifecycle';
import { applyHtlcTimeoutFollowups } from '../../../entity/tx/handlers/account/committed-htlc-followups';
import { createEmptyEnv } from '../../../runtime';
import { readRuntimeFrameEvents , publishEntityCandidateEffects } from '../../../runtime/observability/env-events';
import type { AccountReplica } from '../../../types/account';
import type {
  EntityCandidateEffect,
  EntityReplica,
  EntityState,
  Proposal,
} from '../../../entity/types';
import type { EntityTx } from '../../../types/entity-tx';
import { validateAccountReplica } from '../../../account/validation/state-validation';
import { validateEntityReplica } from '../../../entity/replica/replica-validation';

const leftEntity = `0x${'11'.repeat(32)}`;
const rightEntity = `0x${'22'.repeat(32)}`;
const proposer = `0x${'33'.repeat(20)}`;

const makeAccount = (): AccountReplica => ({
  state: {
    leftEntity,
    rightEntity,
    domain: {
      chainId: 31337,
      depositoryAddress: `0x${'dd'.repeat(20)}`,
    },
    watchSeed: `0x${'44'.repeat(32)}`,
    deltas: new Map(),
    locks: new Map(),
    swapOffers: new Map(),
    pulls: new Map(),
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    disputeConfig: { leftResponseSeconds: 576, rightResponseSeconds: 576 },
    jNonce: 0,
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
  },
  status: 'active',
  mempool: [],
  currentFrame: {
    height: 0,
    timestamp: 0,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: '',
    accountStateRoot: EMPTY_ACCOUNT_STATE_ROOT,
    stateHash: '',
  },
  currentHeight: 0,
  rollbackCount: 0,
  proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nextProofNonce: 1 },
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
});

const makeEntity = (): EntityState => ({
  entityId: leftEntity,
  height: 0,
  timestamp: 1,
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    validators: [proposer],
    shares: { [proposer]: 1n },
    threshold: 1n,
    jurisdiction: {
      name: 'terminal-bounds',
      address: 'http://localhost:8545',
      chainId: 31337,
      depositoryAddress: `0x${'55'.repeat(20)}`,
      entityProviderAddress: `0x${'66'.repeat(20)}`,
    },
  },
  reserves: new Map(),
  accounts: new Map(),
  lastFinalizedJHeight: 0,
  profile: { name: 'bounds', isHub: false, avatar: '', bio: '', website: '' },
  entityEncryptionPublicKey: `0x${'77'.repeat(32)}`,
  paybook: { entries: new Map(), feesEarned: 0n },
});

const makeReplica = (state = makeEntity()): EntityReplica => ({
  entityId: state.entityId,
  signerId: proposer,
  entityEncPubKey: `0x${'77'.repeat(32)}`,
  state,
  mempool: [],
  isProposer: true,
});

test('terminal event consumption removes the canonical hashlock note', () => {
  const replica = makeReplica();
  const { state } = replica;
  const hashlock = `0x${'99'.repeat(32)}`;
  const lockId = `0x${'aa'.repeat(32)}`;
  state.htlcRoutes.set(hashlock, {
    hashlock,
    outboundEntity: rightEntity,
    outboundLockId: lockId,
    createdTimestamp: 1,
  });
  replica.htlcNotes = new Map([[`hashlock:${hashlock}`, 'coffee']]);

  terminateHtlcRoute(state, hashlock, 2);
  expect(state.htlcRoutes).toHaveLength(0);
  expect(replica.htlcNotes).toHaveLength(1);
  expect(consumeHtlcRuntimeEvent(replica, 'HtlcFailed', { hashlock, lockId })).toEqual({
    hashlock,
    lockId,
    description: 'coffee',
  });
  expect(replica.htlcNotes).toBeUndefined();
});

test('timeout terminal activity is emitted before its HTLC notes are removed', () => {
  const replica = makeReplica();
  const { state } = replica;
  const account = makeAccount();
  const hashlock = `0x${'ab'.repeat(32)}`;
  const lockId = `0x${'cd'.repeat(32)}`;
  state.accounts.set(rightEntity, account);
  state.htlcRoutes.set(hashlock, {
    hashlock,
    outboundEntity: rightEntity,
    outboundLockId: lockId,
    createdTimestamp: 1,
  });
  replica.htlcNotes = new Map([[`hashlock:${hashlock}`, 'timeout note']]);
  const env = createEmptyEnv('terminal-note-timeout');
  env.state.eReplicas.set(`${replica.entityId}:${replica.signerId}`, replica);
  const candidateEffects: EntityCandidateEffect[] = [];

  applyHtlcTimeoutFollowups({
    env,
    state,
    newState: state,
    input: { fromEntityId: rightEntity, toEntityId: leftEntity, watchSeed: account.state.watchSeed },
    account,
    outputs: [],
    accountTxs: [],
    candidateEffects,
  }, [hashlock]);

  expect(candidateEffects.some((effect) => effect.kind === 'runtimeEvent' && effect.eventName === 'HtlcFailed')).toBe(true);
  expect(state.htlcRoutes).toHaveLength(0);
  publishEntityCandidateEffects(env, replica, candidateEffects);
  expect(readRuntimeFrameEvents(env).find(entry => entry.message === 'HtlcFailed')?.data?.description).toBe('timeout note');
  expect(replica.htlcNotes).toBeUndefined();
});

test('HTLC note insertion rejects atomically at the Entity cap', () => {
  const replica = makeReplica();
  replica.htlcNotes = new Map(Array.from(
    { length: LIMITS.MAX_ENTITY_HTLC_NOTES },
    (_, index) => [`hashlock:${index}` as const, 'note'],
  ));
  const hashlock = `0x${'de'.repeat(32)}`;

  expect(() => indexCertifiedEntityFrameNotes(replica, { txs: [{
    type: 'htlcPayment',
    data: {
      targetEntityId: rightEntity, tokenId: 1, amount: 1n, maxSenderDebit: 1n, route: [leftEntity, rightEntity],
      deliveryMode: 'instant', hashlock, description: 'new note',
    },
  }] })).toThrow(
    'ENTITY_HTLC_NOTE_LIMIT_EXCEEDED',
  );
  expect(replica.htlcNotes).toHaveLength(LIMITS.MAX_ENTITY_HTLC_NOTES);
  expect(replica.htlcNotes.has(`hashlock:${hashlock}`)).toBe(false);
});

test('HTLC note text validation rejects before adding the hashlock key', () => {
  const replica = makeReplica();
  const hashlock = `0x${'12'.repeat(32)}`;
  expect(() => indexCertifiedEntityFrameNotes(replica, { txs: [{
    type: 'htlcPayment',
    data: {
      targetEntityId: rightEntity,
      tokenId: 1,
      amount: 1n,
      maxSenderDebit: 1n,
      route: [leftEntity, rightEntity],
      deliveryMode: 'instant',
      hashlock,
      description: 'x'.repeat(LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH + 1),
    },
  }] })).toThrow('ENTITY_HTLC_NOTE_INVALID_LENGTH');
  expect(replica.htlcNotes).toBeUndefined();
});

test('certified final onion context indexes the recipient private note', () => {
  const replica = makeReplica();
  const hashlock = `0x${'34'.repeat(32)}`;
  indexCertifiedEntityFrameNotes(replica, {
    txs: [],
    entityContext: {
      version: 1,
      proposerReplicaId: `${replica.entityId}:${replica.signerId}`,
      entityId: replica.entityId,
      proposerSignerId: replica.signerId,
      parentFrameHash: 'genesis',
      height: 1,
      gossipProfiles: [],
      peerAssertions: [],
      htlc: {
        version: 1,
        originated: [],
        entries: [{
          binding: {
            fromEntityId: leftEntity,
            toEntityId: rightEntity,
            domain: { chainId: 31337, depositoryAddress: `0x${'11'.repeat(20)}` },
            accountFrameHash: `0x${'12'.repeat(32)}`,
            accountHeight: 1,
            lockId: `0x${'13'.repeat(32)}`,
            envelopeHash: `0x${'14'.repeat(32)}`,
            hashlock,
            tokenId: 1,
            amount: 1n,
            timelock: 1n,
            revealBeforeHeight: 1,
          },
          outcome: { kind: 'final', secret: `0x${'15'.repeat(32)}`, description: 'recipient invoice' },
        }],
      },
    },
  });
  expect(replica.htlcNotes?.get(`hashlock:${hashlock}`)).toBe('recipient invoice');
});

test('certified proposal frames index nested HTLC descriptions without terminal proposal state', () => {
  const hashlock = `0x${'45'.repeat(32)}`;
  const nestedPayment = {
    type: 'htlcPayment',
    data: {
      targetEntityId: rightEntity,
      tokenId: 1,
      amount: 1n,
      maxSenderDebit: 1n,
      route: [leftEntity, rightEntity],
      deliveryMode: 'instant',
      hashlock,
      description: 'nested invoice',
    },
  } satisfies EntityTx;
  const action = {
    type: 'entity_transaction',
    data: { version: 1, actionHash: `0x${'67'.repeat(32)}`, txs: [nestedPayment] },
  } as const;

  const proposedReplica = makeReplica();
  indexCertifiedEntityFrameNotes(proposedReplica, { txs: [{
    type: 'propose',
    data: { proposer, action },
  }] });
  expect(proposedReplica.htlcNotes?.get(`hashlock:${hashlock}`)).toBe('nested invoice');

  const proposalId = `0x${'78'.repeat(32)}`;
  proposedReplica.state.proposals.set(proposalId, {
    id: proposalId,
    proposer,
    boardHash: `0x${'89'.repeat(32)}`,
    boardEpoch: 0,
    action,
    actionHash: action.data.actionHash,
    votes: new Map(),
    created: 1,
  } satisfies Proposal);
  indexCertifiedEntityFrameNotes(proposedReplica, { txs: [{
    type: 'vote',
    data: { proposalId, voter: proposer, choice: 'yes' },
  }] });
  expect(proposedReplica.htlcNotes?.get(`hashlock:${hashlock}`)).toBe('nested invoice');
});

test('decode validation rejects oversized HTLC notes', () => {
  const replica = makeReplica();
  replica.htlcNotes = new Map(Array.from(
    { length: LIMITS.MAX_ENTITY_HTLC_NOTES + 1 },
    (_, index) => [`hashlock:${index}` as const, 'note'],
  ));
  expect(() => validateEntityReplica(replica, 'oversizedHtlcNotes')).toThrow(
    'ENTITY_HTLC_NOTE_LIMIT_EXCEEDED',
  );
});

test('decode validation accepts signed pull amounts and rejects zero', () => {
  const makePull = (amount: bigint) => ({
    pullId: 'pull-canonical',
    tokenId: 1,
    amount,
    claimedRatio: 0,
    claimedAmount: 0n,
    fullHash: `0x${'ab'.repeat(32)}`,
    partialRoot: `0x${'cd'.repeat(32)}`,
    crossJurisdiction: {
      orderId: 'order',
      routeHash: `0x${'12'.repeat(32)}`,
      leg: 'source' as const,
    },
    createdHeight: 1,
    createdTimestamp: 1,
  });

  const negative = makeAccount();
  negative.state.pulls.set('pull-canonical', makePull(-1_000n));
  expect(() => validateAccountReplica(negative, 'signedPullNegative')).not.toThrow();

  const positive = makeAccount();
  positive.state.pulls.set('pull-canonical', makePull(1_000n));
  expect(() => validateAccountReplica(positive, 'signedPullPositive')).not.toThrow();

  const zero = makeAccount();
  zero.state.pulls.set('pull-canonical', makePull(0n));
  expect(() => validateAccountReplica(zero, 'zeroPull')).toThrow('must be a non-zero bigint');
});

test('decode validation rejects malformed nested financial state', () => {
  const lockAccount = makeAccount();
  const lockId = `0x${'71'.repeat(32)}`;
  lockAccount.state.locks.set(lockId, {
    lockId,
    hashlock: `0x${'72'.repeat(32)}`,
    timelock: 10n,
    revealBeforeHeight: 1,
    amount: -1n,
    tokenId: 1,
    senderIsLeft: true,
    createdHeight: 1,
    createdTimestamp: 1,
  });
  expect(() => validateAccountReplica(lockAccount, 'negativeLock')).toThrow(
    'negativeLock.state.locks',
  );

  const withdrawalAccount = makeAccount();
  withdrawalAccount.pendingWithdrawals.set('request-a', {
    requestId: 'different-request',
    tokenId: 1,
    amount: 1n,
    requestedAt: 1,
    direction: 'outgoing',
    status: 'pending',
  });
  expect(() => validateAccountReplica(withdrawalAccount, 'misboundWithdrawal')).toThrow(
    'Map key must equal requestId',
  );

  const entity = makeEntity();
  entity.reserves.set(1, -1n);
  expect(() => validateEntityReplica(makeReplica(entity), 'negativeReserve')).toThrow(
    'non-negative bigint',
  );
});
