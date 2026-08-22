import { describe, expect, test } from 'bun:test';

import {
  paymentAmountFor,
  paymentReceiverIndex,
  paymentReceiverIndexSamePopulation,
  paymentTotalForSender,
  paymentTotalsByReceiver,
  paymentTotalsByReceiverSamePopulation,
} from '../../../scripts/operations/hlt/workload/worker-payments-plan';
import { buildHltPlan } from '../../../scripts/operations/hlt/economy';
import { decodeLoadPaymentReport } from '../../../scripts/operations/hlt/boundary/worker-payment-boundary';
import { parseWorkerArgs } from '../../../scripts/operations/hlt/worker-runtime';
import { buildRoundPayment } from '../../../scripts/operations/hlt/workload/worker-payments';
import { buildPacedOperationSchedule } from '../../../scripts/operations/hlt/workload/operation-pacer';
import {
  HLT_FAUCET_AMOUNT,
  HLT_FAUCET_TOKEN_ID,
  HLT_USER_RECEIVE_WINDOW,
} from '../../../scripts/operations/hlt/lanes/worker-lanes';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('hlt payment population', () => {
  test('every economic payment has exactly two Account legs through one H1', () => {
    const sender = { entityId: 'sender', signerId: 'sender-signer' };
    const receiver = { entityId: 'receiver', signerId: 'receiver-signer' };
    const input = buildRoundPayment(sender, 'H1', receiver, 0, 0, { min: 1n, max: 1n });
    const payment = input.entityTxs?.[0];
    expect(payment?.type).toBe('htlcPayment');
    if (payment?.type !== 'htlcPayment') throw new Error('HLT_PAYMENT_TEST_TX_MISSING');
    expect(payment.data.route).toEqual(['sender', 'H1', 'receiver']);
    expect(payment.data.route.length - 1).toBe(2);
  });

  test('pure payment mode derives a payment-only population without a redundant mix flag', () => {
    const args = parseWorkerArgs([
      '--work-dir', '/tmp/xln-hlt-payments-default-mix',
      '--port-base', '20000',
      '--mode', 'payments',
      '--users', '200',
      '--duration-s', '1',
    ]);

    expect(args.lanes).toBe(200);
    expect(args.plan?.economy.mix).toEqual({ swap: 0, payment: 1 });
  });

  test('payment routing stays bounded and settlement uses committed metrics', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../../scripts/operations/hlt/workload/worker-payments.ts'),
      'utf8',
    );
    expect(source).toContain('receiverIdsBySender');
    expect(source).toContain('READ_CONCURRENCY');
    expect(source).toContain('forEachLimited');
    expect(source).toContain('pendingReads');
    expect(source).toContain('isTransientGossipSocketError');
    expect(source).toContain('GOSSIP_PROFILE_LOOKUP_RATE_LIMITED');
    expect(source).toContain('buildPacedOperationSchedule');
    expect(source).toContain('queueLaneRuntimeInputWave(operation.ordinal');
    expect(source).not.toContain('sendEnqueued');
    expect(source).toContain('waitForHubSettlement');
    expect(source).toContain('core.completedPayments - completedPaymentsBefore');
    expect(source).toContain("type: 'settlement-evidence', book: null, accounts: []");
    expect(source).toContain('DELIVERY_TIMEOUT_MS = 600_000');
    expect(source).toContain('HLT_PAYMENT_STALLED_FAIL_FAST');
    expect(source).not.toContain('HLT_PAYMENT_DRAIN_GATE_FAILED');
    expect(source).not.toContain('readHubReceiverCredits');
    expect(source).not.toContain('accountsLimit: pageLimit');
    const laneSource = readFileSync(
      join(import.meta.dir, '../../../scripts/operations/hlt/lanes/worker-lanes.ts'),
      'utf8',
    );
    expect(laneSource).toContain('waitForLaneHostReadiness');
    expect(laneSource).toContain('waitForLaneFinancialReadiness');
    expect(laneSource).toContain('options.hub.control.waitForDirectRuntimeSessions');
    expect(laneSource).not.toContain('waitForOwnReceiveReadyProfile');
    expect(laneSource).not.toContain('gossipPollMs');
  });

  test('1000 users are evenly paced at one operation per millisecond', () => {
    const schedule = buildPacedOperationSchedule({ participants: 1_000, rounds: 2, cadenceMs: 1_000 });
    expect(schedule).toHaveLength(2_000);
    expect(schedule.map(operation => operation.dueOffsetMs))
      .toEqual(Array.from({ length: 2_000 }, (_, index) => index));
    for (const round of [0, 1]) {
      const participants = schedule
        .filter(operation => operation.round === round)
        .map(operation => operation.participantIndex);
      expect(new Set(participants).size).toBe(1_000);
    }
  });

  test('pacer randomizes initiator order without changing exact rate or count', () => {
    const schedule = buildPacedOperationSchedule({
      participants: 20,
      rounds: 3,
      cadenceMs: 1_000,
      jitterWindowMs: 500,
    });
    const orders = Array.from({ length: 3 }, (_, round) => schedule
      .filter(operation => operation.round === round)
      .map(operation => operation.participantIndex));
    expect(orders[0]).not.toEqual(orders[1]);
    expect(orders[1]).not.toEqual(orders[2]);
    expect(schedule[0]?.dueOffsetMs).toBe(0);
    expect(schedule.at(-1)?.dueOffsetMs).toBe(2_950);
  });

  test('every round pairs senders and receivers as a permutation', () => {
    for (const receivers of [2, 3, 8, 64, 500]) {
      for (const round of [0, 1, 7, 999]) {
        const paired = Array.from({ length: receivers }, (_, sender) =>
          paymentReceiverIndex(sender, round, receivers));
        expect(new Set(paired).size).toBe(receivers);
        expect(paired.every(index => index >= 0 && index < receivers)).toBe(true);
      }
    }
  });

  test('a sender never pays a fixed partner across rounds', () => {
    const receivers = 64;
    const seen = new Set(
      Array.from({ length: 16 }, (_, round) => paymentReceiverIndex(0, round, receivers)),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  test('receiver totals account for every submitted payment exactly (fixed amount)', () => {
    const senders = 8;
    const rounds = 5;
    const range = { min: 1_000n, max: 1_000n };
    const totals = paymentTotalsByReceiver(senders, senders, rounds, range);
    expect(totals).toHaveLength(senders);
    expect(totals.reduce((sum, total) => sum + total, 0n))
      .toBe(1_000n * BigInt(senders * rounds));
    expect(paymentTotalForSender(0, rounds, range)).toBe(1_000n * BigInt(rounds));
  });

  test('receiver totals account for every submitted payment exactly (random range)', () => {
    const senders = 8;
    const rounds = 5;
    const range = { min: 50n, max: 500n };
    const totals = paymentTotalsByReceiver(senders, senders, rounds, range);
    let expectedGrandTotal = 0n;
    for (let senderIndex = 0; senderIndex < senders; senderIndex += 1) {
      expectedGrandTotal += paymentTotalForSender(senderIndex, rounds, range);
    }
    expect(totals.reduce((sum, total) => sum + total, 0n)).toBe(expectedGrandTotal);
    for (let round = 0; round < rounds; round += 1) {
      for (let senderIndex = 0; senderIndex < senders; senderIndex += 1) {
        const amount = paymentAmountFor(senderIndex, round, range);
        expect(amount).toBeGreaterThanOrEqual(range.min);
        expect(amount).toBeLessThanOrEqual(range.max);
      }
    }
  });

  test('pairing rejects an out-of-range sender instead of wrapping silently', () => {
    expect(() => paymentReceiverIndex(4, 0, 4)).toThrow('HLT_PAYMENT_SENDER_INDEX_INVALID');
    expect(() => paymentReceiverIndex(0, 0, 0)).toThrow('HLT_PAYMENT_RECEIVERS_INVALID');
    expect(() => paymentTotalForSender(0, 0, { min: 1n, max: 1n })).toThrow('HLT_PAYMENT_ROUNDS_INVALID');
    expect(() => paymentAmountFor(0, 0, { min: 0n, max: 1n })).toThrow('HLT_PAYMENT_AMOUNT_MIN_INVALID');
    expect(() => paymentAmountFor(0, 0, { min: 5n, max: 1n })).toThrow('HLT_PAYMENT_AMOUNT_RANGE_INVALID');
  });

  test('payments mode uses every sovereign user as sender and receiver', () => {
    const args = parseWorkerArgs([
      '--work-dir', '/tmp/xln-load',
      '--port-base', '20000',
      '--mode', 'payments',
      '--users', '64',
      '--rate-per-user', '2',
      '--duration-s', '10',
      '--mix', '0:1',
    ]);
    expect(args.lanes).toBe(64);
    expect(args.rounds).toBe(20);
    expect(args.cadenceMs).toBe(500);
    expect(args.plan?.paymentLanes).toBe(64);
  });

  test('a mix that leaves the mode no users is rejected', () => {
    expect(() => parseWorkerArgs([
      '--work-dir', '/tmp/xln-load',
      '--port-base', '20000',
      '--mode', 'payments',
      '--users', '8',
      '--mix', '1:0',
    ])).toThrow('HLT_MODE_POPULATION_EMPTY:payments');
  });

  test('same-population pairing is a derangement bijection each round', () => {
    for (const users of [2, 8, 64, 1000]) {
      for (const round of [0, 1, 7, users, users + 3]) {
        const paired = Array.from({ length: users }, (_, sender) =>
          paymentReceiverIndexSamePopulation(sender, round, users));
        expect(new Set(paired).size).toBe(users);
        expect(paired.every((receiver, sender) => receiver !== sender)).toBe(true);
      }
    }
  });

  test('same-population receiver totals match the derangement, not the disjoint permutation', () => {
    const users = 8;
    const rounds = 5;
    const range = { min: 50n, max: 500n };
    const totals = paymentTotalsByReceiverSamePopulation(users, rounds, range);
    expect(totals).not.toEqual(paymentTotalsByReceiver(users, users, rounds, range));
    expect(totals.reduce((sum, total) => sum + total, 0n))
      .toBe(Array.from({ length: users }, (_, sender) => paymentTotalForSender(sender, rounds, range))
        .reduce((sum, total) => sum + total, 0n));
  });

  test('mix 1:1 on 1000 users offers 1000 payments/s and 1000 swaps/s', () => {
    const plan = buildHltPlan({
      users: 1000,
      ratePerUserPerSecond: 1,
      durationSeconds: 1,
      mix: { swap: 1, payment: 1 },
      baseTokenId: 2,
      quoteTokenId: 1,
      hubLabels: ['H1'],
      marketMakerLabels: ['MM'],
    });
    expect(plan.totalUserRuntimes).toBe(1000);
    expect(plan.swapLanes).toBe(500);
    expect(plan.paymentLanes).toBe(1000);
    expect(plan.swapOrdersPerLaneRound).toBe(2);
    expect(plan.offeredPaymentRatePerSecond).toBe(1000);
    expect(plan.offeredSwapOrderRatePerSecond).toBe(1000);
    expect(plan.offeredOrderRatePerSecond).toBe(2000);
  });

  test('payments-only uses the full population; swap-only does not invent payments', () => {
    const payments = buildHltPlan({
      users: 8,
      ratePerUserPerSecond: 1,
      durationSeconds: 1,
      mix: { swap: 0, payment: 1 },
      baseTokenId: 2,
      quoteTokenId: 1,
      hubLabels: ['H1'],
      marketMakerLabels: ['MM'],
    });
    expect(payments.paymentLanes).toBe(8);
    expect(payments.offeredPaymentRatePerSecond).toBe(8);
    expect(payments.offeredSwapOrderRatePerSecond).toBe(0);
    const swaps = buildHltPlan({
      users: 8,
      ratePerUserPerSecond: 1,
      durationSeconds: 1,
      mix: { swap: 1, payment: 0 },
      baseTokenId: 2,
      quoteTokenId: 1,
      hubLabels: ['H1'],
      marketMakerLabels: ['MM'],
    });
    expect(swaps.swapLanes).toBe(4);
    expect(swaps.swapOrdersPerLaneRound).toBe(1);
    expect(swaps.offeredSwapOrderRatePerSecond).toBe(4);
    expect(swaps.offeredPaymentRatePerSecond).toBe(0);
  });

  test('mixed mode requires both mix weights', () => {
    expect(() => parseWorkerArgs([
      '--work-dir', '/tmp/xln-load',
      '--port-base', '20000',
      '--mode', 'mixed',
      '--users', '8',
      '--mix', '1:0',
    ])).toThrow('HLT_MIXED_REQUIRES_BOTH_WORKLOADS');
    const args = parseWorkerArgs([
      '--work-dir', '/tmp/xln-load',
      '--port-base', '20000',
      '--mode', 'mixed',
      '--users', '8',
      '--rate-per-user', '1',
      '--duration-s', '1',
      '--mix', '1:1',
    ]);
    expect(args.lanes).toBe(4);
    expect(args.plan?.offeredPaymentRatePerSecond).toBe(8);
    expect(args.plan?.offeredSwapOrderRatePerSecond).toBe(8);
  });

  test('population receives one real $5000 token-1 faucet without synthetic H1 grants', () => {
    expect(HLT_FAUCET_TOKEN_ID).toBe(1);
    expect(HLT_FAUCET_AMOUNT).toBe(5_000_000_000n);
    expect(HLT_USER_RECEIVE_WINDOW).toBe(10_000_000_000n);
    const source = readFileSync(
      join(import.meta.dir, '../../../scripts/operations/hlt/lanes/worker-lanes.ts'),
      'utf8',
    );
    expect(source).toContain("type: 'directPayment' as const");
    expect(source).toContain("description: 'HLT $5000 token-1 faucet'");
    expect(source).toContain('r2cRequestSoftLimit: HLT_FAUCET_AMOUNT');
    expect(source).toContain('hardLimit: HLT_FAUCET_AMOUNT');
    expect(source).not.toContain('grantBilateralTokenCredit');
  });

  test('mixed worker folds payments into the same-j windowed submitter', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../../scripts/operations/hlt/workload/worker-mixed.ts'),
      'utf8',
    );
    expect(source).toContain('submitPreparedParallelSameLoad');
    expect(source).toContain('extraEntityTxs');
    expect(source).toContain('HLT_MIXED_TICK_LANE_MISMATCH');
    expect(source).toContain("execution: 'balanced'");
    expect(source).toContain('decodeHubMinTradeSize(\n      await hub.adapter.read<unknown>(`entity/${hubIdentity.entityId}`)');
    expect(source).not.toContain('decodeHubMinTradeSize(\n      await hub.adapter.read<unknown>(`entity/${hubIdentity.entityId}/settlement-counters`)');
    expect(source).toContain('actionsPerFrame: 1');
    expect(source).toContain('const expectedSubmittedOffers = prepared.distribution.submittedOffers');
    expect(source).toContain('const matchedDrain = await waitForExpectedMatchedTrades({');
    expect(source).toContain('allowAdditionalTrades: true');
    expect(source).toContain('const expectedMatchedTrades = matchedDrain.matchedTrades');
    expect(source).toContain('matchedTrades: expectedMatchedTrades');
    expect(source).toContain('cancelPreparedRestingTail(prepared)');
    expect(source).toContain('const [settlementEvidence, paymentSettlement] = await Promise.all([');
    expect(source).toContain('hubCountersBefore.completedPayments,\n      hubCountersBefore.acceptedPayments,\n      submittedPayments');
    expect(source).not.toContain('grantBilateralTokenCredit');
    expect(source).not.toContain('readHubReceiverCredits');
    expect(source).not.toContain('hlt-mixed-swap-${tick + 1}');
    const laneSource = readFileSync(
      join(import.meta.dir, '../../../scripts/operations/hlt/workload/worker-same-lanes.ts'),
      'utf8',
    );
    expect(laneSource).toContain('plan.baseCredit,\n        highestVisibleAsk');
    expect(laneSource).toContain('HLT_TRADER_INVENTORY_DEPTH_INSUFFICIENT');
    expect(source).not.toContain('hlt-mixed-pay-${tick + 1}');
  });
});

describe('hlt payment report boundary', () => {
  const frame = { height: 12, canonicalStateHash: `0x${'ab'.repeat(32)}` };
  const report = {
    schema: 'xln-hlt-payment-load-v1',
    mode: 'payments',
    runId: 'hlt-payment-test',
    completionAuthority: 'committed_entity_metrics_and_bilateral_runtime_quiescence',
    configuredUsers: 64, configuredRounds: 10, cadenceMs: 1_000,
    senders: 32, receivers: 32, tokenId: 1, amount: '1000',
    offeredPaymentRate: 32, submittedPayments: 320, deliveredPayments: 320,
    enqueueAckElapsedMs: 10, sourceDispatchFinishedElapsedMs: 15,
    sourceAllAckedElapsedMs: 20, commandObservedElapsedMs: 20, deliveredElapsedMs: 30,
    deliveredTps: 10.5, roundSubmissionLagMs: Array.from({ length: 320 }, () => 1),
    hubCompletedPaymentsBefore: 12, hubCompletedPaymentsAfter: 332,
    hubAcceptedPaymentsBefore: 7, hubAcceptedPaymentsAfter: 327,
    hubIngressElapsedMs: 25,
    settlementSamples: [
      { elapsedMs: 5, runtimeHeight: 12, acceptedPayments: 0, completedPayments: 0, lockBookOpen: 0 },
      { elapsedMs: 25, runtimeHeight: 20, acceptedPayments: 320, completedPayments: 100, lockBookOpen: 220 },
      { elapsedMs: 30, runtimeHeight: 40, acceptedPayments: 320, completedPayments: 320, lockBookOpen: 0 },
    ],
    walBytesBefore: 100, walBytesAfter: 200,
    hubDurableBefore: frame, hubDurableAfter: { ...frame, height: 40 },
  };

  test('a fully delivered run decodes', () => {
    expect(decodeLoadPaymentReport(report).deliveredPayments).toBe(320);
  });

  test('a partially delivered run is rejected, not averaged', () => {
    expect(() => decodeLoadPaymentReport({ ...report, deliveredPayments: 319 }))
      .toThrow('HLT_PAYMENT_REPORT_INCOMPLETE:319:320');
  });

  test('observation may not precede the acknowledgement it reports', () => {
    expect(() => decodeLoadPaymentReport({ ...report, commandObservedElapsedMs: 19 }))
      .toThrow('HLT_PAYMENT_REPORT_TIMING_INVALID');
    expect(() => decodeLoadPaymentReport({
      ...report,
      sourceDispatchFinishedElapsedMs: 31,
      sourceAllAckedElapsedMs: 31,
      commandObservedElapsedMs: 31,
    }))
      .toThrow('HLT_PAYMENT_REPORT_TIMING_INVALID');
  });

  test('source and settlement checkpoints are preserved and monotonic', () => {
    const decoded = decodeLoadPaymentReport(report);
    expect(decoded.sourceDispatchFinishedElapsedMs).toBe(15);
    expect(decoded.sourceAllAckedElapsedMs).toBe(20);
    expect(decoded.settlementSamples).toHaveLength(3);
    const regressed = report.settlementSamples.map((sample, index) =>
      index === 2 ? { ...sample, completedPayments: 99 } : sample);
    expect(() => decodeLoadPaymentReport({ ...report, settlementSamples: regressed }))
      .toThrow('HLT_PAYMENT_REPORT_SAMPLE_SEQUENCE_INVALID:2');
  });

  test('a non-decimal amount is rejected', () => {
    expect(() => decodeLoadPaymentReport({ ...report, amount: '1e3' }))
      .toThrow('HLT_PAYMENT_REPORT_AMOUNT_INVALID');
  });
});
