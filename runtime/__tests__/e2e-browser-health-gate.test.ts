import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarizeQaBrowserIssues, type QaBrowserIssue } from '../qa/report';
import { assertE2EBrowserHealthGate } from '../scripts/run-e2e-parallel-isolated';

const browserHealth = (overrides: Partial<{
  issueCount: number;
  errorCount: number;
  warningCount: number;
  networkFailureCount: number;
  httpErrorCount: number;
}> = {}) => ({
  issueCount: 0,
  errorCount: 0,
  warningCount: 0,
  networkFailureCount: 0,
  httpErrorCount: 0,
  ...overrides,
});

describe('isolated E2E browser health gate', () => {
  test('strict mode accepts a clean aggregated manifest', () => {
    expect(() => assertE2EBrowserHealthGate(browserHealth(), true)).not.toThrow();
  });

  test('strict mode rejects a missing browser-health aggregate', () => {
    expect(() => assertE2EBrowserHealthGate(undefined, true)).toThrow(
      'E2E_BROWSER_HEALTH_MANIFEST_MISSING',
    );
  });

  test.each([
    ['console error', { issueCount: 1, errorCount: 1 }],
    ['console warning', { issueCount: 1, warningCount: 1 }],
    ['network failure', { issueCount: 1, errorCount: 1, networkFailureCount: 1 }],
    ['HTTP response error', { issueCount: 1, warningCount: 1, httpErrorCount: 1 }],
  ] as const)('strict mode rejects a nonzero %s aggregate', (_label, counters) => {
    expect(() => assertE2EBrowserHealthGate(browserHealth(counters), true)).toThrow(
      'E2E_BROWSER_HEALTH_GATE_FAILED',
    );
  });

  test('report-only mode preserves local flows with captured browser issues', () => {
    expect(() => assertE2EBrowserHealthGate(browserHealth({
      issueCount: 1,
      warningCount: 1,
    }), false)).not.toThrow();
  });

  test('strict mode accepts narrowly tagged expected negative-path evidence', () => {
    const issue: QaBrowserIssue = {
      type: 'console',
      severity: 'warning',
      message: '[expected] [ERROR][runtime] input.quarantined RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET',
      url: 'http://localhost:8080/app',
      method: null,
      status: null,
      testId: 'chromium :: expected negative path',
      timestamp: 1,
    };
    const health = summarizeQaBrowserIssues([issue]);
    expect(health).toMatchObject(browserHealth());
    expect(() => assertE2EBrowserHealthGate(health, true)).not.toThrow();
  });

  test('every isolated E2E command opts into strict browser health', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const bypasses = Object.entries(packageJson.scripts)
      .filter(([, command]) => command.includes('run-e2e-parallel-isolated.ts'))
      .filter(([, command]) => !command.includes('--strict-browser-health'))
      .map(([name]) => name);
    expect(bypasses).toEqual([]);
  });

  test('failed browser tests attach the full tagged runtime snapshot before quiesce', () => {
    const fixture = readFileSync(resolve(process.cwd(), 'tests/global-setup.mts'), 'utf8');
    const capture = fixture.indexOf('captureFailedRuntimeSnapshots(');
    const quiesce = fixture.indexOf('quiesceRuntimePages(pages)');

    expect(capture).toBeGreaterThan(0);
    expect(quiesce).toBeGreaterThan(capture);
    expect(fixture).toContain("root['liveRuntimeSnapshot']");
    expect(fixture).toContain('wire.stringifyJson(runtimeSnapshot)');
    expect(fixture).toContain('browser-runtime-${index + 1}.json');
    expect(fixture).toContain('testInfo.outputPath(artifactName)');
    expect(fixture).toContain("await writeFile(artifactPath, snapshot, 'utf8')");
    expect(fixture).toContain('path: artifactPath');
    expect(fixture).toContain('Promise.allSettled(');
    expect(fixture).toContain('E2E_FAILURE_HOOK_ERRORS');
  });

  test('every root Playwright spec uses the mandatory global fixture', () => {
    const testsDir = resolve(process.cwd(), 'tests');
    const bypasses = readdirSync(testsDir)
      .filter(file => file.endsWith('.spec.ts'))
      .filter(file => !readFileSync(resolve(testsDir, file), 'utf8')
        .includes("from './global-setup.mts'"));
    expect(bypasses).toEqual([]);
  });

  test('the global fixture fails per test on browser errors and new open incidents', () => {
    const fixture = readFileSync(resolve(process.cwd(), 'tests/global-setup.mts'), 'utf8');
    expect(fixture).toContain('unexpectedBrowserErrors(');
    expect(fixture).toContain('unexpectedOpenIncidents(');
    expect(fixture).toContain('incidentCursorByTestId');
    expect(fixture).toContain('E2E_GLOBAL_ERROR_GUARD_FAILED');
  });
});
