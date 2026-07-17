import { describe, expect, test } from 'bun:test';

import { computeAccountStateRoot } from '../account/state-root';
import { handleJEventClaim } from '../account/tx/handlers/j-event-claim';
import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';
import { createAccountJClaimSession } from '../account/j-claim-session';
import { cacheCommittedAccountJClaimNodeChanges } from '../account/j-claim-store';
import { prepareAccountJClaimTx } from '../account/j-claim-transition';
import { mergeJEventClaimOps } from '../entity/tx/j-events-account';
import type { JEventMempoolOp } from '../entity/tx/j-events-types';
import { createEmptyEnv } from '../runtime';
import type { AccountMachine, AccountTx, Env, JurisdictionEvent } from '../types';
import { createDefaultDelta } from '../validation-utils';

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

const machine = (): AccountMachine => ({
  leftEntity: LEFT,
  rightEntity: RIGHT,
  domain: DOMAIN,
  watchSeed: `0x${'55'.repeat(32)}`,
  status: 'active',
  mempool: [],
  currentFrame: {} as never,
  deltas: new Map([[1, createDefaultDelta(1)]]),
  locks: new Map(),
  swapOffers: new Map(),
  globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
  currentHeight: 0,
  pendingSignatures: [],
  rollbackCount: 0,
  leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
  rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
  lastFinalizedJHeight: 0,
  proofHeader: { fromEntity: LEFT, toEntity: RIGHT, nextProofNonce: 1 },
  proofBody: { tokenIds: [], deltas: [] },
  disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
  jNonce: 0,
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
} as AccountMachine);

const env = (): Env => {
  const value = createEmptyEnv('account-j-parity');
  value.jReplicas.set('account-j-parity', {
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
  value.eReplicas.set('left-validator', {
    entityId: LEFT,
    signerId: `0x${'66'.repeat(20)}`,
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
  test('independently verifies both proofs, applies once, and retains no finalized body', () => {
    const runtime = env();
    const initial = machine();
    const firstSession = createAccountJClaimSession(runtime);
    const leftClaim = prepareAccountJClaimTx(initial, rawClaim(), DOMAIN, firstSession);
    expect(handleJEventClaim(initial, leftClaim, true, 99, false, LEFT, () => {}, runtime, firstSession).success)
      .toBe(true);
    cacheCommittedAccountJClaimNodeChanges(runtime, firstSession.changes());
    expect(initial.leftPendingJClaims.count).toBe(1n);

    const proofSession = createAccountJClaimSession(runtime);
    const rightClaim = prepareAccountJClaimTx(initial, rawClaim(), DOMAIN, proofSession);
    const validation = structuredClone(initial);
    const commit = structuredClone(initial);
    const validationSession = createAccountJClaimSession(runtime);
    const commitSession = createAccountJClaimSession(runtime);
    const validationResult = handleJEventClaim(
      validation, rightClaim, false, 100, true, LEFT, () => {}, runtime, validationSession,
    );
    const commitResult = handleJEventClaim(
      commit, rightClaim, false, 100, false, LEFT, () => {}, runtime, commitSession,
    );

    expect(validationResult.success).toBe(true);
    expect(commitResult.success).toBe(true);
    expect(computeAccountStateRoot(validation)).toBe(computeAccountStateRoot(commit));
    expect(validation.lastFinalizedJHeight).toBe(7);
    expect(validation.deltas.get(1)).toEqual(commit.deltas.get(1));
    expect(validation.leftPendingJClaims.count).toBe(0n);
    expect(validation.rightPendingJClaims.count).toBe(0n);
    expect('jEventChain' in validation).toBe(false);
  });

  test('orders claims by account and height without moving unrelated account operations', () => {
    const claim = (jHeight: number): JEventMempoolOp => ({
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
    const unrelated: JEventMempoolOp = {
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
