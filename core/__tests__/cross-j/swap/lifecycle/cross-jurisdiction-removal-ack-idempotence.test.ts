import { expect, test } from 'bun:test';

import { computeCanonicalEntityConsensusStateHashCold } from '../../../../entity/consensus/state-root';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../../../../entity/tx/handlers/account-cross-j-followups';
import { handleCrossJurisdictionBookOrderRemovedEntityTx } from '../../../../entity/tx/handlers/cross-j/book-removal-ack';
import { handleRemoveCrossJurisdictionBookOrderEntityTx } from '../../../../entity/tx/handlers/cross-j/book-order';
import { applyAccountTxToMutableReplica } from '../../../../account/tx/apply';
import { createDefaultDelta } from '../../../../account/state/delta';
import {
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullBinding,
  buildPreparedCrossJurisdictionRoute,
  isCrossJurisdictionTerminalStatus,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../../extensions/cross-j';
import { mergeCrossJurisdictionBookAdmission } from '../../../../extensions/cross-j/orderbook';
import { getStaticSwapTokenDimensions } from '../../../../orderbook/types';
import { createEmptyEnv } from '../../../../runtime';
import type { AccountTx } from '../../../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../../../types/cross-jurisdiction';
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

const NOW = 10_000;
const sourceUser = entity('a1');
const sourceHub = entity('a2');
const targetHub = entity('a3');
const targetUser = entity('a4');
const sourceHubSigner = addr('b2');
const targetHubSigner = addr('b3');
const sourceJ = makeJurisdiction('Source', 1, '11', '12');
const targetJ = makeJurisdiction('Target', 8453, '21', '22');

const preparedRoute = (runtimeSeed: string): CrossJurisdictionSwapRoute => ({
  ...buildPreparedCrossJurisdictionRoute({
    orderId: 'late-removal-ack',
    makerEntityId: sourceUser,
    hubEntityId: sourceHub,
    bookOwnerEntityId: targetHub,
    sourceHubSignerId: sourceHubSigner,
    targetHubSignerId: targetHubSigner,
    bookHubSignerId: targetHubSigner,
    sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    source: {
      jurisdiction: jref(sourceJ), entityId: sourceUser,
      counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n,
    },
    target: {
      jurisdiction: jref(targetJ), entityId: targetHub,
      counterpartyEntityId: targetUser, tokenId: 1, amount: 900n,
    },
    status: 'resting', createdAt: NOW, updatedAt: NOW, expiresAt: 70_000,
  }, { runtimeSeed, now: NOW }),
  status: 'resting',
});

test('remote removal ack after close/retirement is an exact idempotent no-op', async () => {
  const env = createEmptyEnv('late-removal-ack');
  env.state.timestamp = NOW;
  const route = preparedRoute(env.runtimeSeed ?? 'late-removal-ack');

  const remoteBook = makeState(targetHub, targetHubSigner, targetJ, targetUser);
  remoteBook.timestamp = NOW;
  remoteBook.crossJurisdictionSwaps?.set(route.orderId, route);
  mergeCrossJurisdictionBookAdmission(remoteBook, route, NOW).status = 'admitted';
  const removal = handleRemoveCrossJurisdictionBookOrderEntityTx(env, remoteBook, {
    type: 'removeCrossJurisdictionBookOrder',
    data: {
      orderId: route.orderId,
      sourceEntityId: sourceUser,
      sourceAccountId: sourceUser,
      route,
      reason: 'cancel_request',
    },
  });
  const ack = removal.outputs.flatMap(output => output.entityTxs ?? [])[0];
  if (!ack || ack.type !== 'crossJurisdictionBookOrderRemoved') {
    throw new Error('TEST_REMOVAL_ACK_MISSING');
  }

  const sourceState = makeState(sourceHub, sourceHubSigner, sourceJ, sourceUser);
  sourceState.timestamp = NOW;
  const clearingRoute: CrossJurisdictionSwapRoute = {
    ...route,
    status: 'clearing',
    clearingPolicy: 'cancel_and_clear',
  };
  sourceState.crossJurisdictionSwaps?.set(route.orderId, clearingRoute);
  mergeCrossJurisdictionBookAdmission(sourceState, clearingRoute, NOW).status = 'resolving';
  const account = getTestAccountForWrite(sourceState, sourceUser);
  const sourcePull = route.sourcePull;
  if (!sourcePull) throw new Error('TEST_SOURCE_PULL_MISSING');
  const delta = { ...(account.state.deltas.get(sourcePull.tokenId) ?? createDefaultDelta(sourcePull.tokenId)) };
  const held = sourcePull.signedAmount < 0n ? -sourcePull.signedAmount : sourcePull.signedAmount;
  if (sourcePull.signedAmount > 0n) delta.rightHold = held;
  else delta.leftHold = held;
  putTestAccountDelta(account, delta);
  putTestAccountPull(account, sourcePull.pullId, {
    ...sourcePull,
    amount: sourcePull.signedAmount,
    claimedRatio: 0,
    claimedAmount: 0n,
    crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
    createdHeight: 0,
    createdTimestamp: NOW,
  });
  putTestAccountSwapOffer(account, {
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
    makerIsLeft: account.state.leftEntity === sourceUser,
    createdHeight: 0,
    crossJurisdiction: route,
  });

  const closeTx: Extract<AccountTx, { type: 'cross_pull_close' }> = {
    type: 'cross_pull_close',
    data: {
      pullId: sourcePull.pullId,
      binary: '0x',
      proof: buildCrossJurisdictionCloseProof(clearingRoute, '0x'),
    },
  };
  const closed = await applyAccountTxToMutableReplica(
    account,
    closeTx,
    sourceHub.toLowerCase() < sourceUser.toLowerCase(),
    NOW + 1,
    1,
  );
  expect(closed.ok).toBe(true);
  expect(account.state.swapOffers.has(route.orderId)).toBe(false);
  const closeOutputs = [];
  applyCommittedCrossJurisdictionAccountTxFollowup(
    env,
    sourceState,
    sourceUser,
    closeTx,
    closeOutputs,
    NOW + 1,
    [],
    [],
  );
  expect(isCrossJurisdictionTerminalStatus(
    sourceState.crossJurisdictionSwaps?.get(route.orderId)?.status,
  )).toBe(true);

  const beforeAckRoot = computeCanonicalEntityConsensusStateHashCold(sourceState);
  const first = await handleCrossJurisdictionBookOrderRemovedEntityTx(env, sourceState, ack);
  expect(first.outputs).toEqual([]);
  expect(first.accountTxs).toEqual([]);
  expect(computeCanonicalEntityConsensusStateHashCold(first.newState)).toBe(beforeAckRoot);
  const duplicate = await handleCrossJurisdictionBookOrderRemovedEntityTx(env, first.newState, ack);
  expect(duplicate.outputs).toEqual([]);
  expect(duplicate.accountTxs).toEqual([]);
  expect(computeCanonicalEntityConsensusStateHashCold(duplicate.newState)).toBe(beforeAckRoot);

  const { routeHash: _routeHash, ...routeWithoutHash } = ack.data.route;
  const conflictingRoute = withCanonicalCrossJurisdictionRouteHash({
    ...routeWithoutHash,
    expiresAt: Number(routeWithoutHash.expiresAt) + 1,
  });
  await expect(handleCrossJurisdictionBookOrderRemovedEntityTx(env, duplicate.newState, {
    ...ack,
    data: { ...ack.data, route: conflictingRoute },
  })).rejects.toThrow(/CROSS_J_BOOK_REMOVAL_ACK_ROUTE_HASH_MISMATCH/);
});
