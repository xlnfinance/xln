import { describe, expect, test } from 'bun:test';

import { QA as ROOT_QA } from '../../../core/config/constants';
import { QA as BROWSER_QA } from '../../../core/config/qa';
import {
  abortOpsQaRestart,
  backfillOpsQaHistory,
  OPS_QA_CONFIRMATIONS,
  planOpsQaRestart,
  purgeOpsQaHistory,
  runOpsQaRestart,
  type OpsQaActionPost,
} from '../../../frontend/apps/ops/src/ops-qa-actions';
import {
  decodeOpsQaMeta,
  decodeOpsQaRun,
  decodeOpsQaRuns,
  pickOpsQaShardIndex,
  requestedQaSelection,
} from '../../../frontend/apps/ops/src/ops-qa-model';
import { createOpsQaSource, type OpsQaBundle } from '../../../frontend/apps/ops/src/ops-qa-source';
import { opsPageMetadata, resolveOpsPage } from '../../../frontend/apps/ops/src/ops-model';

const signal = { severity: 'OK', reason: 'fixture', since: 1, owner: 'qa', evidence: [] } as const;
const summary = (runId: string, status: 'passed' | 'failed') => ({
  ...signal, runId, status, createdAt: 1, completedAt: 2, suiteKey: 'qa.fixture', suiteLabel: 'QA fixture',
  category: 'e2e', testCategory: 'functional', failingTargets: status === 'failed' ? ['fixture.ts'] : [],
});
const shard = (index: number, status: 'passed' | 'failed') => ({
  ...signal, shard: index, status, durationMs: 10, handle: `qa.fixture.${index}`, target: 'fixture.ts', title: 'fixture',
  error: null, hasVideo: false, hasTrace: false, artifacts: [], timelineSteps: [], slowSteps: [],
});
const run = (runId: string) => ({ ...signal, runId, status: 'failed', createdAt: 1, completedAt: 2, totalShards: 2, shards: [shard(4, 'passed'), shard(7, 'failed')] });

const runsPayload = decodeOpsQaRuns({
  ok: true,
  qaAuth: { scope: 'read', disabled: false, actorKeyId: 'fixture' },
  runs: [summary('run-a', 'failed'), summary('run-b', 'passed')],
  ledger: [],
  testLedger: [],
  regression: null,
  verdict: null,
});

const metaPayload = decodeOpsQaMeta({
  catalog: { ok: true, qaAuth: { scope: 'admin', disabled: true, actorKeyId: 'fixture' }, catalog: [], restart: { active: false }, restartAllowed: true },
  history: { ok: true, qaAuth: { scope: 'read', disabled: false, actorKeyId: 'fixture' }, history: [], restart: { active: false }, restartAllowed: true },
  audit: { ok: true, qaAuth: { scope: 'read', disabled: false, actorKeyId: 'fixture' }, audit: [] },
  stories: { ok: true, qaAuth: { scope: 'read', disabled: false, actorKeyId: 'fixture' }, stories: [], releasePack: null },
});

describe('React ops QA boundary', () => {
  test('strictly decodes runs, metadata, auth, and URL selection', () => {
    expect(runsPayload.runs.map(entry => entry.runId)).toEqual(['run-a', 'run-b']);
    expect(metaPayload.auth).toBe('open');
    expect(metaPayload.restartAllowed).toBe(true);
    expect(() => decodeOpsQaRuns({ ok: true, runs: [], unexpected: true })).toThrow('QA_RESPONSE_EXTRA_FIELD');
    expect(requestedQaSelection(new URL('https://xln.test/qa?runId=run-a&shard=7'))).toEqual({ runId: 'run-a', shard: 7 });
    expect(pickOpsQaShardIndex(decodeOpsQaRun({ ok: true, run: run('run-a') }).run, 7)).toBe(1);
    expect(BROWSER_QA).toBe(ROOT_QA);
  });

  test('owns the QA route with metadata distinct from HLT', () => {
    const page = resolveOpsPage('/qa');
    expect(page).toEqual({ kind: 'qa', pathname: '/qa' });
    expect(opsPageMetadata(page).title).toBe('xln QA Cockpit');
    expect(resolveOpsPage('/qa/hlt')).toEqual({ kind: 'hlt', pathname: '/qa/hlt' });
    expect(resolveOpsPage('/runs')).toEqual({ kind: 'runs', pathname: '/runs' });
  });

  test('loads one coherent snapshot, preserves selection, and tears down timers', async () => {
    const bundle: OpsQaBundle = { runs: runsPayload, meta: metaPayload, adminHealth: null, adminHealthError: 'health unavailable' };
    let url = new URL('https://xln.test/qa?runId=run-b&shard=4');
    let timerCallback = (): void => undefined;
    let cleared = 0;
    const source = createOpsQaSource({
      fetchBundle: async () => bundle,
      fetchRun: async runId => decodeOpsQaRun({ ok: true, qaAuth: { scope: 'read' }, run: run(runId) }),
      currentUrl: () => new URL(url),
      replaceUrl: next => { url = new URL(next); },
      setTimer: callback => { timerCallback = callback; return 9; },
      clearTimer: handle => { cleared = handle; },
    });

    await source.start();
    expect(source.getSnapshot().status).toBe('ready');
    expect(source.getSnapshot().selectedRunId).toBe('run-b');
    expect(source.getSnapshot().selectedShardIndex).toBe(0);
    expect(source.getSnapshot().adminHealthError).toBe('health unavailable');
    await source.selectRun('run-a');
    source.selectShard(1);
    expect(url.searchParams.get('runId')).toBe('run-a');
    expect(url.searchParams.get('shard')).toBe('7');
    source.setAutoRefresh(false);
    timerCallback();
    source.stop();
    expect(cleared).toBe(9);
    expect(source.getSnapshot().status).toBe('idle');
  });
});

describe('React ops QA lifecycle wiring', () => {
  test('lazy-loads the route and runtime with active refresh and page teardown', async () => {
    const [app, main, source, runtime] = await Promise.all([
      Bun.file('frontend/apps/ops/src/ops-app.tsx').text(),
      Bun.file('frontend/apps/ops/src/main.tsx').text(),
      Bun.file('frontend/apps/ops/src/ops-qa-source.ts').text(),
      Bun.file('frontend/apps/ops/src/ops-qa-runtime.ts').text(),
    ]);

    expect(app).toContain("import('./ops-qa')");
    expect(main).toContain("import('./ops-qa-runtime')");
    expect(source).toContain('Promise.all');
    expect(source).toContain('15_000');
    expect(source).toContain('refreshController?.abort()');
    expect(source).toContain('selectionController?.abort()');
    expect(runtime).toContain("addEventListener('pagehide'");
    expect(runtime).toContain('opsQaSource.stop()');
  });
});

describe('React ops QA privileged requests', () => {
  test('uses the canonical endpoints and exact confirmation bodies', async () => {
    const calls: Array<Readonly<{ url: string; body: Readonly<object> }>> = [];
    const post: OpsQaActionPost = async (url, body) => {
      calls.push({ url, body });
      if (url.endsWith('mode=plan')) return { ok: true, command: ['bun', 'fixture.ts'], expectedGitHead: 'abc', codeHash: 'def', dirty: false };
      if (url.endsWith('mode=run') || url.endsWith('/abort')) return { ok: true, restart: { active: false } };
      if (url.endsWith('/backfill')) return { ok: true, result: { scannedRuns: 2, recordedRuns: 2, failedRuns: [] } };
      return { ok: true, result: { retentionDays: 30, cutoff: 1, deletedRunIds: ['old'], deletedLogDirs: 1, deletedHistoryRows: 1 } };
    };

    const plan = await planOpsQaRestart('run-a', 7, post);
    await runOpsQaRestart({ runId: 'run-a', shard: 7, operatorId: 'owner', reason: 'verify', confirm: OPS_QA_CONFIRMATIONS.restart, expectedGitHead: plan.expectedGitHead }, post);
    await abortOpsQaRestart(OPS_QA_CONFIRMATIONS.abort, post);
    await backfillOpsQaHistory(OPS_QA_CONFIRMATIONS.backfill, post);
    await purgeOpsQaHistory(OPS_QA_CONFIRMATIONS.retention, post);

    expect(calls.map(call => call.url)).toEqual([
      '/api/qa/restart?mode=plan', '/api/qa/restart?mode=run', '/api/qa/restart/abort',
      '/api/qa/history/backfill', '/api/qa/retention',
    ]);
    expect(calls[3]?.body).toEqual({ confirm: 'BACKFILL_QA_HISTORY', limit: 500 });
    expect(calls[4]?.body).toEqual({ confirm: 'DELETE_OLDER_THAN_30_DAYS' });
  });
});
