import { expect, test } from 'bun:test';

import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';
import { EMPTY_ACCOUNT_STATE_ROOT } from '../account/state-root';
import {
  recordSwapClosedLifecycle,
  recordSwapOfferLifecycle,
  recordSwapResolveLifecycle,
} from '../account/tx/handlers/swap-history';
import { LIMITS } from '../constants';
import { setHtlcRouteNote, terminateHtlcRoute } from '../entity/tx/htlc-route-lifecycle';
import { applyHtlcTimeoutFollowups } from '../entity/tx/handlers/account/committed-htlc-followups';
import { createEmptyEnv } from '../runtime';
import type { AccountMachine, EntityState, SwapOffer } from '../types';
import { validateAccountMachine, validateEntityState } from '../validation-utils';

const leftEntity = `0x${'11'.repeat(32)}`;
const rightEntity = `0x${'22'.repeat(32)}`;
const proposer = `0x${'33'.repeat(20)}`;

const makeAccount = (): AccountMachine => ({
  leftEntity,
  rightEntity,
  domain: {
    chainId: 31337,
    depositoryAddress: `0x${'dd'.repeat(20)}`,
  },
  watchSeed: `0x${'44'.repeat(32)}`,
  status: 'active',
  mempool: [],
  currentFrame: {
    height: 0,
    timestamp: 0,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: '',
    accountStateRoot: EMPTY_ACCOUNT_STATE_ROOT,
    deltas: [],
    stateHash: '',
    byLeft: true,
  },
  deltas: new Map(),
  locks: new Map(),
  swapOffers: new Map(),
  pulls: new Map(),
  swapOrderHistory: new Map(),
  swapClosedOrders: new Map(),
  globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
  currentHeight: 0,
  pendingSignatures: [],
  rollbackCount: 0,
  leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
  rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
  lastFinalizedJHeight: 0,
  proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nextProofNonce: 1 },
  proofBody: { tokenIds: [], deltas: [] },
  disputeConfig: { leftDisputeDelay: 576, rightDisputeDelay: 576 },
  jNonce: 0,
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
});

const makeOffer = (index: number): SwapOffer => ({
  offerId: `offer-${index.toString().padStart(4, '0')}`,
  giveTokenId: 1,
  giveAmount: 100n,
  wantTokenId: 2,
  wantAmount: 50n,
  makerIsLeft: true,
  createdHeight: index + 1,
});

const makeEntity = (): EntityState => ({
  entityId: leftEntity,
  height: 0,
  timestamp: 1,
  nonces: new Map(),
  messages: [],
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
  jBlockChain: [],
  entityEncPubKey: `0x${'77'.repeat(32)}`,
  entityEncPrivKey: `0x${'88'.repeat(32)}`,
  profile: { name: 'bounds', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
});

test('terminal swap histories retain a deterministic bounded tail without losing active rows', () => {
  const account = makeAccount();
  const activeOffer = makeOffer(9_999);
  account.swapOffers.set(activeOffer.offerId, activeOffer);
  recordSwapOfferLifecycle(account, activeOffer);
  const count = LIMITS.MAX_ACCOUNT_TERMINAL_SWAP_HISTORY + 1;
  for (let index = 0; index < count; index += 1) {
    const offer = makeOffer(index);
    recordSwapOfferLifecycle(account, offer);
    recordSwapResolveLifecycle(account, offer.offerId, index + 1, {
      fillRatio: 0xffff,
      cancelRemainder: true,
      height: index + 1,
    });
    recordSwapClosedLifecycle(account, offer.offerId);
  }

  expect(account.swapClosedOrders).toHaveLength(LIMITS.MAX_ACCOUNT_TERMINAL_SWAP_HISTORY);
  expect(account.swapOrderHistory).toHaveLength(LIMITS.MAX_ACCOUNT_TERMINAL_SWAP_HISTORY + 1);
  expect(account.swapOrderHistory?.has(activeOffer.offerId)).toBe(true);
  expect(account.swapClosedOrders?.has('offer-0000')).toBe(false);
  expect(account.swapClosedOrders?.has(`offer-${(count - 1).toString().padStart(4, '0')}`)).toBe(true);
});

test('swap resolve detail retains only the deterministic newest tail', () => {
  const account = makeAccount();
  const offer = makeOffer(0);
  recordSwapOfferLifecycle(account, offer);
  for (let index = 0; index <= LIMITS.MAX_ACCOUNT_SWAP_RESOLVES_PER_ORDER; index += 1) {
    recordSwapResolveLifecycle(account, offer.offerId, index + 1, {
      fillRatio: index,
      cancelRemainder: false,
      height: index + 1,
    });
  }

  const resolves = account.swapOrderHistory?.get(offer.offerId)?.resolves ?? [];
  expect(resolves).toHaveLength(LIMITS.MAX_ACCOUNT_SWAP_RESOLVES_PER_ORDER);
  expect(resolves[0]?.height).toBe(2);
});

test('swap lifecycle text bounds reject before mutating the projection', () => {
  const account = makeAccount();
  const oversizedOffer = {
    ...makeOffer(0),
    offerId: 'x'.repeat(LIMITS.MAX_ACCOUNT_SWAP_HISTORY_TEXT + 1),
  };
  expect(() => recordSwapOfferLifecycle(account, oversizedOffer)).toThrow(
    'ACCOUNT_SWAP_HISTORY_OFFER_ID_INVALID',
  );
  expect(account.swapOrderHistory).toHaveLength(0);

  const offer = makeOffer(1);
  recordSwapOfferLifecycle(account, offer);
  expect(() => recordSwapResolveLifecycle(account, offer.offerId, 2, {
    fillRatio: 1,
    cancelRemainder: false,
    height: 2,
    comment: 'x'.repeat(LIMITS.MAX_ACCOUNT_SWAP_HISTORY_TEXT + 1),
  })).toThrow('ACCOUNT_SWAP_HISTORY_COMMENT_TOO_LONG');
  expect(account.swapOrderHistory?.get(offer.offerId)?.resolves).toHaveLength(0);
});

test('terminating an HTLC removes both validator-local note lookup keys', () => {
  const state = makeEntity();
  const hashlock = `0x${'99'.repeat(32)}`;
  const lockId = `0x${'aa'.repeat(32)}`;
  state.htlcRoutes.set(hashlock, {
    hashlock,
    outboundEntity: rightEntity,
    outboundLockId: lockId,
    createdTimestamp: 1,
  });
  state.htlcNotes?.set(`hashlock:${hashlock}`, 'coffee');
  state.htlcNotes?.set(`lock:${lockId}`, 'coffee');

  terminateHtlcRoute(state, hashlock, 2);

  expect(state.htlcRoutes).toHaveLength(0);
  expect(state.htlcNotes).toHaveLength(0);
});

test('timeout terminal activity is emitted before its HTLC notes are removed', () => {
  const state = makeEntity();
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
  state.htlcNotes?.set(`hashlock:${hashlock}`, 'timeout note');
  state.htlcNotes?.set(`lock:${lockId}`, 'timeout note');
  const env = createEmptyEnv('terminal-note-timeout');

  applyHtlcTimeoutFollowups({
    env,
    state,
    newState: state,
    input: { fromEntityId: rightEntity, toEntityId: leftEntity, watchSeed: account.watchSeed },
    accountMachine: account,
    outputs: [],
    mempoolOps: [],
  }, [hashlock]);

  expect(env.frameLogs.some((entry) => entry.message === 'HtlcFailed')).toBe(true);
  expect(state.htlcRoutes).toHaveLength(0);
  expect(state.htlcNotes).toHaveLength(0);
});

test('HTLC note insertion rejects atomically at the Entity cap', () => {
  const state = makeEntity();
  state.htlcNotes = new Map(Array.from(
    { length: LIMITS.MAX_ENTITY_HTLC_NOTES },
    (_, index) => [`lock:${index}`, 'note'],
  ));
  const hashlock = `0x${'de'.repeat(32)}`;
  const lockId = `0x${'ef'.repeat(32)}`;

  expect(() => setHtlcRouteNote(state, hashlock, lockId, 'new note')).toThrow(
    'ENTITY_HTLC_NOTE_LIMIT_EXCEEDED',
  );
  expect(state.htlcNotes).toHaveLength(LIMITS.MAX_ENTITY_HTLC_NOTES);
  expect(state.htlcNotes.has(`hashlock:${hashlock}`)).toBe(false);
  expect(state.htlcNotes.has(`lock:${lockId}`)).toBe(false);
});

test('HTLC note text validation rejects before adding either lookup key', () => {
  const state = makeEntity();
  const hashlock = `0x${'12'.repeat(32)}`;
  const lockId = `0x${'34'.repeat(32)}`;
  expect(() => setHtlcRouteNote(
    state,
    hashlock,
    lockId,
    'x'.repeat(LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH + 1),
  )).toThrow('ENTITY_HTLC_NOTE_INVALID_LENGTH');
  expect(state.htlcNotes).toHaveLength(0);
});

test('decode validation rejects oversized swap history, resolve history, and HTLC notes', () => {
  const account = makeAccount();
  account.swapClosedOrders = new Map(Array.from(
    { length: LIMITS.MAX_ACCOUNT_TERMINAL_SWAP_HISTORY + 1 },
    (_, index) => {
      const offer = makeOffer(index);
      return [offer.offerId, {
        ...offer,
        originalGiveAmount: offer.giveAmount,
        originalWantAmount: offer.wantAmount,
        cancelRequested: false,
        lastUpdatedHeight: offer.createdHeight,
        resolves: [],
      }];
    },
  ));
  expect(() => validateAccountMachine(account, 'oversizedSwapHistory')).toThrow(
    'ACCOUNT_TERMINAL_SWAP_HISTORY_LIMIT_EXCEEDED',
  );

  const oversizedResolves = makeAccount();
  const offer = makeOffer(0);
  oversizedResolves.swapOrderHistory?.set(offer.offerId, {
    offerId: offer.offerId,
    giveTokenId: offer.giveTokenId,
    giveAmount: offer.giveAmount,
    originalGiveAmount: offer.giveAmount,
    wantTokenId: offer.wantTokenId,
    wantAmount: offer.wantAmount,
    originalWantAmount: offer.wantAmount,
    createdHeight: offer.createdHeight,
    cancelRequested: false,
    lastUpdatedHeight: offer.createdHeight,
    resolves: Array.from(
      { length: LIMITS.MAX_ACCOUNT_SWAP_RESOLVES_PER_ORDER + 1 },
      (_, index) => ({ fillRatio: index, cancelRemainder: false, height: index }),
    ),
  });
  expect(() => validateAccountMachine(oversizedResolves, 'oversizedSwapResolves')).toThrow(
    'ACCOUNT_SWAP_RESOLVE_HISTORY_LIMIT_EXCEEDED',
  );

  const state = makeEntity();
  state.htlcNotes = new Map(Array.from(
    { length: LIMITS.MAX_ENTITY_HTLC_NOTES + 1 },
    (_, index) => [`lock:${index}`, 'note'],
  ));
  expect(() => validateEntityState(state, 'oversizedHtlcNotes')).toThrow(
    'ENTITY_HTLC_NOTE_LIMIT_EXCEEDED',
  );
});
