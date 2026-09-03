import { describe, expect, test, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { maybeHandleQaRequest } from '../../../qa/api';
import {
  paymentCardFromReport,
  publishHltDashboardPerfFromWorkDir,
  publishHltDashboardReport,
  readHltDashboardSnapshot,
} from '../../../qa/hlt/hlt-dashboard';
import { parseHltDashboardConfig, previewHltDashboard } from '../../../qa/hlt/hlt-dashboard-preview';
import {
  assertHltIsolatedEnv,
  buildHltIsolatedEnv,
  resetHltIsolatedRunForTests,
} from '../../../qa/hlt/hlt-run';
import { summarizeRuntimePerfLines } from '../../../scripts/operations/benchmark/analyze-runtime-perf';
import { safeStringify } from '../../../protocol/serialization';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const SAMPLE_PAYMENT = {
  schema: 'xln-hlt-payment-load-v1',
  engine: 'rust',
  mode: 'payments',
  runId: 'hlt-dashboard-test',
  completionAuthority: 'committed_entity_metrics_and_bilateral_runtime_quiescence',
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
  sourceDispatchFinishedElapsedMs: 60,
  sourceAllAckedElapsedMs: 70,
  commandObservedElapsedMs: 70,
  deliveredElapsedMs: 6699,
  drainCompleteElapsedMs: 7000,
  deliveredTps: 149.27601134497687,
  hubCompletedPaymentsBefore: 50,
  hubCompletedPaymentsAfter: 1050,
  hubAcceptedPaymentsBefore: 40,
  hubAcceptedPaymentsAfter: 1040,
  hubIngressElapsedMs: 5000,
  settlementSamples: [
    { elapsedMs: 5000, runtimeHeight: 310, acceptedPayments: 1000, completedPayments: 900, paybookOpen: 100 },
    { elapsedMs: 6699, runtimeHeight: 313, acceptedPayments: 1000, completedPayments: 1000, paybookOpen: 0 },
  ],
  roundSubmissionLagMs: Array.from({ length: 1000 }, () => 1),
  laneQuiescence: {
    runtimes: 200,
    openHubPeers: 200,
    pendingRuntimeWork: 0,
    pendingAccountFrames: 0,
    accountMempoolTxs: 0,
  },
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
  environment: {
    disputeHankos: 'always', hubWalSync: true, lanePersistence: false, laneWalSync: false,
    laneNice: 0, cryptoPoolWorkers: 'default', cryptoSignWorkers: 'default', accountWorkers: 4,
  },
};

describe('hlt dashboard preview', () => {
  test('200 sovereign users all offer one payment per second on one hub', () => {
    const preview = previewHltDashboard(parseHltDashboardConfig(new URLSearchParams({
      users: '200',
      runtimesPerProcess: '40',
      rate: '1',
      duration: '10',
      mix: '1:1',
      hubs: 'H1',
      mode: 'payments',
    })));
    expect(preview.daemons).toBe(5);
    expect(preview.offeredPayPerSecond).toBe(200);
    expect(preview.offeredSwapPerSecond).toBe(0);
    expect(preview.config.mix).toBe('0:1');
    expect(preview.hubShare.workerSingleHubPct).toBe(100);
    expect(preview.hubShare.workerMultiHubPct).toBe(0);
    expect(preview.isolatedCommand).toContain('XLN_HLT_RUNTIMES_PER_PROCESS=40');
    expect(preview.warning).toContain('8082');
  });

  test('mixed 1000 users at 1 action/s offer 1000 pay/s and 1000 swap/s', () => {
    const preview = previewHltDashboard(parseHltDashboardConfig(new URLSearchParams({
      users: '1000',
      runtimesPerProcess: '40',
      rate: '1',
      duration: '1',
      mix: '0:1',
      hubs: 'H1',
      mode: 'mixed',
    })));
    expect(preview.config.mix).toBe('1:1');
    expect(preview.offeredPayPerSecond).toBe(1000);
    expect(preview.offeredSwapPerSecond).toBe(1000);
    expect(preview.paymentLanes).toBe(1000);
    expect(preview.swapLanes).toBe(500);
    expect(preview.isolatedCommand).toContain('XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE=mixed');
  });

  test('cross-j on two hubs is 100% multi-hub path', () => {
    const preview = previewHltDashboard(parseHltDashboardConfig(new URLSearchParams({
      users: '8',
      runtimesPerProcess: '2',
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
    publishHltDashboardReport('payment', { ...SAMPLE_PAYMENT, runId: basename(workDir) }, root);
    publishHltDashboardPerfFromWorkDir(workDir, root);
    const paymentArtifact = JSON.parse(readFileSync(join(root, '.logs/qa/hlt/latest-payment.json'), 'utf8')) as {
      runId?: string;
    };
    const perfArtifact = JSON.parse(readFileSync(join(root, '.logs/qa/hlt/latest-perf.json'), 'utf8')) as {
      runId?: string;
    };
    expect(paymentArtifact.runId).toBe(basename(workDir));
    expect(perfArtifact.runId).toBe(paymentArtifact.runId);
    const snapshot = readHltDashboardSnapshot(root);
    expect(snapshot.payment?.deliveredTps).toBeCloseTo(149.276, 3);
    expect(snapshot.perf.parsedProfiles).toBe(1);
    expect(snapshot.hubPerf[0]?.hubLabel).toBe('H1');
    expect(snapshot.hubPerf[0]?.cpuTps).toBeCloseTo(1000 * 1000 / 12);
  });

  test('replay card carries the parity gate engine ladder', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-hlt-dash-'));
    const replays = join(root, '.logs/qa/hlt/replays');
    mkdirSync(replays, { recursive: true });
    const trial = {
      offeredTps: null, frames: 73, accountInputs: 18304, accountTxs: 18304, outboxEnvelopes: 14009,
      elapsedMs: 8753.9, cpuMs: 4713.9, accountInputTps: 2090.9, accountTxTps: 3883.4, cpuAccountTxTps: 3883.4,
      finalHeight: 81, finalPendingOutbox: 1, equivalent: true,
    };
    writeFileSync(join(replays, '1-parity.json'), safeStringify({
      schema: 'xln-hlt-hub-replay-report-v1',
      createdAt: 1,
      recordingManifestHash: `0x${'ab'.repeat(32)}`,
      mode: 'max',
      trials: [
        { ...trial, engine: 'ts', workers: 1 },
        { ...trial, engine: 'rust', workers: 8 },
        trial,
      ],
    }));
    const snapshot = readHltDashboardSnapshot(root);
    expect(snapshot.replay?.trials.map(row => [row.engine, row.workers])).toEqual([['ts', 1], ['rust', 8], [null, null]]);
    writeFileSync(join(replays, '2-parity.json'), safeStringify({
      schema: 'xln-hlt-hub-replay-report-v1', createdAt: 2, recordingManifestHash: `0x${'ab'.repeat(32)}`, mode: 'max',
      trials: [{ ...trial, engine: 'go', workers: 1 }],
    }));
    expect(() => readHltDashboardSnapshot(root)).toThrow('HLT_REPLAY_TRIAL_ENGINE_INVALID:0');
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
    new Request('http://127.0.0.1:8080/api/qa/hlt?users=64&runtimesPerProcess=16&mode=payments'),
    '/api/qa/hlt',
    JSON_HEADERS,
  );
  expect(response?.status).toBe(200);
  const payload = await response!.json() as {
    ok?: boolean;
    preview?: { daemons?: number; offeredPayPerSecond?: number };
    run?: { status?: string; active?: boolean };
  };
  expect(payload.ok).toBe(true);
  expect(payload.preview?.daemons).toBe(4);
  expect(payload.preview?.offeredPayPerSecond).toBe(64);
  expect(payload.run).toEqual({
    active: false,
    status: 'idle',
    pid: null,
    phase: null,
    workDir: null,
    logPath: null,
    recordingPath: null,
    reportPath: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    logTail: '',
  });
});

const mockHltChild = (): ChildProcess => {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.pid = 4242;
  child.stdout = new EventEmitter() as ChildProcess['stdout'];
  child.stderr = new EventEmitter() as ChildProcess['stderr'];
  child.kill = () => {
    queueMicrotask(() => child.emit('exit', 143));
    return true;
  };
  child.unref = () => child;
  return child;
};

afterEach(() => {
  resetHltIsolatedRunForTests();
});

test('isolated HLT env keeps PATH and drops live mesh ports', () => {
  const env = buildHltIsolatedEnv(
    parseHltDashboardConfig(new URLSearchParams({ users: '8', runtimesPerProcess: '2', mode: 'payments' })),
    '/tmp/xln-hlt-dash-test',
    {
      PATH: '/usr/bin',
      XLN_PORT_BASE: '8082',
      ANVIL_RPC: 'http://127.0.0.1:8545',
      XLN_MESH_API_PORT_BASE: '8082',
      XLN_LOCAL_TEST_LEASE_BASE: '20000',
    },
  );
  expect(env['PATH']).toBe('/usr/bin');
  expect(env['XLN_HLT_USERS']).toBe('8');
  expect(env['XLN_LOCAL_PROD_SMOKE_DIR']).toBe('/tmp/xln-hlt-dash-test');
  expect(env['XLN_PORT_BASE']).toBeUndefined();
  expect(env['ANVIL_RPC']).toBeUndefined();
  expect(env['XLN_MESH_API_PORT_BASE']).toBeUndefined();
  expect(env['XLN_LOCAL_TEST_LEASE_BASE']).toBeUndefined();
  assertHltIsolatedEnv(env);
  expect(() => assertHltIsolatedEnv({ XLN_PORT_BASE: '8082' })).toThrow('HLT_RUN_ENV_LEAK:XLN_PORT_BASE');
});

test('POST /api/qa/hlt/start is single-flight and abortable', async () => {
  const previousDisabled = process.env['XLN_QA_AUTH_DISABLED'];
  const previousAdmin = process.env['XLN_QA_ADMIN_TOKEN'];
  process.env['XLN_QA_AUTH_DISABLED'] = '1';
  delete process.env['XLN_QA_ADMIN_TOKEN'];
  try {
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    let spawnedArgs: readonly string[] = [];
    const spawnHlt = ((_cmd: string, args: readonly string[], options?: SpawnOptions) => {
      spawnedArgs = args;
      spawnedEnv = options?.env as NodeJS.ProcessEnv;
      return mockHltChild();
    }) as typeof import('node:child_process').spawn;

    const start = await maybeHandleQaRequest(
      new Request('http://127.0.0.1:8080/api/qa/hlt/start', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ users: 8, runtimesPerProcess: 2, mode: 'payments', duration: 4 }),
      }),
      '/api/qa/hlt/start',
      JSON_HEADERS,
      { operatorAuthorized: true, spawnHlt },
    );
    expect(start?.status).toBe(202);
    const started = await start!.json() as { run?: { active?: boolean; status?: string; pid?: number } };
    expect(started.run?.active).toBe(true);
    expect(started.run?.status).toBe('running');
    expect(started.run?.pid).toBe(4242);
    expect(spawnedEnv?.['XLN_HLT_USERS']).toBe('8');
    expect(spawnedArgs).toEqual(['core/scripts/operations/hlt/build-chains.ts']);
    expect(spawnedEnv?.['XLN_PORT_BASE']).toBeUndefined();
    expect(spawnedEnv?.['ANVIL_RPC']).toBeUndefined();

    const conflict = await maybeHandleQaRequest(
      new Request('http://127.0.0.1:8080/api/qa/hlt/start', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ users: 8, runtimesPerProcess: 2, mode: 'payments' }),
      }),
      '/api/qa/hlt/start',
      JSON_HEADERS,
      { operatorAuthorized: true, spawnHlt },
    );
    expect(conflict?.status).toBe(409);

    const abort = await maybeHandleQaRequest(
      new Request('http://127.0.0.1:8080/api/qa/hlt/abort', { method: 'POST' }),
      '/api/qa/hlt/abort',
      JSON_HEADERS,
      { operatorAuthorized: true },
    );
    expect(abort?.status).toBe(202);
    await Bun.sleep(20);
    const status = await maybeHandleQaRequest(
      new Request('http://127.0.0.1:8080/api/qa/hlt'),
      '/api/qa/hlt',
      JSON_HEADERS,
    );
    const idle = await status!.json() as { run?: { active?: boolean; status?: string } };
    expect(idle.run?.active).toBe(false);
    expect(idle.run?.status).toBe('aborted');
  } finally {
    if (previousDisabled === undefined) delete process.env['XLN_QA_AUTH_DISABLED'];
    else process.env['XLN_QA_AUTH_DISABLED'] = previousDisabled;
    if (previousAdmin === undefined) delete process.env['XLN_QA_ADMIN_TOKEN'];
    else process.env['XLN_QA_ADMIN_TOKEN'] = previousAdmin;
  }
});

test('POST /api/qa/hlt/start rejects one-hub cross-j', async () => {
  const previousDisabled = process.env['XLN_QA_AUTH_DISABLED'];
  process.env['XLN_QA_AUTH_DISABLED'] = '1';
  try {
    const response = await maybeHandleQaRequest(
      new Request('http://127.0.0.1:8080/api/qa/hlt/start', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ users: 8, runtimesPerProcess: 2, mode: 'cross', hubs: 'H1' }),
      }),
      '/api/qa/hlt/start',
      JSON_HEADERS,
      { operatorAuthorized: true, spawnHlt: (() => { throw new Error('SPAWN_MUST_NOT_RUN'); }) as typeof import('node:child_process').spawn },
    );
    expect(response?.status).toBe(400);
    const payload = await response!.json() as { error?: string };
    expect(payload.error).toBe('HLT_RUN_CROSS_NEEDS_TWO_HUBS');
  } finally {
    if (previousDisabled === undefined) delete process.env['XLN_QA_AUTH_DISABLED'];
    else process.env['XLN_QA_AUTH_DISABLED'] = previousDisabled;
  }
});
