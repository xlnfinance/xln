/**
 * Layer 1 cross-j fill progress: one uint16 ratio per order, Hub-internal.
 * The matcher fill reaches the book owner and the source Hub inside the
 * Entity frame; nothing enters a bilateral Account frame. Users learn the
 * outcome from the pull close, which retires the source offer.
 */
import { describe, expect, test } from 'bun:test';

import { applyEntityTx } from '../../../entity/tx/apply';
import { applyAccountTxToMutableReplica as applyAccountTx } from '../../../account/tx/apply';
import { createDefaultDelta } from '../../../account/state/delta';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { createEmptyEnv } from '../../../runtime';
import {
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullBinding,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute,
  deriveCrossJurisdictionPrivateSeed,
} from '../../../extensions/cross-j/index';
import {
  buildCrossJurisdictionCancelInstruction,
  buildCrossJurisdictionFillInstruction,
  crossJurisdictionBookAdmissionKeyFor,
  mergeCrossJurisdictionBookAdmission,
  type CrossJurisdictionFillInstruction,
} from '../../../extensions/cross-j/orderbook';
import { applyCrossJurisdictionOrderbookFill } from '../../../entity/tx/handlers/account-cross-j-followups';
import { buildCrossMarketOfferFromBookOrder } from '../../../entity/tx/handlers/account/orderbook/helpers';
import { createBook, getBookOrder } from '../../../orderbook';
import { replaceOrderbookPair } from '../../../orderbook/order-index';
import { crossJurisdictionBookQtyLots } from '../../../orderbook/cross-j/quantity';
import { createOrderbookExtState, getStaticSwapTokenDimensions, ORDERBOOK_PRICE_SCALE } from '../../../orderbook/types';
import { swapKey } from '../../../orderbook/swap-execution';
import type { EntityInput, EntityState } from '../../../entity/types';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import {
  addr,
  entity,
  getTestAccountForWrite,
  jref,
  makeAccount,
  makeJurisdiction,
  makeState,
  putTestAccountDelta,
  putTestAccountSwapOffer,
} from '../../helpers/cross-j';

const eth = makeJurisdiction('Ethereum', 1, '11', '12');
const base = makeJurisdiction('Base', 8453, '21', '22');
const sourceUser = entity('a1');
const sourceHub = entity('a2');
const targetHub = entity('a3');
const targetUser = entity('a4');
const sourceHubSigner = addr('b2');
const targetHubSigner = addr('b3');
const SOURCE_TOTAL = 40_000_000_000_000_000n;
const TARGET_TOTAL = 100_000_000_000_000_000_000n;
const NOW = 10_000;

const prepareRoute = (orderId: string, bookOwnerEntityId: string, runtimeSeed = `fill-progress:${orderId}`): CrossJurisdictionSwapRoute => ({
  ...buildPreparedCrossJurisdictionRoute(
    {
      orderId,
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      bookOwnerEntityId,
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      bookHubSignerId: bookOwnerEntityId === targetHub ? targetHubSigner : sourceHubSigner,
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: SOURCE_TOTAL },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: TARGET_TOTAL },
      status: 'resting',
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: 70_000,
    },
    { runtimeSeed, now: NOW },
  ),
  status: 'resting',
});

/** Book-owner Entity state with the admitted route, its live book and (on the source Hub) the Account offer. */
const bookOwnerState = (route: CrossJurisdictionSwapRoute, ownerId: string, signerId: string): {
  state: EntityState;
  namespacedOrderId: string;
} => {
  const counterparty = ownerId === sourceHub ? sourceUser : targetUser;
  const state = makeState(ownerId, signerId, ownerId === sourceHub ? eth : base, counterparty);
  state.timestamp = NOW;
  state.crossJurisdictionSwaps?.set(route.orderId, { ...route });
  if (ownerId === sourceHub) {
    const account = getTestAccountForWrite(state, sourceUser);
    putTestAccountSwapOffer(account, {
      offerId: route.orderId,
      ...getStaticSwapTokenDimensions(1, 1),
      giveTokenId: 1,
      giveAmount: SOURCE_TOTAL,
      wantTokenId: 1,
      wantAmount: TARGET_TOTAL,
      maxFee: 0n,
      minNetReceive: TARGET_TOTAL,
      priceTicks: 2_500n * ORDERBOOK_PRICE_SCALE,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route },
    });
  }
  const admission = mergeCrossJurisdictionBookAdmission(state, route, NOW);
  admission.status = 'admitted';
  admission.admittedAt = NOW;
  const namespacedOrderId = swapKey(sourceUser, route.orderId);
  const meta = buildCrossMarketOfferFromBookOrder(state, namespacedOrderId);
  if (!meta) throw new Error('TEST_CROSS_META_MISSING');
  state.orderbookExt = createOrderbookExtState({
    entityId: ownerId,
    name: 'Hub',
    spreadDistribution: { makerBps: 0, takerBps: 0, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
    referenceTokenId: 1,
    usdQuoteAuthorityEntityId: ownerId,
    minTradeSize: 0n,
    supportedPairs: [meta.pairId],
  });
  replaceOrderbookPair(state.orderbookExt, meta.pairId, createBook({ bucketWidthTicks: 10_000n, maxOrders: 10_000, stpPolicy: 1 }));
  return { state, namespacedOrderId };
};

const fillInstruction = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  namespacedOrderId: string,
  share: (lots: bigint) => bigint,
): CrossJurisdictionFillInstruction => {
  const meta = buildCrossMarketOfferFromBookOrder(state, namespacedOrderId);
  if (!meta) throw new Error('TEST_CROSS_META_MISSING');
  const filledLots = share(crossJurisdictionBookQtyLots(meta.baseTokenId, meta.baseAmount));
  const instruction = buildCrossJurisdictionFillInstruction(sourceUser, route.orderId, namespacedOrderId, meta, {
    filledLots,
    weightedCost: meta.priceTicks * filledLots,
  });
  if (!instruction) throw new Error('TEST_CROSS_FILL_INSTRUCTION_MISSING');
  return instruction;
};

const admissionOf = (state: EntityState, orderId: string) =>
  state.crossJurisdictionBookAdmissions?.get(crossJurisdictionBookAdmissionKeyFor(sourceUser, orderId));

const bookRow = (state: EntityState, pairId: string, namespacedOrderId: string) => {
  const book = state.orderbookExt?.books.get(pairId);
  return book ? getBookOrder(book, namespacedOrderId) : undefined;
};

describe('cross-j ratio-only fill progress', () => {
  test('partial fill on the source Hub book owner advances route and row without an Account tx or output', () => {
    const env = createEmptyEnv('fill-progress-partial');
    const route = prepareRoute('fill-partial', sourceHub);
    const { state, namespacedOrderId } = bookOwnerState(route, sourceHub, sourceHubSigner);
    const instruction = fillInstruction(state, route, namespacedOrderId, lots => lots / 2n);
    expect(instruction.cancelRemainder).toBe(false);
    expect(instruction.fillRatio).toBeGreaterThan(0);
    expect(instruction.fillRatio).toBeLessThan(65_535);

    const outputs: EntityInput[] = [];
    applyCrossJurisdictionOrderbookFill(env, state, instruction, outputs, []);

    expect(outputs).toHaveLength(0);
    const mirror = state.crossJurisdictionSwaps?.get(route.orderId);
    expect(mirror?.status).toBe('partially_filled');
    expect(mirror?.fillSeq).toBe(1);
    expect(mirror?.cumulativeFillRatio).toBe(instruction.fillRatio);
    expect(mirror?.fillNumerator).toBe(BigInt(instruction.fillRatio));
    expect(mirror?.fillDenominator).toBe(65_535n);
    expect(mirror?.filledSourceAmount).toBe((SOURCE_TOTAL * BigInt(instruction.fillRatio)) / 65_535n);
    expect(mirror?.filledTargetAmount).toBe((TARGET_TOTAL * BigInt(instruction.fillRatio)) / 65_535n);
    const admission = admissionOf(state, route.orderId);
    expect(admission?.status).toBe('admitted');
    expect(admission?.route.cumulativeFillRatio).toBe(instruction.fillRatio);
    const meta = buildCrossMarketOfferFromBookOrder(state, namespacedOrderId);
    const row = bookRow(state, meta!.pairId, `${sourceUser}:${route.orderId}`);
    expect(row?.qtyLots).toBe(crossJurisdictionBookQtyLots(meta!.baseTokenId, meta!.baseAmount));
    expect(state.accounts.get(sourceUser)?.mempool).toHaveLength(0);
    expect(state.accounts.get(sourceUser)?.state.swapOffers.has(route.orderId)).toBe(true);
  });

  test('full fill on the source Hub book owner requests the clear as a full fill and closes the row', () => {
    const env = createEmptyEnv('fill-progress-full');
    const route = prepareRoute('fill-full', sourceHub);
    const { state, namespacedOrderId } = bookOwnerState(route, sourceHub, sourceHubSigner);
    const meta = buildCrossMarketOfferFromBookOrder(state, namespacedOrderId)!;
    const instruction = fillInstruction(state, route, namespacedOrderId, lots => lots);
    expect(instruction.fillRatio).toBe(65_535);
    expect(instruction.cancelRemainder).toBe(false);

    const outputs: EntityInput[] = [];
    applyCrossJurisdictionOrderbookFill(env, state, instruction, outputs, []);

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityId).toBe(sourceHub);
    expect(outputs[0]?.entityTxs).toEqual([
      { type: 'requestCrossJurisdictionClear', data: { orderId: route.orderId, cancelRemainder: false } },
    ]);
    const mirror = state.crossJurisdictionSwaps?.get(route.orderId);
    expect(mirror?.status).toBe('clear_requested');
    expect(mirror?.clearingPolicy).toBe('full_fill');
    expect(mirror?.filledTargetAmount).toBe(TARGET_TOTAL);
    const admission = admissionOf(state, route.orderId);
    expect(admission?.status).toBe('closed');
    expect(admission?.closeReason).toBe('fill_closed');
    expect(bookRow(state, meta.pairId, `${sourceUser}:${route.orderId}`)).toBeFalsy();
    expect(state.accounts.get(sourceUser)?.mempool).toHaveLength(0);
  });

  test('remote book owner sends one fill notice to the source Hub and keeps its own mirror', () => {
    const env = createEmptyEnv('fill-progress-remote');
    const route = prepareRoute('fill-remote', targetHub);
    const { state, namespacedOrderId } = bookOwnerState(route, targetHub, targetHubSigner);
    const instruction = fillInstruction(state, route, namespacedOrderId, lots => lots / 4n);

    const outputs: EntityInput[] = [];
    applyCrossJurisdictionOrderbookFill(env, state, instruction, outputs, []);

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityId).toBe(sourceHub);
    expect(outputs[0]?.signerId).toBe(sourceHubSigner);
    expect(outputs[0]?.entityTxs).toEqual([{
      type: 'crossJurisdictionFillNotice',
      data: {
        orderId: route.orderId,
        routeHash: route.routeHash,
        fillSeq: 1,
        cumulativeFillRatio: instruction.fillRatio,
        cancelRemainder: false,
      },
    }]);
    expect(state.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('partially_filled');
    expect(admissionOf(state, route.orderId)?.route.fillSeq).toBe(1);
  });

  test('cancel after a partial fill closes the admission and requests a cancel-and-clear', () => {
    const env = createEmptyEnv('fill-progress-cancel');
    const route = prepareRoute('fill-cancel', sourceHub);
    const { state, namespacedOrderId } = bookOwnerState(route, sourceHub, sourceHubSigner);
    const partial = fillInstruction(state, route, namespacedOrderId, lots => lots / 2n);
    applyCrossJurisdictionOrderbookFill(env, state, partial, [], []);

    const cancel = buildCrossJurisdictionCancelInstruction(
      sourceUser,
      route.orderId,
      namespacedOrderId,
      admissionOf(state, route.orderId)!.route,
    );
    expect(cancel).toMatchObject({ fillSeq: 1, fillRatio: partial.fillRatio, cancelRemainder: true });
    const outputs: EntityInput[] = [];
    applyCrossJurisdictionOrderbookFill(env, state, cancel, outputs, []);

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityTxs).toEqual([
      { type: 'requestCrossJurisdictionClear', data: { orderId: route.orderId, cancelRemainder: true } },
    ]);
    const mirror = state.crossJurisdictionSwaps?.get(route.orderId);
    expect(mirror?.status).toBe('clear_requested');
    expect(mirror?.clearingPolicy).toBe('cancel_and_clear');
    expect(mirror?.cumulativeFillRatio).toBe(partial.fillRatio);
    expect(admissionOf(state, route.orderId)?.status).toBe('closed');

    // A second cancel for the same progress is a no-op on an already requested clear.
    const again: EntityInput[] = [];
    applyCrossJurisdictionOrderbookFill(env, state, cancel, again, []);
    expect(again).toHaveLength(0);
  });

  test('fill notice: same-seq divergent ratio halts, late fill after clear_requested is ignored', async () => {
    const env = createEmptyEnv('fill-progress-notice-fence');
    env.state.timestamp = NOW;
    env.quietRuntimeLogs = true;
    const route = prepareRoute('fill-notice-fence', targetHub);
    const state = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    state.crossJurisdictionSwaps?.set(route.orderId, {
      ...route,
      status: 'partially_filled',
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      fillNumerator: 32_768n,
      fillDenominator: 65_535n,
    });

    await expect(applyEntityTx(env, state, {
      type: 'crossJurisdictionFillNotice',
      data: { orderId: route.orderId, routeHash: route.routeHash, fillSeq: 1, cumulativeFillRatio: 40_000 },
    })).rejects.toThrow(/CROSS_J_FILL_NOTICE_STALE_CONFLICT/);

    const requested = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    requested.crossJurisdictionSwaps?.set(route.orderId, {
      ...route,
      status: 'clear_requested',
      clearingPolicy: 'cancel_and_clear',
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      fillNumerator: 32_768n,
      fillDenominator: 65_535n,
    });
    const late = await applyEntityTx(env, requested, {
      type: 'crossJurisdictionFillNotice',
      data: { orderId: route.orderId, routeHash: route.routeHash, fillSeq: 2, cumulativeFillRatio: 65_535 },
    });
    expect(late.outputs).toHaveLength(0);
    const after = late.newState.crossJurisdictionSwaps?.get(route.orderId);
    expect(after?.status).toBe('clear_requested');
    expect(after?.cumulativeFillRatio).toBe(32_768);
    expect(after?.fillSeq).toBe(1);
  });

  test('source cross_pull_close at the committed ratio retires the bound source offer', async () => {
    const env = createEmptyEnv('fill-progress-close');
    env.state.timestamp = NOW;
    const prepared = prepareRoute('fill-close', sourceHub, env.runtimeSeed!);
    const fillRatio = 0x8000;
    const privateSeed = deriveCrossJurisdictionPrivateSeed(env.runtimeSeed!, prepared);
    const binary = buildCrossJurisdictionPullReveal(prepared, fillRatio, privateSeed).binary;
    const proof = buildCrossJurisdictionCloseProof({
      ...prepared,
      status: 'clearing',
      cumulativeFillRatio: fillRatio,
      claimedRatio: fillRatio,
      fillNumerator: BigInt(fillRatio),
      fillDenominator: 65_535n,
      filledSourceAmount: (SOURCE_TOTAL * BigInt(fillRatio)) / 65_535n,
      filledTargetAmount: (TARGET_TOTAL * BigInt(fillRatio)) / 65_535n,
      sourceClaimed: (SOURCE_TOTAL * BigInt(fillRatio)) / 65_535n,
      targetClaimed: (TARGET_TOTAL * BigInt(fillRatio)) / 65_535n,
    }, binary);
    const account = makeAccount(sourceUser, sourceHub);
    const sourcePull = prepared.sourcePull!;
    const delta = { ...(account.state.deltas.get(sourcePull.tokenId) ?? createDefaultDelta(sourcePull.tokenId)) };
    const held = sourcePull.signedAmount >= 0n ? sourcePull.signedAmount : -sourcePull.signedAmount;
    if (sourcePull.signedAmount > 0n) delta.rightHold = held;
    else delta.leftHold = held;
    putTestAccountDelta(account, delta);
    account.state.pulls = PersistentAccountStateMap.fromEntries('pulls', [
      [sourcePull.pullId, {
        pullId: sourcePull.pullId,
        tokenId: sourcePull.tokenId,
        amount: sourcePull.signedAmount,
        claimedRatio: 0,
        claimedAmount: 0n,
        fullHash: sourcePull.fullHash,
        partialRoot: sourcePull.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(prepared, 'source'),
        createdHeight: 0,
        createdTimestamp: NOW,
      }],
    ]);
    putTestAccountSwapOffer(account, {
      offerId: prepared.orderId,
      ...getStaticSwapTokenDimensions(1, 1),
      giveTokenId: 1,
      giveAmount: SOURCE_TOTAL,
      wantTokenId: 1,
      wantAmount: TARGET_TOTAL,
      maxFee: 0n,
      minNetReceive: TARGET_TOTAL,
      priceTicks: 2_500n * ORDERBOOK_PRICE_SCALE,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...prepared },
    });

    const result = await applyAccountTx(
      account,
      { type: 'cross_pull_close', data: { pullId: sourcePull.pullId, binary, proof } },
      sourceHub.toLowerCase() < sourceUser.toLowerCase(),
      NOW,
      1,
    );
    expect(result.ok ? 'ok' : result.rejection.message).toBe('ok');
    expect(result.ok ? result.outcome : undefined).toBe('swap_cancelled');
    expect(account.state.swapOffers.has(prepared.orderId)).toBe(false);
    expect(account.state.pulls?.has(sourcePull.pullId)).toBe(false);
  });
});
