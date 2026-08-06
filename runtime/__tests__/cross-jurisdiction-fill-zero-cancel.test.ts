import { describe, expect, test } from 'bun:test';

import { applyEntityTx } from '../entity/tx/apply';
import { buildPreparedCrossJurisdictionRoute } from '../extensions/cross-j';
import { createEmptyEnv } from '../runtime';
import { addr, entity, jref, makeJurisdiction, makeState } from './helpers/cross-j';

describe('cross-j zero-progress cancel fill notice', () => {
  test('uses the canonical 0/1 exact fill proof', async () => {
    const env = createEmptyEnv('cross-fill-notice-zero-cancel');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('d1');
    const sourceHub = entity('d2');
    const targetHub = entity('d3');
    const targetUser = entity('d4');
    const state = makeState(sourceHub, addr('d2'), eth, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-fill-notice-zero-cancel',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 900n,
      },
      status: 'resting',
      createdAt: env.state.timestamp,
      updatedAt: env.state.timestamp,
      expiresAt: 70_000,
    }, {
      runtimeSeed: 'cross-fill-notice-zero-cancel',
      sourceDisputeDelayMs: 5_000,
      now: env.state.timestamp,
    });
    route.status = 'resting';
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const cancelNotice = {
      type: 'crossJurisdictionFillNotice' as const,
      data: {
        orderId: route.orderId,
        routeHash: route.routeHash,
        previousFillSeq: 0,
        fillSeq: 0,
        incrementalSourceAmount: 0n,
        incrementalTargetAmount: 0n,
        cumulativeSourceAmount: 0n,
        cumulativeTargetAmount: 0n,
        cumulativeFillRatio: 0,
        fillNumerator: 0n,
        fillDenominator: 1n,
        cancelRemainder: true,
        pairId: route.venueId || '',
      },
    };

    const accepted = await applyEntityTx(env, state, cancelNotice);
    expect(accepted.accountTxs?.map(operation => operation.tx.type)).toEqual([
      'cross_swap_fill_ack',
    ]);
    await expect(applyEntityTx(env, state, {
      ...cancelNotice,
      data: { ...cancelNotice.data, fillDenominator: 2n },
    })).rejects.toThrow(/CROSS_J_FILL_NOTICE_STALE_CONFLICT/);
  });
});
