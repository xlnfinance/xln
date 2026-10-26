import { strict as assert } from 'node:assert';
import type { EmbeddedRuntimeAdapter } from '../../../core/api/runtime-adapter/embedded';
import { buildPaymentRuntimeInput } from '../../../core/api/payments/command';
import { quoteHtlcPaymentRoute } from '../../../core/pathfinding/htlc-quote';
import { deriveSwapNetAuthorization } from '../../../core/account/swap/swap-net-authorization';
import { deriveDelta } from '../../../core/account/utils';
import { computeAccountStateRoot } from '../../../core/account/commitment/state-root';
import type { RuntimeReplica } from '../../../core/runtime/types';
import { safeStringify } from '../../../core/protocol/serialization';
import type { EntityTx } from '../../../core/types/entity-tx';
import { waitForRuntimeWorkDrained } from '../../../core/runtime';
import { registerStructuredLogSink, type StructuredLogEvent } from '../../../core/support/logger';
import { assertLendingCovenant, lendingExitAmount } from '../../../core/protocol/dispute/lending-covenant';
import { hubs, users, replica, account, waitFor, type Party } from '../cross-swap-context';

// Same-jurisdiction launch flows on the native TVM hub: Pay, Swap and Lending.
// Every party is bound to the native TVM Depository domain; nothing here is
// Ethereum. Amounts are atomic units of the 6-decimal TVM registry tokens.
export const hub = hubs[1], alice = users[1], bob = users[3];
export const ROUTING_FEE_PPM = 1_000;
export const SWAP_TAKER_FEE_BPS = 10;
export const PAY_AMOUNT = 30_000_000n;
export const SWAP_USD = 25_000_000n;
export const SWAP_TRX = 100_000_000n;
export const TRX_CREDIT = 1_000_000_000n;
export const SAVINGS = 5_000_000n;
export const LOAN = 2_500_000n;
export const POSITION = 'lend-7a11ce0000000001';
export const REQUEST = 'borrow-b0b0000000000001';
const TERM_MS = 3_600_000;
// The replay assertion observes the proposer's `account` WARN through an
// in-process sink. Worker-thread Account execution logs outside this sink, and
// a raised level or scope filter suppresses it, so refuse to start without them.
assert.equal(process.env['XLN_TS_ACCOUNT_WORKERS'], '0', 'Same-J replay proof requires inline Account execution');
assert(['', 'trace', 'debug', 'info', 'warn'].includes((process.env['XLN_LOG_LEVEL'] ?? '').toLowerCase()), 'account WARN logs required');
assert(!process.env['XLN_LOG_SCOPES'] || process.env['XLN_LOG_SCOPES'].split(',').map(scope => scope.trim().toLowerCase())
  .includes('account'), 'account log scope required');

export type Envs = { hubEnv: RuntimeReplica; userEnv: RuntimeReplica; hubWallet: EmbeddedRuntimeAdapter; userWallet: EmbeddedRuntimeAdapter };
const walletOf = (envs: Envs, owner: Party) => (owner === hub ? envs.hubWallet : envs.userWallet);
export const send = (envs: Envs, owner: Party, entityTxs: EntityTx[]) => walletOf(envs, owner).send({
  runtimeTxs: [], entityInputs: [{ entityId: owner.entityId, signerId: owner.signerId, entityTxs }] });

export const tokenView = (env: RuntimeReplica, owner: Party, peer: Party, tokenId: number) => {
  const value = account(env, owner, peer);
  assert(value, `Missing account ${owner.name}`);
  const delta = value.state.deltas.get(tokenId);
  assert(delta, `Missing token ${tokenId} on ${owner.name}`);
  return deriveDelta(delta, value.state.leftEntity === owner.entityId);
};
/** Signed claim of `owner` on `peer`: positive means the peer owes the owner. */
export const position = (env: RuntimeReplica, owner: Party, peer: Party, tokenId: number) => {
  const view = tokenView(env, owner, peer, tokenId);
  return view.outCollateral + view.outPeerCredit - view.inOwnCredit;
};
export const pairQuiet = (envs: Envs, user: Party) => {
  const left = account(envs.userEnv, user, hub), right = account(envs.hubEnv, hub, user);
  return Boolean(left && right && !left.pendingFrame && !right.pendingFrame && !left.mempool.length &&
    !right.mempool.length && computeAccountStateRoot(left.state) === computeAccountStateRoot(right.state));
};
export const positions = (envs: Envs) => Object.fromEntries([alice, bob].flatMap(user => [1, 2].map(tokenId => {
  const has = account(envs.userEnv, user, hub)?.state.deltas.has(tokenId);
  return [`${user.name}:${tokenId}`, has ? position(envs.userEnv, user, hub, tokenId) : null];
})));

export const configureFees = async (envs: Envs) => {
  await send(envs, hub, [{ type: 'setHubConfig', data: { matchingStrategy: 'amount', policyVersion: 2,
    routingFeePPM: ROUTING_FEE_PPM, baseFee: 0n, swapTakerFeeBps: SWAP_TAKER_FEE_BPS,
    rebalanceLiquidityFeeBps: 0n, rebalanceTimeoutMs: 60_000 } }]);
  await waitFor('hub fee profile visible to users', () => {
    const metadata = envs.userEnv.gossip.getProfile(hub.entityId)?.metadata;
    return metadata?.routingFeePPM === ROUTING_FEE_PPM && Number(metadata.swapTakerFeeBps) === SWAP_TAKER_FEE_BPS;
  }, 30_000);
};

export const pay = async (envs: Envs) => {
  const before = positions(envs);
  const hubBefore = position(envs.hubEnv, hub, alice, 1) + position(envs.hubEnv, hub, bob, 1);
  const path = [alice.entityId, hub.entityId, bob.entityId];
  const quote = quoteHtlcPaymentRoute(envs.userEnv.gossip.getProfiles(), path, 1, PAY_AMOUNT);
  const fee = quote.senderLockAmount - PAY_AMOUNT;
  assert(fee > 0n, 'A nonzero TVM hub routing fee must be charged');
  await envs.userWallet.send(buildPaymentRuntimeInput({ entityId: alice.entityId, signerId: alice.signerId,
    targetEntityId: bob.entityId, tokenId: 1, deliveryMode: 'instant', description: 'native TVM pay',
    route: { path, totalFee: fee, senderAmount: quote.senderLockAmount, recipientAmount: PAY_AMOUNT } }));
  await waitFor('TVM payment settled', () => pairQuiet(envs, alice) && pairQuiet(envs, bob) &&
    position(envs.userEnv, bob, hub, 1) === before[`${bob.name}:1`]! + PAY_AMOUNT &&
    tokenView(envs.userEnv, alice, hub, 1).outTotalHold === 0n, 30_000);
  assert.equal(position(envs.userEnv, alice, hub, 1), before[`${alice.name}:1`]! - quote.senderLockAmount);
  assert.equal(position(envs.hubEnv, hub, alice, 1) + position(envs.hubEnv, hub, bob, 1), hubBefore + fee);
  return { amount: PAY_AMOUNT, fee, senderDebit: quote.senderLockAmount, before, after: positions(envs) };
};

const offer = (offerId: string, give: [number, bigint], want: [number, bigint]): EntityTx => ({
  type: 'placeSwapOffer', data: { counterpartyEntityId: hub.entityId, offerId,
    giveTokenId: give[0], giveTokenDecimals: 6, giveAmount: give[1],
    wantTokenId: want[0], wantTokenDecimals: 6, wantAmount: want[1],
    ...deriveSwapNetAuthorization(want[1], SWAP_TAKER_FEE_BPS) } });

export const swap = async (envs: Envs) => {
  for (const user of [alice, bob]) {
    await send(envs, user, [{ type: 'extendCredit', data: { counterpartyEntityId: hub.entityId, tokenId: 2, amount: TRX_CREDIT } }]);
    await send(envs, hub, [{ type: 'extendCredit', data: { counterpartyEntityId: user.entityId, tokenId: 2, amount: TRX_CREDIT } }]);
    await waitFor(`TRX credit ${user.name}`, () => pairQuiet(envs, user) && Boolean(account(envs.userEnv, user, hub)?.state.deltas.has(2)) &&
      tokenView(envs.userEnv, user, hub, 2).ownCreditLimit === TRX_CREDIT && tokenView(envs.userEnv, user, hub, 2).peerCreditLimit === TRX_CREDIT);
  }
  const before = positions(envs);
  // Maker Alice buys TRX for USD; taker Bob sells the same TRX and pays the taker fee.
  await send(envs, alice, [offer('native-tvm-alice-buy-trx', [1, SWAP_USD], [2, SWAP_TRX])]);
  await waitFor('maker resting on TVM hub book', () =>
    Boolean(account(envs.hubEnv, hub, alice)?.state.swapOffers?.get('native-tvm-alice-buy-trx')) && pairQuiet(envs, alice));
  await send(envs, bob, [offer('native-tvm-bob-sell-trx', [2, SWAP_TRX], [1, SWAP_USD])]);
  await waitFor('same-J TVM swap filled', () => [alice, bob].every(user => pairQuiet(envs, user) &&
    (account(envs.userEnv, user, hub)?.state.swapOffers?.size ?? 0) === 0) &&
    position(envs.userEnv, alice, hub, 2) !== before[`${alice.name}:2`], 30_000);
  const fee = SWAP_USD * BigInt(SWAP_TAKER_FEE_BPS) / 10_000n;
  const after = positions(envs);
  assert.deepEqual(after, { ...before,
    [`${alice.name}:1`]: before[`${alice.name}:1`]! - SWAP_USD, [`${alice.name}:2`]: before[`${alice.name}:2`]! + SWAP_TRX,
    [`${bob.name}:1`]: before[`${bob.name}:1`]! + SWAP_USD - fee, [`${bob.name}:2`]: before[`${bob.name}:2`]! - SWAP_TRX });
  return { usd: SWAP_USD, trx: SWAP_TRX, takerFee: fee, before, after };
};

const book = (envs: Envs) => {
  const value = replica(envs.hubEnv, hub).state.lending;
  assert(value, 'TVM bank lending book missing');
  return value;
};
const onlyLoan = (envs: Envs) => {
  const loans = [...book(envs).loans.values()];
  assert.equal(loans.length, 1);
  return loans[0]!;
};

export const lending = async (envs: Envs) => {
  const domain = account(envs.hubEnv, hub, alice)!.state.domain;
  assert.equal(account(envs.hubEnv, hub, bob)!.state.domain.chainId, domain.chainId);
  const expiresAt = envs.hubEnv.state.timestamp + 10 * TERM_MS;
  await send(envs, hub, [
    { type: 'lendingSetTerms', data: { ...domain, tokenId: 1, termId: '1h', savingsInterestBps: 100,
      loanInterestBps: 200, loanLateMs: TERM_MS, expiresAt } },
    { type: 'lendingApprove', data: { borrowerEntityId: alice.entityId, tokenId: 1, termId: '1h', maxPrincipal: 2n * LOAN, expiresAt } },
  ]);
  await waitFor('TVM bank terms and facility', () => {
    const value = replica(envs.hubEnv, hub).state.lending;
    return (value?.facilities?.size ?? 0) === 1 && (value?.terms?.size ?? 0) === 1;
  });
  const start = positions(envs);
  await send(envs, bob, [{ type: 'lendingOffer', data: { positionId: POSITION, hubEntityId: hub.entityId,
    tokenId: 1, amount: SAVINGS, termId: '1h', interestBps: 100 } }]);
  await waitFor('TVM savings funded', () => book(envs).savings.get(POSITION)?.status === 'open' && pairQuiet(envs, bob));
  assert.equal(position(envs.userEnv, bob, hub, 1), start[`${bob.name}:1`]! - SAVINGS);
  const borrow: EntityTx = { type: 'lendingBorrow', data: { requestId: REQUEST, hubEntityId: hub.entityId, tokenId: 1,
    amount: LOAN, termId: '1h', maxInterestBps: 200, maxLateMs: TERM_MS, expiresAt: envs.userEnv.state.timestamp + 300_000 } };
  await send(envs, alice, [borrow]);
  await waitFor('TVM term loan disbursed', () => book(envs).loans.size === 1 && onlyLoan(envs).status === 'active' && pairQuiet(envs, alice));
  assert.equal(position(envs.userEnv, alice, hub, 1), start[`${alice.name}:1`]! + LOAN);
  const active = onlyLoan(envs);
  assert.equal(active.principalAmount, LOAN);
  // Exact duplicate signed request. The facility cap (2 * LOAN) would admit a
  // second draw, so only the Account intent-replay reject can stop it. The
  // borrower's proposer evicts the replayed lending_borrow_request with
  // LENDING_INTENT_REPLAY (lending.ts:261-265), so no Account frame commits.
  const intentKey = `borrow:${REQUEST}`;
  assert(account(envs.userEnv, alice, hub)!.state.lendingIntents?.has(intentKey) === true, 'first borrow consumed its intent');
  const duplicateHeight = account(envs.userEnv, alice, hub)!.currentHeight;
  const duplicateEntityHeight = replica(envs.userEnv, alice).state.height;
  const rejections: StructuredLogEvent[] = [];
  const stopObserving = registerStructuredLogSink(event => {
    if (event.scope === 'account' && event.message === 'frame.validation_failed') rejections.push(event);
  });
  try {
    await send(envs, alice, [borrow]);
    await waitFor('duplicate borrow processed by the borrower Entity', () =>
      replica(envs.userEnv, alice).state.height > duplicateEntityHeight && pairQuiet(envs, alice));
    for (const env of [envs.userEnv, envs.hubEnv]) assert(await waitForRuntimeWorkDrained(env, 10_000), 'duplicate borrow work drained');
  } finally {
    stopObserving();
  }
  // Exactly one rejection, and it is the intent replay: not another reject, not a silent omission.
  assert.deepEqual(JSON.parse(safeStringify(rejections.map(({ txType, rejection }) => ({ txType, rejection })))), [{
    txType: 'lending_borrow_request',
    rejection: { code: 'ACCOUNT_TX_VALIDATION', kind: 'validation', message: `LENDING_INTENT_REPLAY:${intentKey}` },
  }]);
  assert(pairQuiet(envs, alice));
  assert.equal(account(envs.userEnv, alice, hub)!.currentHeight, duplicateHeight, 'replayed borrow committed no Account frame');
  assert.equal(account(envs.hubEnv, hub, alice)!.currentHeight, duplicateHeight);
  assert.equal(book(envs).loans.size, 1);
  assert.equal(account(envs.userEnv, alice, hub)!.state.subcontracts?.size, 1);
  assert.equal(position(envs.userEnv, alice, hub, 1), start[`${alice.name}:1`]! + LOAN);
  // Repayment equals the canonical covenant exit at the committed frame clock.
  const covenant = structuredClone(account(envs.userEnv, alice, hub)!.state.subcontracts?.get(active.loanId));
  assertLendingCovenant(covenant);
  const repayHeight = account(envs.userEnv, alice, hub)!.currentHeight;
  await send(envs, alice, [{ type: 'lendingRepay', data: { hubEntityId: hub.entityId, loanId: active.loanId, tokenId: 1, amount: 20_000_000n } }]);
  await waitFor('TVM loan repaid', () => onlyLoan(envs).status === 'repaid' && pairQuiet(envs, alice), 30_000);
  const repaid = onlyLoan(envs);
  const repayFrame = account(envs.userEnv, alice, hub)!.currentFrame;
  assert.equal(repayFrame.height, repayHeight + 1, 'repayment is the single next Account frame');
  assert(repayFrame.accountTxs.some(tx => tx.type === 'lending_repay' && tx.data.loanId === active.loanId));
  const exitAmount = lendingExitAmount(covenant, repayFrame.timestamp);
  assert.equal(repaid.repaidAmount, exitAmount, 'repaidAmount equals lendingExitAmount at the repay frame');
  const interest = repaid.repaidAmount - LOAN;
  assert.equal(position(envs.userEnv, alice, hub, 1), start[`${alice.name}:1`]! + LOAN - exitAmount,
    'overpayment debits exactly lendingExitAmount');
  await send(envs, bob, [{ type: 'lendingClosePosition', data: { hubEntityId: hub.entityId, positionId: POSITION } }]);
  await waitFor('TVM savings closed', () => book(envs).savings.get(POSITION)?.status === 'closed' && pairQuiet(envs, bob), 30_000);
  assert.equal(position(envs.userEnv, bob, hub, 1), start[`${bob.name}:1`]!, 'early exit returns exact principal, no coupon');
  for (const user of [alice, bob]) {
    assert.equal(account(envs.userEnv, user, hub)!.state.subcontracts?.size ?? 0, 0);
    assert.equal(account(envs.hubEnv, hub, user)!.state.subcontracts?.size ?? 0, 0);
  }
  return { domain, loanId: repaid.loanId, principal: LOAN, repaidAmount: repaid.repaidAmount, interest,
    repayFrame: { height: repayFrame.height, timestamp: repayFrame.timestamp }, exitAmount, duplicateHeight,
    savings: SAVINGS, start, after: positions(envs) };
};
