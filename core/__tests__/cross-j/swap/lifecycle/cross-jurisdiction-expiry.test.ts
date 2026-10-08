import { expect, test } from 'bun:test';
import { applyAccountTxToMutableReplica } from '../../../../account/tx/apply';
import { createDefaultDelta } from '../../../../account/state/delta';
import { computeAccountStateRoot } from '../../../../account/commitment/state-root';
import { handleOrderbookSweepCrossJurisdictionEntityTx } from '../../../../entity/tx/handlers/cross-j/sweep';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../../../../entity/tx/handlers/account-cross-j-followups';
import { readEntityFrameEventMessages } from '../../../../entity/frame-events';
import {
  buildPreparedCrossJurisdictionRoute,
  buildCrossJurisdictionPullBinding,
  isCrossJurisdictionTerminalStatus,
} from '../../../../extensions/cross-j';
import { getStaticSwapTokenDimensions } from '../../../../orderbook/types';
import { createEmptyEnv } from '../../../../runtime';
import type { EntityInput } from '../../../../entity/types';
import {
  addr,
  entity,
  getTestAccountForWrite,
  jref,
  makeJurisdiction,
  makeState,
  putTestAccountDelta,
  putTestAccountPull,
  putTestAccountSwapOffer,
} from '../../../helpers/cross-j';

test('cross-j orderbook sweep closes expired unfilled route instead of being a no-op', async () => {
  const createdAt = 10_000;
  const expiresAt = 70_000;
  const env = createEmptyEnv('cross-expiry-holds');
  env.state.timestamp = expiresAt;
  const sourceJ = makeJurisdiction('Source', 1, '11', '12');
  const targetJ = makeJurisdiction('Target', 8453, '21', '22');
  const sourceUser = entity('a1');
  const sourceHub = entity('a2');
  const targetHub = entity('a3');
  const targetUser = entity('a4');
  const route = {
    ...buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'expiry-unfilled',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        bookOwnerEntityId: sourceHub,
        sourceHubSignerId: addr('b2'),
        targetHubSignerId: addr('b3'),
        bookHubSignerId: addr('b2'),
        sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        source: {
          jurisdiction: jref(sourceJ),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: jref(targetJ),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 900n,
        },
        status: 'resting',
        createdAt,
        updatedAt: createdAt,
        expiresAt,
      },
      { runtimeSeed: env.runtimeSeed!, now: createdAt },
    ),
    status: 'resting' as const,
  };
  const source = makeState(sourceHub, addr('b2'), sourceJ, sourceUser);
  const target = makeState(targetHub, addr('b3'), targetJ, targetUser);
  for (const [state, peer, leg] of [
    [source, sourceUser, 'source'],
    [target, targetUser, 'target'],
  ] as const) {
    state.timestamp = expiresAt;
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const account = getTestAccountForWrite(state, peer);
    const pull = leg === 'source' ? route.sourcePull! : route.targetPull!;
    const delta = { ...(account.state.deltas.get(1) ?? createDefaultDelta(1)) };
    if (pull.signedAmount > 0n) delta.rightHold = pull.signedAmount;
    else delta.leftHold = -pull.signedAmount;
    putTestAccountDelta(account, delta);
    putTestAccountPull(account, pull.pullId, {
      ...pull,
      amount: pull.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, leg),
      createdHeight: 0,
      createdTimestamp: createdAt,
    });
  }
  putTestAccountSwapOffer(getTestAccountForWrite(source, sourceUser), {
    offerId: route.orderId,
    ...getStaticSwapTokenDimensions(1, 1),
    giveTokenId: 1,
    giveAmount: 1_000n,
    wantTokenId: 1,
    wantAmount: 900n,
    maxFee: 0n,
    minNetReceive: 900n,
    priceTicks: 900n,
    timeInForce: 0,
    makerIsLeft: sourceUser < sourceHub,
    createdHeight: 0,
    crossJurisdiction: route,
  });
  source.timestamp = expiresAt - 1;
  env.state.timestamp = expiresAt - 1;
  const beforeExpiry = handleOrderbookSweepCrossJurisdictionEntityTx(env, source, {
    type: 'orderbookSweepCrossJurisdiction',
    data: { reason: 'expiry-regression' },
  });
  expect(beforeExpiry.accountTxs).toHaveLength(0);
  expect(beforeExpiry.outputs).toHaveLength(0);
  source.timestamp = expiresAt;
  env.state.timestamp = expiresAt;
  const swept = handleOrderbookSweepCrossJurisdictionEntityTx(env, source, {
    type: 'orderbookSweepCrossJurisdiction',
    data: { reason: 'expiry-regression' },
  });
  expect(swept.accountTxs).toHaveLength(1);
  const sourceClose = swept.accountTxs![0]!;
  expect(sourceClose.tx.type).toBe('cross_pull_close');
  const targetClose = swept.outputs.flatMap(output => output.entityTxs ?? []).find(tx => tx.type === 'crossPullClose');
  if (!targetClose || targetClose.type !== 'crossPullClose') throw new Error('TARGET_EXPIRY_CLOSE_MISSING');
  const closes = [
    [swept.newState, sourceUser, sourceHub, sourceClose.tx],
    [
      target,
      targetUser,
      targetHub,
      {
        type: 'cross_pull_close' as const,
        data: { pullId: targetClose.data.pullId, binary: targetClose.data.binary, proof: targetClose.data.proof },
      },
    ],
  ] as const;
  for (const [state, peer, sender, tx] of closes) {
    const account = getTestAccountForWrite(state, peer);
    const deltaBefore = account.state.deltas.get(1)!;
    expect(deltaBefore.leftHold + deltaBefore.rightHold).toBeGreaterThan(0n);
    const beforeRoot = computeAccountStateRoot(account.state);
    const closed = await applyAccountTxToMutableReplica(account, tx, sender === account.state.leftEntity, expiresAt, 1);
    expect(closed.ok).toBe(true);
    const after = account.state.deltas.get(1)!;
    expect(after.offdelta).toBe(deltaBefore.offdelta);
    expect(after.collateral).toBe(deltaBefore.collateral);
    expect(after.leftHold + after.rightHold).toBe(0n);
    expect(account.state.pulls?.size).toBe(0);
    expect(computeAccountStateRoot(account.state)).not.toBe(beforeRoot);
    const outputs: EntityInput[] = [];
    applyCommittedCrossJurisdictionAccountTxFollowup(env, state, peer, tx, outputs);
    expect(isCrossJurisdictionTerminalStatus(state.crossJurisdictionSwaps?.get(route.orderId)?.status)).toBe(true);
  }
  expect(getTestAccountForWrite(swept.newState, sourceUser).state.swapOffers.size).toBe(0);
  expect(
    readEntityFrameEventMessages(swept.newState).some(message => message.includes('expired=1 closedOffers=1')),
  ).toBe(true);
  const repeated = handleOrderbookSweepCrossJurisdictionEntityTx(env, swept.newState, {
    type: 'orderbookSweepCrossJurisdiction',
    data: { reason: 'repeat' },
  });
  expect(repeated.accountTxs).toHaveLength(0);
  expect(repeated.outputs).toHaveLength(0);
});
