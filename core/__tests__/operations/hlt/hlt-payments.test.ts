import { describe, expect, test } from 'bun:test';

import {
  paymentReceiverIndex,
  paymentTotalPerSender,
  paymentTotalsByReceiver,
} from '../../../scripts/operations/hlt/workload/worker-payments-plan';
import { decodeLoadPaymentReport } from '../../../scripts/operations/hlt/boundary/worker-payment-boundary';
import { parseWorkerArgs } from '../../../scripts/operations/hlt/worker-runtime';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('hlt payment population', () => {
  test('payment route and balance readers stay bounded per daemon', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../../scripts/operations/hlt/workload/worker-payments.ts'),
      'utf8',
    );
    expect(source).toContain('laneDaemons(senders)');
    expect(source).toContain('READ_CONCURRENCY');
    expect(source).toContain('forEachLimited');
    expect(source).toContain('sendEnqueued');
    expect(source).toContain('waitForHubSettlement');
    expect(source).toContain('accountsLimit: 10');
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

  test('receiver totals account for every submitted payment exactly', () => {
    const senders = 8;
    const rounds = 5;
    const amount = 1_000n;
    const totals = paymentTotalsByReceiver(senders, senders, rounds, amount);
    expect(totals).toHaveLength(senders);
    expect(totals.reduce((sum, total) => sum + total, 0n))
      .toBe(amount * BigInt(senders * rounds));
    expect(paymentTotalPerSender(rounds, amount)).toBe(amount * BigInt(rounds));
  });

  test('pairing rejects an out-of-range sender instead of wrapping silently', () => {
    expect(() => paymentReceiverIndex(4, 0, 4)).toThrow('HLT_PAYMENT_SENDER_INDEX_INVALID');
    expect(() => paymentReceiverIndex(0, 0, 0)).toThrow('HLT_PAYMENT_RECEIVERS_INVALID');
    expect(() => paymentTotalPerSender(0, 1n)).toThrow('HLT_PAYMENT_ROUNDS_INVALID');
    expect(() => paymentTotalPerSender(1, 0n)).toThrow('HLT_PAYMENT_AMOUNT_INVALID');
  });

  test('payments mode derives its population from the payment half of the mix', () => {
    const args = parseWorkerArgs([
      '--work-dir', '/tmp/xln-load',
      '--port-base', '20000',
      '--mode', 'payments',
      '--users', '64',
      '--rate-per-user', '2',
      '--duration-s', '10',
      '--mix', '0:1',
    ]);
    expect(args.lanes).toBe(32);
    expect(args.rounds).toBe(20);
    expect(args.cadenceMs).toBe(500);
    expect(args.plan?.paymentLanes).toBe(32);
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
});

describe('hlt payment report boundary', () => {
  const frame = { height: 12, canonicalStateHash: `0x${'ab'.repeat(32)}` };
  const report = {
    schema: 'xln-hlt-payment-load-v1',
    mode: 'payments',
    completionAuthority: 'committed_receiver_balances_and_bilateral_quiescence',
    configuredUsers: 64, configuredRounds: 10, cadenceMs: 1_000,
    senders: 32, receivers: 32, tokenId: 1, amount: '1000',
    offeredPaymentRate: 32, submittedPayments: 320, deliveredPayments: 320,
    enqueueAckElapsedMs: 10, commandObservedElapsedMs: 20, deliveredElapsedMs: 30,
    deliveredTps: 10.5, roundSubmissionLagMs: [1, 2, 3],
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
    expect(() => decodeLoadPaymentReport({ ...report, commandObservedElapsedMs: 9 }))
      .toThrow('HLT_PAYMENT_REPORT_TIMING_INVALID');
    expect(() => decodeLoadPaymentReport({ ...report, deliveredElapsedMs: 19 }))
      .toThrow('HLT_PAYMENT_REPORT_TIMING_INVALID');
  });

  test('a non-decimal amount is rejected', () => {
    expect(() => decodeLoadPaymentReport({ ...report, amount: '1e3' }))
      .toThrow('HLT_PAYMENT_REPORT_AMOUNT_INVALID');
  });
});
