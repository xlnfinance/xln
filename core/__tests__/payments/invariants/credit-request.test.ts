import { describe, expect, test } from 'bun:test';

import { applyAccountTx, applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { createDefaultDelta } from '../../../account/state/delta';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import {
  accountTransitionView,
  beginAccountTransition,
  commitAccountTransition,
} from '../../../account/state/candidate-overlay';
import { applyCommittedAccountFrameFollowups, type AccountTxTarget } from '../../../entity/tx/handlers/account/index';
import { handleRequestCreditEntityTx } from '../../../entity/tx/handlers/account/credit-request';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { getCreditRequestCapForToken } from '../../../account/config/defaults';
import type { AccountFrame, AccountReplica, AccountTx } from '../../../types/account';
import type { EntityState } from '../../../entity/types';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
// HUB < USER lexicographically: the hub is LEFT, so its grant to the user is
// rightCreditLimit (Channel.ts: a LEFT proposer writes the RIGHT limit).
const HUB = entity('10');
const USER = entity('30');
const OUTSIDER = entity('40');
const SIGNER = `0x${'44'.repeat(20)}`;
const FRAME_HASH = `0x${'55'.repeat(32)}`;
const REQUEST_ID = 'credit-1111111111111111';
const USDC = 1;
const WHOLE = 1_000_000n;

const makeAccount = (hubGrant = 0n): AccountReplica => {
  const delta = createDefaultDelta(USDC);
  delta.rightCreditLimit = hubGrant;
  return {
    state: {
      leftEntity: HUB,
      rightEntity: USER,
      domain: { chainId: 31_337, depositoryAddress: `0x${'88'.repeat(20)}` },
      watchSeed: `0x${'99'.repeat(32)}`,
      deltas: PersistentAccountStateMap.fromEntries('deltas', [[USDC, delta]]),
      disputeConfig: { leftResponseSeconds: 576, rightResponseSeconds: 576 },
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
      locks: PersistentAccountStateMap.empty('locks'),
      swapOffers: PersistentAccountStateMap.empty('swapOffers'),
      pulls: PersistentAccountStateMap.empty('pulls'),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      jNonce: 0,
    },
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 1, timestamp: 1_000, jHeight: 0, accountTxs: [], prevFrameHash: FRAME_HASH,
      deltas: [], stateHash: FRAME_HASH, accountStateRoot: `0x${'66'.repeat(32)}`, byLeft: true,
    },
    currentHeight: 1,
    rollbackCount: 0,
    proofHeader: { fromEntity: HUB, toEntity: USER, nextProofNonce: 1 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: {
      rebalance: {
        policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
        submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
      },
    },
  };
};

const makeState = (isHub: boolean, hubGrant = 0n): EntityState => ({
  entityId: HUB,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  proposals: new Map(),
  config: { mode: 'proposer-based', threshold: 1n, validators: [SIGNER], shares: { [SIGNER]: 1n } },
  reserves: new Map(),
  accounts: PersistentEntityAccountMap.empty(HUB, computeEntityAccountValueHash).updated(USER, makeAccount(hubGrant)),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  profile: { name: 'Hub', isHub, avatar: '', bio: '', website: '' },
  paybook: { entries: new Map(), feesEarned: 0n },
  swapTradingPairs: [],
});

const request = (amount: bigint, requesterEntityId = USER, requestId = REQUEST_ID): AccountTx => ({
  type: 'credit_request',
  data: { requestId, requesterEntityId, tokenId: USDC, amount },
});

const expectRejected = async (result: ReturnType<typeof applyAccountTxToMutableReplica>, message: string) => {
  const outcome = await result;
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('EXPECTED_CREDIT_REJECTION');
  expect(outcome.rejection.message).toContain(message);
};

const frame = (tx: AccountTx): AccountFrame => ({
  height: 2, timestamp: 2_000, jHeight: 0, accountTxs: [tx], prevFrameHash: FRAME_HASH,
  stateHash: FRAME_HASH, accountStateRoot: `0x${'66'.repeat(32)}`,
});

/** Commit one frame on the hub replica, then run its committed follow-ups. */
const commitOnHub = async (state: EntityState, tx: AccountTx, byLeft: boolean): Promise<AccountTxTarget[]> => {
  const transition = beginAccountTransition(state.accounts.get(USER)!);
  const result = await applyAccountTx(accountTransitionView(transition), tx, byLeft, 2_000, 0, false);
  expect(result.ok, result.ok ? undefined : result.rejection.message).toBe(true);
  state.accounts = state.accounts.updated(USER, commitAccountTransition(transition).account);
  const followups: AccountTxTarget[] = [];
  applyCommittedAccountFrameFollowups(state, USER, frame(tx), byLeft, followups, undefined, []);
  return followups;
};

describe('credit_request AccountTx', () => {
  test('accept: records only the replay intent and leaves the delta untouched', async () => {
    const account = makeAccount();
    const before = account.state.deltas.get(USDC)!;
    const result = await applyAccountTxToMutableReplica(account, request(25n * WHOLE), false);
    expect(result.ok).toBe(true);
    expect(result.events).toEqual([`Credit request ${REQUEST_ID} committed`]);
    expect([...account.state.lendingIntents!.entries()]).toEqual([[`credit:${REQUEST_ID}`, 'credit-request']]);
    expect(account.state.deltas.get(USDC)).toEqual(before);
  });

  test('replay rejected: the same id cannot commit twice, even with another amount', async () => {
    const account = makeAccount();
    expect((await applyAccountTxToMutableReplica(account, request(25n * WHOLE), false)).ok).toBe(true);
    await expectRejected(applyAccountTxToMutableReplica(account, request(50n * WHOLE), false), `LENDING_INTENT_REPLAY:credit:${REQUEST_ID}`);
  });

  test('non-party rejected: requester must be the frame proposer', async () => {
    // USER signs (byLeft=false) but names the hub, or an outsider, as requester.
    await expectRejected(applyAccountTxToMutableReplica(makeAccount(), request(1n, HUB), false), 'CREDIT_REQUEST_REQUESTER_NOT_PROPOSER');
    await expectRejected(applyAccountTxToMutableReplica(makeAccount(), request(1n, OUTSIDER), false), 'CREDIT_REQUEST_REQUESTER_NOT_PROPOSER');
  });

  test('zero amount, unknown lane and malformed id are rejected', async () => {
    await expectRejected(applyAccountTxToMutableReplica(makeAccount(), request(0n), false), 'CREDIT_REQUEST_AMOUNT_MUST_BE_POSITIVE');
    const noLane: AccountTx = { type: 'credit_request', data: { requestId: REQUEST_ID, requesterEntityId: USER, tokenId: 2, amount: 1n } };
    await expectRejected(applyAccountTxToMutableReplica(makeAccount(), noLane, false), 'CREDIT_REQUEST_TOKEN_NOT_ENABLED:2');
    await expectRejected(applyAccountTxToMutableReplica(makeAccount(), request(1n, USER, 'credit-XYZ'), false), 'CREDIT_REQUEST_ID_INVALID');
  });
});

describe('committed credit_request hub follow-up', () => {
  const cap = getCreditRequestCapForToken(USDC)!;

  test('the deterministic cap is 1,000 whole tokens', () => {
    expect(cap).toBe(1_000n * WHOLE);
    expect(getCreditRequestCapForToken(999)).toBeUndefined();
  });

  test('hub raises its line to min(requested, cap)', async () => {
    expect(await commitOnHub(makeState(true), request(25n * WHOLE), false)).toEqual([
      { accountId: USER, tx: { type: 'set_credit_limit', data: { tokenId: USDC, amount: 25n * WHOLE } } },
    ]);
    expect(await commitOnHub(makeState(true), request(5_000n * WHOLE), false)).toEqual([
      { accountId: USER, tx: { type: 'set_credit_limit', data: { tokenId: USDC, amount: cap } } },
    ]);
  });

  test('never lowers an existing larger line', async () => {
    expect(await commitOnHub(makeState(true, 2_000n * WHOLE), request(25n * WHOLE), false)).toEqual([]);
    expect(await commitOnHub(makeState(true, 25n * WHOLE), request(25n * WHOLE), false)).toEqual([]);
  });

  test('never replaces a larger owner grant already queued or in its pending frame', async () => {
    for (const location of ['mempool', 'pending'] as const) {
      const state = makeState(true);
      const account = state.accounts.get(USER);
      if (!account) throw new Error('TEST_ACCOUNT_MISSING');
      const grant: AccountTx = { type: 'set_credit_limit', data: { tokenId: USDC, amount: 100n * WHOLE } };
      state.accounts = state.accounts.updated(USER, location === 'mempool'
        ? { ...account, mempool: [grant] }
        : { ...account, pendingFrame: frame(grant), proofHeader: { ...account.proofHeader, fromEntity: HUB } });
      expect(await commitOnHub(state, request(25n * WHOLE), false)).toEqual([]);
    }
  });

  test('a peer pending grant does not masquerade as the hub own line', async () => {
    const state = makeState(true);
    const account = state.accounts.get(USER);
    if (!account) throw new Error('TEST_ACCOUNT_MISSING');
    state.accounts = state.accounts.updated(USER, { ...account,
      pendingFrame: frame({ type: 'set_credit_limit', data: { tokenId: USDC, amount: 100n * WHOLE } }),
      proofHeader: { ...account.proofHeader, fromEntity: USER },
    });
    expect(await commitOnHub(state, request(25n * WHOLE), false)).toEqual([
      { accountId: USER, tx: { type: 'set_credit_limit', data: { tokenId: USDC, amount: 25n * WHOLE } } },
    ]);
  });

  test('non-hub ignores, and a hub never answers its own request', async () => {
    expect(await commitOnHub(makeState(false), request(25n * WHOLE), false)).toEqual([]);
    expect(await commitOnHub(makeState(true), request(25n * WHOLE, HUB), true)).toEqual([]);
  });
});

describe('requestCredit EntityTx', () => {
  test('admits the local credit_request with the requester bound to this entity', () => {
    const state = { ...makeState(false), entityId: USER, accounts: PersistentEntityAccountMap.empty(USER, computeEntityAccountValueHash).updated(HUB, makeAccount()) };
    const result = handleRequestCreditEntityTx(state, {
      type: 'requestCredit',
      data: { counterpartyEntityId: HUB, tokenId: USDC, amount: 25n * WHOLE, requestId: REQUEST_ID },
    });
    expect(result.accountTxs).toEqual([{ accountId: HUB, tx: request(25n * WHOLE) }]);
    expect(() => handleRequestCreditEntityTx(state, {
      type: 'requestCredit',
      data: { counterpartyEntityId: OUTSIDER, tokenId: USDC, amount: 1n, requestId: REQUEST_ID },
    })).toThrow('CREDIT_REQUEST_ACCOUNT_MISSING');
  });
});
