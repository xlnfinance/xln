import { expect, test } from 'bun:test';

import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { EMPTY_ACCOUNT_STATE_ROOT } from '../../../account/commitment/state-root';
import { LIMITS } from '../../../config/constants';
import { failOriginatedPayment } from '../../../paybook/lifecycle';
import { validatePreparedHtlcPayment } from '../../../paybook/payment-admission';
import { validateHtlcPreparedInfraContext } from '../../../paybook/prepared-context-validation';
import { getEffectiveHtlcFrameTxs } from '../../../paybook/materialize-context';
import { applyBookIntentProgram, createBookIntentProgram } from '../../../entity/books/book-intents';
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

const payment = (description: string): Extract<EntityTx, { type: 'htlcPayment' }> => ({
  type: 'htlcPayment', data: {
    targetEntityId: rightEntity, tokenId: 1, amount: 1n, maxSenderDebit: 1n,
    route: [leftEntity, rightEntity], deliveryMode: 'instant',
    hashlock: `0x${'99'.repeat(32)}`, description,
  },
});

const finalContext = (description: string) => ({
  version: 1, originated: [], entries: [{
    binding: {
      fromEntityId: leftEntity, toEntityId: rightEntity,
      domain: { chainId: 31337, depositoryAddress: `0x${'11'.repeat(20)}` },
      accountFrameHash: `0x${'12'.repeat(32)}`, accountHeight: 1,
      envelopeHash: `0x${'14'.repeat(32)}`, hashlock: `0x${'34'.repeat(32)}`,
      tokenId: 1, amount: 1n, timelock: 1n, revealBeforeHeight: 1,
    },
    outcome: { kind: 'final', secret: `0x${'15'.repeat(32)}`, description },
  }],
});

test('terminal failure removes its Paybook description and exact retry emits nothing', () => {
  const state = makeEntity();
  const hashlock = `0x${'99'.repeat(32)}`;
  state.paybook.entries.set(hashlock, {
    hashlock, outboundEntity: rightEntity, createdTimestamp: 1, description: 'coffee',
  });
  const effects: EntityCandidateEffect[] = [];
  expect(failOriginatedPayment(state, effects, hashlock, 'timeout')).toBe(true);
  expect(state.paybook.entries.size).toBe(0);
  expect(effects).toEqual([{
    kind: 'runtimeEvent', eventName: 'HtlcFailed',
    data: { hashlock, lockId: hashlock, reason: 'timeout', entityId: leftEntity, description: 'coffee' },
  }]);
  expect(failOriginatedPayment(state, effects, hashlock, 'timeout')).toBe(false);
  expect(effects).toHaveLength(1);
  expect(state.paybook.entries.size).toBe(0);
});

test('timeout stages the description in its event before deleting the Paybook entry', () => {
  const replica = makeReplica();
  const { state } = replica;
  const account = makeAccount();
  const hashlock = `0x${'ab'.repeat(32)}`;
  state.accounts.set(rightEntity, account);
  state.paybook.entries.set(hashlock, {
    hashlock, outboundEntity: rightEntity, createdTimestamp: 1, description: 'timeout note',
  });
  const env = createEmptyEnv('terminal-note-timeout');
  env.state.eReplicas.set(`${replica.entityId}:${replica.signerId}`, replica);
  const candidateEffects: EntityCandidateEffect[] = [];
  const program = createBookIntentProgram();
  const context = {
    env, state, newState: state,
    input: { fromEntityId: rightEntity, toEntityId: leftEntity,
      watchSeed: account.state.watchSeed, domain: account.state.domain },
    account, outputs: [], accountTxs: [], candidateEffects, bookIntentSlot: program.openSlot(),
  };
  applyHtlcTimeoutFollowups(context, [hashlock]);
  expect(candidateEffects).toMatchObject([{
    kind: 'runtimeEvent', eventName: 'HtlcFailed', data: { description: 'timeout note', hashlock },
  }]);
  expect(state.paybook.entries.size).toBe(1);
  expect(readRuntimeFrameEvents(env)).toHaveLength(0);
  applyBookIntentProgram(state, program);
  expect(state.paybook.entries.size).toBe(0);
  publishEntityCandidateEffects(env, replica, candidateEffects);
  expect(readRuntimeFrameEvents(env).find(entry => entry.message === 'HtlcFailed')?.data?.description).toBe('timeout note');
  applyHtlcTimeoutFollowups({ ...context, bookIntentSlot: createBookIntentProgram().openSlot() }, [hashlock]);
  expect(candidateEffects).toHaveLength(1);
});

test('UTF-8 payment description admission rejects atomically above 256 bytes', () => {
  const state = makeEntity();
  const description = 'é'.repeat(LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH / 2 + 1);
  expect(description.length).toBeLessThan(LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH);
  expect(() => validatePreparedHtlcPayment(state, payment(description), undefined))
    .toThrow('HTLC_PAYMENT_DESCRIPTION_INVALID');
  expect(state.paybook.entries.size).toBe(0);
  expect(state.paybook.feesEarned).toBe(0n);
  expect(() => validatePreparedHtlcPayment(state, payment('é'.repeat(128)), undefined))
    .toThrow('HTLC_PAYMENT_INFRA_CONTEXT_REQUIRED');
});

test('ASCII payment description validation rejects before adding its hashlock', () => {
  const state = makeEntity();
  expect(() => validatePreparedHtlcPayment(state, payment('x'.repeat(LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH + 1)), undefined))
    .toThrow('HTLC_PAYMENT_DESCRIPTION_INVALID');
  expect(state.paybook.entries.size).toBe(0);
});

test('certified final context preserves the recipient description without a replica note index', () => {
  const source = finalContext('recipient invoice');
  const validated = validateHtlcPreparedInfraContext(source);
  expect(validated).toEqual(source);
  expect(validated.entries[0]?.outcome).toEqual({
    kind: 'final', secret: `0x${'15'.repeat(32)}`, description: 'recipient invoice',
  });
  source.entries[0]!.outcome.description = 'modified after validation';
  expect(validated.entries[0]?.outcome).toMatchObject({ description: 'recipient invoice' });
});

test('proposal and threshold vote expose the same nested payment description without a terminal proposal copy', () => {
  const nestedPayment = payment('nested invoice');
  const action = {
    type: 'entity_transaction',
    data: { version: 1, actionHash: `0x${'67'.repeat(32)}`, txs: [nestedPayment] },
  } as const;
  const state = makeEntity();
  expect(getEffectiveHtlcFrameTxs(state, [{ type: 'propose', data: { proposer, action } }]))
    .toEqual([nestedPayment]);
  expect(state.proposals.size).toBe(0);
  const proposalId = `0x${'78'.repeat(32)}`;
  const proposal = {
    id: proposalId, proposer, boardHash: `0x${'89'.repeat(32)}`, boardEpoch: 0,
    action, actionHash: action.data.actionHash, votes: new Map(), created: 1,
  } satisfies Proposal;
  state.proposals.set(proposalId, proposal);
  expect(getEffectiveHtlcFrameTxs(state, [{ type: 'vote', data: { proposalId, voter: proposer, choice: 'yes' } }]))
    .toEqual([nestedPayment]);
  expect(state.proposals.get(proposalId)).toBe(proposal);
  expect(proposal.votes.size).toBe(0);
});

test('prepared context decode rejects oversized UTF-8 descriptions without mutating source', () => {
  const source = finalContext('é'.repeat(129));
  const before = structuredClone(source);
  expect(() => validateHtlcPreparedInfraContext(source)).toThrow('HTLC_PREPARED_DESCRIPTION_INVALID');
  expect(source).toEqual(before);
  const exact = finalContext('é'.repeat(128));
  expect(validateHtlcPreparedInfraContext(exact)).toEqual(exact);
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
