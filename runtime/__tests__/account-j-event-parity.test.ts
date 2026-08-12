import { describe, expect, test } from 'bun:test';

import { computeAccountStateRoot } from '../account/commitment/state-root';
import { handleJEventClaim } from '../account/tx/handlers/j-events/claim';
import { createEmptyAccountJClaimAccumulator } from '../account/j-claims/j-claim-accumulator';
import { createAccountJClaimSession } from '../account/j-claims/j-claim-session';
import {
  cacheCommittedAccountJClaimNodeChanges,
  getAccountJClaimNodeStore,
} from '../entity/account/account-j-claim-node-store';
import { prepareAccountJClaimTx } from '../account/j-claims/j-claim-transition';
import { mergeJEventClaimOps } from '../entity/tx/j-events-account';
import type { JEventAccountTx } from '../entity/tx/j-events-types';
import { createEmptyEnv } from '../runtime';
import type { AccountReplica, AccountTx } from '../types/account';
import type { RuntimeReplica } from '../runtime/types';
import type { JurisdictionEvent } from '../types/jurisdiction-events';
import { createDefaultDelta } from '../account/state/delta';

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
    deltas: new Map([[1, createDefaultDelta(1)]]),
    locks: new Map(),
    swapOffers: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    jNonce: 0,
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
  },
  status: 'active',
  mempool: [],
  currentFrame: {} as never,
  currentHeight: 0,
  pendingSignatures: [],
  rollbackCount: 0,
  proofHeader: { fromEntity: LEFT, toEntity: RIGHT, nextProofNonce: 1 },
  proofBody: { tokenIds: [], deltas: [] },
  pendingWithdrawals: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
} as AccountState);

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
  test('independently verifies both proofs, applies once, and retains no finalized body', () => {
    const runtime = env();
    const initial = machine();
    const firstSession = createAccountJClaimSession(getAccountJClaimNodeStore(runtime));
    const leftClaim = prepareAccountJClaimTx(initial.state, rawClaim(), DOMAIN, firstSession);
    expect(handleJEventClaim(initial, leftClaim, true, 99, false, LEFT, [], runtime.state, firstSession).success)
      .toBe(true);
    cacheCommittedAccountJClaimNodeChanges(runtime, firstSession.changes());
    expect(initial.state.leftPendingJClaims.count).toBe(1n);

    const proofSession = createAccountJClaimSession(getAccountJClaimNodeStore(runtime));
    const rightClaim = prepareAccountJClaimTx(initial.state, rawClaim(), DOMAIN, proofSession);
    const validation = structuredClone(initial);
    const commit = structuredClone(initial);
    const validationSession = createAccountJClaimSession(getAccountJClaimNodeStore(runtime));
    const commitSession = createAccountJClaimSession(getAccountJClaimNodeStore(runtime));
    const validationResult = handleJEventClaim(
      validation, rightClaim, false, 100, true, LEFT, [], runtime.state, validationSession,
    );
    const commitResult = handleJEventClaim(
      commit, rightClaim, false, 100, false, LEFT, [], runtime.state, commitSession,
    );

    expect(validationResult.success).toBe(true);
    expect(commitResult.success).toBe(true);
    expect(computeAccountStateRoot(validation.state)).toBe(computeAccountStateRoot(commit.state));
    expect(validation.state.lastFinalizedJHeight).toBe(7);
    expect(validation.state.deltas.get(1)).toEqual(commit.state.deltas.get(1));
    expect(validation.state.leftPendingJClaims.count).toBe(0n);
    expect(validation.state.rightPendingJClaims.count).toBe(0n);
    expect('jEventChain' in validation).toBe(false);
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
