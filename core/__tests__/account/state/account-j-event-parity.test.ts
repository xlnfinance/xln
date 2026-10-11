import { describe, expect, test } from 'bun:test';

import {
  accountTransitionView,
  beginAccountTransition,
  commitAccountTransition,
} from '../../../account/state/candidate-overlay';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { handleJEventClaim } from '../../../account/tx/handlers/j-events/claim';
import { ACCOUNT_TX_REJECTION_CODES } from '../../../account/tx/apply-types';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { createAccountJClaimSession } from '../../../account/j-claims/j-claim-session';
import {
  cacheCommittedAccountJClaimNodeChanges,
  getAccountJClaimNodeStore,
} from '../../../entity/account/account-j-claim-node-store';
import { prepareAccountJClaimTx } from '../../../account/j-claims/j-claim-transition';
import { mergeJEventClaimOps } from '../../../entity/tx/j-events-account';
import type { JEventAccountTx } from '../../../entity/tx/j-events-types';
import { createEmptyEnv } from '../../../runtime';
import type { AccountReplica, AccountTx } from '../../../types/account';
import type { RuntimeReplica } from '../../../runtime/types';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { createDefaultDelta } from '../../../account/state/delta';
import { buildAccountProofBody } from '../../../protocol/dispute/proof-builder';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const BLOCK_HASH = `0x${'33'.repeat(32)}`;
const DOMAIN = { chainId: 31337, depositoryAddress: `0x${'44'.repeat(20)}` };

const settledEvent: JurisdictionEvent = {
  type: 'AccountSettled',
  data: {
    leftEntity: LEFT,
    rightEntity: RIGHT,
    tokenId: 1,
    leftReserve: '0',
    rightReserve: '0',
    collateral: '125',
    ondelta: '7',
    nonce: 3,
  },
};

const machine = (): AccountReplica => ({
  state: {
    leftEntity: LEFT,
    rightEntity: RIGHT,
    domain: DOMAIN,
    watchSeed: `0x${'55'.repeat(32)}`,
    deltas: PersistentAccountStateMap.fromEntries('deltas', [[1, createDefaultDelta(1)]]),
    locks: PersistentAccountStateMap.empty('locks'),
    swapOffers: PersistentAccountStateMap.empty('swapOffers'),
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    jNonce: 0,
    requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
    requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
  },
  status: 'active',
  mempool: [],
  currentFrame: {} as never,
  currentHeight: 0,
  rollbackCount: 0,
  proofHeader: { fromEntity: LEFT, toEntity: RIGHT, nextProofNonce: 1 },
  pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
  shadow: { rebalance: {
    policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
    submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
  } },
} as AccountReplica);

const env = (): RuntimeReplica => {
  const value = createEmptyEnv('account-j-parity');
  value.state.jReplicas.set('account-j-parity', {
    name: 'account-j-parity',
    chainId: DOMAIN.chainId,
    depositoryAddress: DOMAIN.depositoryAddress,
    contracts: {
      depository: DOMAIN.depositoryAddress,
      entityProvider: `0x${'77'.repeat(20)}`,
      account: `0x${'88'.repeat(20)}`,
      deltaTransformer: `0x${'99'.repeat(20)}`,
    },
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
  });
  value.state.eReplicas.set('left-validator', {
    entityId: LEFT,
    signerId: `0x${'66'.repeat(20)}`,
    entityEncPubKey: '',
    state: {
      entityId: LEFT,
      config: {
        jurisdiction: {
          chainId: DOMAIN.chainId,
          depositoryAddress: DOMAIN.depositoryAddress,
          entityProviderAddress: `0x${'77'.repeat(20)}`,
        },
      },
    },
  } as never);
  return value;
};

const rawClaim = (): Extract<AccountTx, { type: 'j_event_claim' }> => ({
  type: 'j_event_claim',
  data: { jHeight: 7, jBlockHash: BLOCK_HASH, events: [settledEvent] },
});

describe('account J-event validate/commit parity', () => {
  test.each([true, false])('unsolicited custody cannot add proof assets; includes normal funding: %s', includeAdmitted => {
    const runtime = env();
    let account = machine();
    const transformer = `0x${'99'.repeat(20)}`;
    const beforeProof = buildAccountProofBody(account, transformer).proofBodyHash;
    const claim = rawClaim();
    // A real R2C receipt does not advance the Account nonce. The first row is
    // the already agreed asset; the other 127 are unsolicited company shares.
    claim.data.events = Array.from({ length: includeAdmitted ? 128 : 127 }, (_, index) => ({
      type: 'AccountSettled',
      data: { ...settledEvent.data, tokenId: index + (includeAdmitted ? 1 : 2), nonce: 0 },
      logIndex: index,
    }));
    for (const byLeft of [true, false]) {
      const transition = beginAccountTransition(account);
      const draft = accountTransitionView(transition);
      const session = createAccountJClaimSession(getAccountJClaimNodeStore(runtime));
      const prepared = prepareAccountJClaimTx(draft.state, claim, DOMAIN, session);
      expect(handleJEventClaim(draft, prepared, byLeft, 100, LEFT, [], runtime.state, session).ok).toBe(true);
      account = commitAccountTransition(transition).account;
      cacheCommittedAccountJClaimNodeChanges(runtime, session.changes());
    }
    expect(account.state.deltas.size).toBe(1);
    expect(account.state.deltas.get(1)?.collateral).toBe(includeAdmitted ? 125n : 0n);
    expect(account.state.deltas.get(1)?.ondelta).toBe(includeAdmitted ? 7n : 0n);
    expect(account.state.jNonce).toBe(0);
    expect(account.state.lastFinalizedJHeight).toBe(7);
    expect(buildAccountProofBody(account, transformer).proofBodyHash).toBe(beforeProof);
  });

  test('independently verifies both proofs, applies once, and retains no finalized body', () => {
    const runtime = env();
    const live = machine();
    const firstTransition = beginAccountTransition(live);
    const firstDraft = accountTransitionView(firstTransition);
    const firstSession = createAccountJClaimSession(getAccountJClaimNodeStore(runtime));
    const leftClaim = prepareAccountJClaimTx(firstDraft.state, rawClaim(), DOMAIN, firstSession);
    expect(handleJEventClaim(firstDraft, leftClaim, true, 99, LEFT, [], runtime.state, firstSession).ok)
      .toBe(true);
    expect(live.state.leftPendingJClaims.count).toBe(0n);
    const initial = commitAccountTransition(firstTransition).account;
    cacheCommittedAccountJClaimNodeChanges(runtime, firstSession.changes());
    expect(initial.state.leftPendingJClaims.count).toBe(1n);

    const proofSession = createAccountJClaimSession(getAccountJClaimNodeStore(runtime));
    const rightClaim = prepareAccountJClaimTx(initial.state, rawClaim(), DOMAIN, proofSession);
    const validationTransition = beginAccountTransition(initial);
    const commitTransition = beginAccountTransition(initial);
    const validationSession = createAccountJClaimSession(getAccountJClaimNodeStore(runtime));
    const commitSession = createAccountJClaimSession(getAccountJClaimNodeStore(runtime));
    const validationResult = handleJEventClaim(
      accountTransitionView(validationTransition), rightClaim, false, 100, LEFT, [], runtime.state, validationSession,
    );
    const commitResult = handleJEventClaim(
      accountTransitionView(commitTransition), rightClaim, false, 100, LEFT, [], runtime.state, commitSession,
    );

    expect(initial.state.lastFinalizedJHeight).toBe(0);
    expect(initial.state.leftPendingJClaims.count).toBe(1n);
    const validation = commitAccountTransition(validationTransition).account;
    const commit = commitAccountTransition(commitTransition).account;
    expect(validationResult.ok).toBe(true);
    expect(commitResult.ok).toBe(true);
    expect(computeAccountStateRoot(validation.state)).toBe(computeAccountStateRoot(commit.state));
    expect(validation.state.lastFinalizedJHeight).toBe(7);
    expect(validation.state.deltas.get(1)).toEqual(commit.state.deltas.get(1));
    expect(validation.state.leftPendingJClaims.count).toBe(0n);
    expect(validation.state.rightPendingJClaims.count).toBe(0n);
    expect('jEventChain' in validation).toBe(false);
  });

  test('keeps exact retries idempotent and rejects a conflicting claim without mutation', () => {
    const runtime = env();
    const account = accountTransitionView(beginAccountTransition(machine()));
    const firstSession = createAccountJClaimSession(getAccountJClaimNodeStore(runtime));
    const first = prepareAccountJClaimTx(account.state, rawClaim(), DOMAIN, firstSession);
    expect(handleJEventClaim(account, first, true, 99, LEFT, [], runtime.state, firstSession).ok)
      .toBe(true);
    cacheCommittedAccountJClaimNodeChanges(runtime, firstSession.changes());
    const pendingLeft = account.state.leftPendingJClaims;
    const pendingRight = account.state.rightPendingJClaims;

    const retrySession = createAccountJClaimSession(getAccountJClaimNodeStore(runtime));
    const retry = prepareAccountJClaimTx(account.state, rawClaim(), DOMAIN, retrySession);
    expect(handleJEventClaim(account, retry, true, 100, LEFT, [], runtime.state, retrySession))
      .toMatchObject({ ok: true, outcome: 'applied', events: ['ℹ️ j_event_claim idempotent'] });
    expect(account.state.leftPendingJClaims).toEqual(pendingLeft);
    expect(account.state.rightPendingJClaims).toEqual(pendingRight);

    const conflict: Extract<AccountTx, { type: 'j_event_claim' }> = {
      ...rawClaim(),
      data: {
        ...rawClaim().data,
        events: [{ ...settledEvent, data: { ...settledEvent.data, collateral: '126' } }],
      },
    };
    const conflictSession = createAccountJClaimSession(getAccountJClaimNodeStore(runtime));
    const preparedConflict = prepareAccountJClaimTx(account.state, conflict, DOMAIN, conflictSession);
    const result = handleJEventClaim(
      account,
      preparedConflict,
      true,
      101,
      LEFT,
      [],
      runtime.state,
      conflictSession,
    );

    expect(result).toEqual({
      ok: false,
      events: [],
      rejection: {
        kind: 'validation',
        code: ACCOUNT_TX_REJECTION_CODES.validation,
        message: 'ACCOUNT_J_CLAIM_LEFT_CONFLICT:left:7',
      },
    });
    expect(account.state.leftPendingJClaims).toEqual(pendingLeft);
    expect(account.state.rightPendingJClaims).toEqual(pendingRight);
  });

  test('orders claims by account and height without moving unrelated account operations', () => {
    const claim = (jHeight: number): JEventAccountTx => ({
      accountId: RIGHT,
      tx: {
        ...rawClaim(),
        data: {
          ...rawClaim().data,
          jHeight,
          jBlockHash: `0x${jHeight.toString(16).padStart(64, '0')}`,
        },
      },
    });
    const unrelated: JEventAccountTx = {
      accountId: RIGHT,
      tx: { type: 'add_delta', data: { tokenId: 1 } },
    };
    const ops = [claim(9), unrelated, claim(2), claim(5)];

    mergeJEventClaimOps(ops);

    expect(ops[1]).toBe(unrelated);
    expect(ops.filter((op) => op.tx.type === 'j_event_claim').map((op) => (
      op.tx.type === 'j_event_claim' ? op.tx.data.jHeight : -1
    ))).toEqual([2, 5, 9]);
  });
});
