import { describe, expect, test } from 'bun:test';

import {
  decodeOpsRuns,
  filterOpsRuns,
  opsRunsCategories,
  requestedOpsRunId,
  summarizeOpsRuns,
} from '../../../frontend/apps/ops/src/ops-runs-model';
import { createOpsRunsSource } from '../../../frontend/apps/ops/src/ops-runs-source';
import { opsPageMetadata, resolveOpsPage } from '../../../frontend/apps/ops/src/ops-model';
import type { QaRunLedgerEntry } from '../../../frontend/packages/runtime-client/src/qa-types';

const signal = { severity: 'OK', reason: 'fixture', since: 1, owner: 'qa', evidence: [] } as const;
const row = (runId: string, status: 'passed' | 'failed', createdAt: number, durationMs: number): QaRunLedgerEntry => ({
  ...signal, runId, status, createdAt, completedAt: createdAt + durationMs, category: status === 'passed' ? 'unit' : 'e2e',
  testCategory: 'functional', suiteKey: `suite.${runId}`, suiteLabel: `Suite ${runId}`, gitHead: 'abcdef0123456789',
  gitBranch: 'main', codeHash: '0123456789abcdef', dirty: false, startedBy: 'owner', durationMs,
  timing: { totalMs: durationMs, bootstrapMs: 20, playwrightMs: durationMs - 20, avgShardMs: durationMs },
  failedShard: status === 'failed' ? 'fixture.ts' : null, failedTargets: status === 'failed' ? ['fixture.ts'] : [],
  artifactBytes: 1024, cpuP95Pct: 12, cpuPeakPct: 18, ramPeakKb: 4096, browserErrors: status === 'failed' ? 1 : 0,
  browserWarnings: 0, networkFailures: 0, benchmarkStatus: status === 'failed' ? 'slower' : 'ok',
  benchmarkDeltaPct: status === 'failed' ? 12 : 0, benchmarkComparedRunId: null, auditAction: null,
});

const payload = decodeOpsRuns({
  ok: true, qaAuth: { scope: 'read' }, runs: [], testLedger: [], regression: null, verdict: null,
  ledger: [row('run-new', 'failed', 20, 400), row('run-old', 'passed', 10, 100)],
});

describe('React ops runs model', () => {
  test('strictly decodes, filters, sorts, and summarizes the canonical ledger', () => {
    expect(payload.auth).toBe('read');
    expect(opsRunsCategories(payload.rows)).toEqual(['e2e', 'unit']);
    expect(filterOpsRuns(payload.rows, 'all', 'owner', 'stack-fast').map(item => item.runId)).toEqual(['run-old', 'run-new']);
    expect(filterOpsRuns(payload.rows, 'e2e', 'run-new', 'date-desc').map(item => item.runId)).toEqual(['run-new']);
    expect(summarizeOpsRuns(payload.rows)).toEqual({ total: 2, passed: 1, failed: 1, benchmarkAlerts: 1, browserAlerts: 1 });
    expect(requestedOpsRunId(new URL('https://xln.test/runs?runId=run-new'))).toBe('run-new');
    expect(() => decodeOpsRuns({ ok: true, runs: [], ledger: [], unexpected: true })).toThrow('QA_RESPONSE_EXTRA_FIELD');
  });

  test('owns /runs with operator metadata alongside the scenarios slice', () => {
    const page = resolveOpsPage('/runs');
    expect(page).toEqual({ kind: 'runs', pathname: '/runs' });
    expect(opsPageMetadata(page).title).toBe('xln Runs Ledger');
    expect(resolveOpsPage('/scenarios')).toEqual({ kind: 'scenarios', pathname: '/scenarios' });
  });
});

describe('React ops runs source', () => {
  test('loads one ledger, preserves URL selection, and aborts on teardown', async () => {
    let url = new URL('https://xln.test/runs?runId=run-old');
    let aborted = false;
    const source = createOpsRunsSource({
      fetchRuns: async signal => { signal.addEventListener('abort', () => { aborted = true; }); return payload; },
      currentUrl: () => new URL(url),
      replaceUrl: next => { url = new URL(next); },
    });
    await source.start();
    expect(source.getSnapshot()).toMatchObject({ status: 'ready', selectedRunId: 'run-old', auth: 'read' });
    source.selectRun('run-new');
    expect(url.searchParams.get('runId')).toBe('run-new');
    source.stop();
    expect(source.getSnapshot().status).toBe('idle');
    expect(aborted).toBe(false);
  });

  test('lazy-loads the page/runtime and tears down at pagehide', async () => {
    const [app, main, runtime] = await Promise.all([
      Bun.file('frontend/apps/ops/src/ops-app.tsx').text(),
      Bun.file('frontend/apps/ops/src/main.tsx').text(),
      Bun.file('frontend/apps/ops/src/ops-runs-runtime.ts').text(),
    ]);
    expect(app).toContain("import('./ops-runs')");
    expect(main).toContain("import('./ops-runs-runtime')");
    expect(runtime).toContain("addEventListener('pagehide'");
    expect(runtime).toContain('opsRunsSource.stop()');
  });
});
