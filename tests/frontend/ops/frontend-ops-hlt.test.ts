import { describe, expect, test } from 'bun:test';

import {
  buildOpsHltConfig,
  buildOpsHltStartRequest,
  OPS_HLT_DEFAULT_CONTROLS,
  opsHltVerdict,
  previewOpsHlt,
  readOpsHltMode,
  readOpsHltReplayMode,
} from '../../../frontend/apps/ops/src/ops-hlt-model';
import { opsPageMetadata, resolveOpsPage } from '../../../frontend/apps/ops/src/ops-model';
import { decodeHltDashboardPayload } from '../../../frontend/src/lib/qa/hlt';

const HLT_PAYLOAD = {
  ok: true,
  snapshotError: null,
  ledger: [{
    at: '2026-08-18T23:30:00Z',
    commit: '9a00c8cd6',
    headline: 'Batched hub-poll payments: 149/s at 200 users',
    detail: '1000/1000 in 6.7 s',
    users: 200,
    paymentsTps: 149.3,
    swapsTps: 0,
    status: 'green',
  }],
  payment: {
    deliveredTps: 149.276,
    offeredRate: 100,
    submittedPayments: 1000,
    acceptedPayments: 1000,
    completedPayments: 1000,
    drainedPayments: 1000,
    sourceDispatchP95Ms: 8,
    sourceDispatchMaxMs: 12,
    sourceAckMaxMs: 20,
    deliveredPayments: 1000,
    elapsedMs: 6699,
    users: 200,
    senders: 100,
    hubFrames: 14,
    paymentsPerFrame: 71.4,
    walDeltaBytes: 16588085,
    heightBefore: 299,
    heightAfter: 313,
  },
  swap: null,
  replay: null,
  perf: {
    parsedProfiles: 1,
    rows: [{
      runtime: 'H1', metric: 'runtime.process.total', count: 14, avgMs: 80,
      minMs: 40, p50Ms: 70, p95Ms: 120, p99Ms: 140, maxMs: 150, totalMs: 1120,
    }],
  },
  hubPerf: [{ hubLabel: 'H1', processCount: 14, processAvgMs: 80, processTotalMs: 1120, cpuTps: 892.9 }],
  run: {
    active: false,
    status: 'green',
    pid: 4242,
    phase: 'build',
    workDir: '/tmp/xln-hlt-200',
    logPath: '/tmp/xln-hlt-200/run.log',
    recordingPath: '/tmp/xln-hlt-200/h1.json',
    reportPath: '/tmp/xln-hlt-200/report.json',
    startedAt: 1_777_000_000_000,
    finishedAt: 1_777_000_006_699,
    exitCode: 0,
    error: null,
    logTail: 'completed',
  },
};

describe('React ops HLT control model', () => {
  test('previews the canonical default HLT population without duplicating planning math', () => {
    const preview = previewOpsHlt(OPS_HLT_DEFAULT_CONTROLS);
    expect(preview.config.users).toBe(200);
    expect(preview.config.runtimesPerProcess).toBe(200);
    expect(preview.daemons).toBe(1);
    expect(preview.offeredPayPerSecond).toBe(200);
    expect(preview.warning).toContain('does not attach to the live hub-node');

    const reduced = previewOpsHlt({ ...OPS_HLT_DEFAULT_CONTROLS, users: 64 });
    expect(reduced.daemons).toBe(1);
    expect(reduced.offeredPayPerSecond).toBe(64);
  });

  test('builds the exact start request from validated visible controls', () => {
    const controls = {
      ...OPS_HLT_DEFAULT_CONTROLS,
      users: 400,
      hubs: 'H1,H2',
      replayMode: 'sweep' as const,
      replayRates: '250,500,1000',
    };
    expect(buildOpsHltStartRequest(controls, 'replay')).toEqual({
      users: 400,
      runtimesPerProcess: 200,
      rate: 1,
      duration: 10,
      hubs: 'H1,H2',
      mode: 'payments',
      profile: true,
      paymentMin: '1000',
      paymentMax: '1000',
      phase: 'replay',
      replayMode: 'sweep',
      replayRates: '250,500,1000',
    });
  });

  test('rejects invalid selector and payment-range state before POST', () => {
    expect(() => readOpsHltMode('legacy')).toThrow('OPS_HLT_MODE_INVALID:legacy');
    expect(() => readOpsHltReplayMode('fast')).toThrow('OPS_HLT_REPLAY_MODE_INVALID:fast');
    expect(() => buildOpsHltConfig({ ...OPS_HLT_DEFAULT_CONTROLS, paymentAmountMin: 200, paymentAmountMax: 100 }))
      .toThrow('OPS_HLT_PAYMENT_RANGE_INVALID');
  });
});

describe('React ops HLT evidence', () => {
  test('decodes authoritative payment, performance, ledger, and run evidence', () => {
    const snapshot = decodeHltDashboardPayload(HLT_PAYLOAD);
    expect(snapshot.payment?.deliveredTps).toBe(149.276);
    expect(snapshot.payment?.hubFrames).toBe(14);
    expect(snapshot.perf.rows[0]?.metric).toBe('runtime.process.total');
    expect(snapshot.ledger[0]?.status).toBe('green');
    expect(opsHltVerdict(snapshot)).toEqual({ status: 'PASS', detail: 'Latest HLT evidence decoded and available' });
  });

  test('keeps active and failed run authority visible', () => {
    const active = decodeHltDashboardPayload({ ...HLT_PAYLOAD, run: { ...HLT_PAYLOAD.run, active: true, status: 'running' } });
    expect(opsHltVerdict(active).status).toBe('RUNNING');
    const failed = decodeHltDashboardPayload({ ...HLT_PAYLOAD, run: { ...HLT_PAYLOAD.run, status: 'red', error: 'drain gate failed' } });
    expect(opsHltVerdict(failed)).toEqual({ status: 'FAIL', detail: 'drain gate failed' });
  });

  test('owns the HLT route without claiming the QA cockpit', () => {
    const page = resolveOpsPage('/qa/hlt');
    expect(page).toEqual({ kind: 'hlt', pathname: '/qa/hlt' });
    expect(opsPageMetadata(page).title).toBe('xln HLT Load Stand');
    expect(resolveOpsPage('/qa')).toEqual({ kind: 'pending', pathname: '/qa' });
  });

  test('wires real HLT endpoints, active-only polling, abort teardown, and a lazy route chunk', async () => {
    const [source, runtime, app] = await Promise.all([
      Bun.file('frontend/apps/ops/src/ops-hlt-source.ts').text(),
      Bun.file('frontend/apps/ops/src/ops-hlt-runtime.ts').text(),
      Bun.file('frontend/apps/ops/src/ops-app.tsx').text(),
    ]);
    expect(source).toContain("qaFetch('/api/qa/hlt'");
    expect(source).toContain("action('/api/qa/hlt/start'");
    expect(source).toContain("action('/api/qa/hlt/abort'");
    expect(source).toContain('snapshot.data?.run.active');
    expect(source).toContain('1_000');
    expect(runtime).toContain("addEventListener('pagehide'");
    expect(runtime).toContain('opsHltSource.stop()');
    expect(app).toContain("import('./ops-hlt')");
  });
});
