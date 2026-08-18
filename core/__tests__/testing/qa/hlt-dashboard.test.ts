import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maybeHandleQaRequest } from '../../../qa/api';
import {
  paymentCardFromReport,
  publishHltDashboardPerfFromWorkDir,
  publishHltDashboardReport,
  readHltDashboardSnapshot,
} from '../../../qa/hlt/hlt-dashboard';
import { parseHltDashboardConfig, previewHltDashboard } from '../../../qa/hlt/hlt-dashboard-preview';
import { summarizeRuntimePerfLines } from '../../../scripts/operations/benchmark/analyze-runtime-perf';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const SAMPLE_PAYMENT = {
  schema: 'xln-hlt-payment-load-v1',
  mode: 'payments',
  completionAuthority: 'committed_receiver_balances_and_bilateral_quiescence',
  configuredUsers: 200,
  configuredRounds: 10,
  cadenceMs: 1000,
  senders: 100,
  receivers: 100,
  tokenId: 1,
  amount: '1000',
  offeredPaymentRate: 100,
  submittedPayments: 1000,
  deliveredPayments: 1000,
  enqueueAckElapsedMs: 70,
  commandObservedElapsedMs: 70,
  deliveredElapsedMs: 6699,
  deliveredTps: 149.27601134497687,
  roundSubmissionLagMs: [74],
  walBytesBefore: 13268608,
  walBytesAfter: 29856693,
  hubDurableBefore: {
    height: 299,
    canonicalStateHash: '0x74e7727ece297d62bc8082d662385a6d92c412c38dfb0420c2483017ebc3c845',
  },
  hubDurableAfter: {
    height: 313,
    canonicalStateHash: '0x35eecd38bd0a40efc6431d181b1d0dd09d05916cc53e8fa9c0d16a33723ae817',
  },
};

describe('hlt dashboard preview', () => {
  test('200 users at 40 per process offer 100 pay/s on one hub', () => {
    const preview = previewHltDashboard(parseHltDashboardConfig(new URLSearchParams({
      users: '200',
      usersPerRuntime: '40',
      rate: '1',
      duration: '10',
      mix: '1:1',
      hubs: 'H1',
      mode: 'payments',
    })));
    expect(preview.daemons).toBe(5);
    expect(preview.offeredPayPerSecond).toBe(100);
    expect(preview.offeredSwapPerSecond).toBe(0);
    expect(preview.config.mix).toBe('0:1');
    expect(preview.hubShare.workerSingleHubPct).toBe(100);
    expect(preview.hubShare.workerMultiHubPct).toBe(0);
    expect(preview.isolatedCommand).toContain('XLN_HLT_USERS_PER_RUNTIME=40');
    expect(preview.warning).toContain('8082');
  });

  test('cross-j on two hubs is 100% multi-hub path', () => {
    const preview = previewHltDashboard(parseHltDashboardConfig(new URLSearchParams({
      users: '8',
      usersPerRuntime: '2',
      hubs: 'H1,H2',
      mode: 'cross',
    })));
    expect(preview.hubShare.routing).toBe('cross_j_path');
    expect(preview.hubShare.workerMultiHubPct).toBe(100);
    expect(preview.daemons).toBe(4);
  });
});

describe('hlt dashboard snapshot', () => {
  test('payment card derives hub frames and pays/frame', () => {
    const card = paymentCardFromReport(SAMPLE_PAYMENT);
    expect(card.hubFrames).toBe(14);
    expect(card.paymentsPerFrame).toBeCloseTo(1000 / 14);
    expect(card.deliveredTps).toBeCloseTo(149.276, 3);
  });

  test('publishes payment + perf tail for the dashboard', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-hlt-dash-'));
    const workDir = mkdtempSync(join(tmpdir(), 'xln-hlt-work-'));
    writeFileSync(
      join(workDir, 'server.log'),
      '[H1] [INFO][runtime] process.profile {"elapsedMs":12,"phases":[{"name":"apply","ms":12}]}\n',
    );
    publishHltDashboardReport('payment', SAMPLE_PAYMENT, root);
    publishHltDashboardPerfFromWorkDir(workDir, root);
    const snapshot = readHltDashboardSnapshot(root);
    expect(snapshot.payment?.deliveredTps).toBeCloseTo(149.276, 3);
    expect(snapshot.perf.parsedProfiles).toBe(1);
    expect(snapshot.hubPerf[0]?.hubLabel).toBe('H1');
    expect(snapshot.hubPerf[0]?.cpuTps).toBeCloseTo(1000 * 1000 / 12);
  });
});

test('summarizeRuntimePerfLines is isolated from later calls', () => {
  const first = summarizeRuntimePerfLines([
    '[H1] [INFO][runtime] process.profile {"elapsedMs":10,"phases":[{"name":"apply","ms":10}]}',
  ]);
  const second = summarizeRuntimePerfLines([]);
  expect(first.parsedProfiles).toBe(1);
  expect(second.parsedProfiles).toBe(0);
  expect(second.rows).toEqual([]);
});

test('GET /api/qa/hlt returns a payments preview', async () => {
  const response = await maybeHandleQaRequest(
    new Request('http://127.0.0.1:8080/api/qa/hlt?users=64&usersPerRuntime=16&mode=payments'),
    '/api/qa/hlt',
    JSON_HEADERS,
  );
  expect(response?.status).toBe(200);
  const payload = await response!.json() as {
    ok?: boolean;
    preview?: { daemons?: number; offeredPayPerSecond?: number };
  };
  expect(payload.ok).toBe(true);
  expect(payload.preview?.daemons).toBe(4);
  expect(payload.preview?.offeredPayPerSecond).toBe(32);
});
