import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildIsolatedE2ERerunCommand,
  parseJsonLinesStrict,
  readPlaywrightFailureReport,
} from '../scripts/e2e-failure-capsule';
import {
  captureE2EHttpForensics,
  createE2ECodeDriftGuard,
  deriveE2EShardPaths,
  readShardBrowserIssues,
  readShardLastRunStatus,
} from '../scripts/run-e2e-parallel-isolated';

const temporaryRoots: string[] = [];
const temporaryRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('isolated E2E first-failure diagnostics', () => {
  test('extracts exact Playwright failure metadata and builds a shell-safe rerun', () => {
    const repositoryRoot = process.cwd();
    const reportPath = join(temporaryRoot('xln-pw-report-'), 'playwright-report.json');
    writeFileSync(reportPath, JSON.stringify({
      config: { rootDir: join(repositoryRoot, 'tests') },
      suites: [{
        title: 'e2e-wallet.spec.ts',
        file: 'e2e-wallet.spec.ts',
        specs: [{
          title: "user's wallet pays $5",
          ok: false,
          file: 'e2e-wallet.spec.ts',
          line: 42,
          column: 7,
          tests: [{
            projectName: 'chromium',
            status: 'unexpected',
            results: [{
              status: 'failed',
              startTime: '2026-07-17T12:00:00.000Z',
              errors: [{ message: '\u001b[31mExpected payment receipt\u001b[39m' }],
              error: {
                message: 'Expected payment receipt',
                stack: '\u001b[31mError: Expected payment receipt\u001b[39m\n    at test.ts:42:7',
              },
              attachments: [{ name: 'screenshot', contentType: 'image/png', path: '/tmp/failure.png' }],
            }],
          }],
        }],
      }],
      errors: [],
    }));

    const failure = readPlaywrightFailureReport(reportPath);
    expect(failure).toMatchObject({
      file: 'tests/e2e-wallet.spec.ts',
      title: "user's wallet pays $5",
      line: 42,
      column: 7,
      project: 'chromium',
      error: 'Expected payment receipt',
      stack: 'Error: Expected payment receipt\n    at test.ts:42:7',
      attachments: [{ name: 'screenshot', contentType: 'image/png', path: '/tmp/failure.png' }],
    });
    expect(buildIsolatedE2ERerunCommand(failure!, {
      videoMode: 'retain-on-failure',
      traceMode: 'on-first-retry',
      screenshotMode: 'only-on-failure',
      prewaitHealth: 'reset',
      strictBrowserHealth: true,
    })).toBe(
      "bun runtime/scripts/run-e2e-parallel-isolated.ts --shards=1 --workers-per-shard=1 --max-failures=1 '--pw-files=tests/e2e-wallet.spec.ts::user'\"'\"'s wallet pays $5' --pw-project=chromium --video=retain-on-failure --trace=on-first-retry --screenshot=only-on-failure --prewait-health=reset --strict-browser-health --preserve-artifacts",
    );
  });

  test('reports the exact path and line for malformed report and browser evidence', () => {
    const root = temporaryRoot('xln-e2e-malformed-');
    const reportPath = join(root, 'playwright-report.json');
    writeFileSync(reportPath, '{\n  "suites": [\n    nope\n  ]\n}');
    expect(() => readPlaywrightFailureReport(reportPath)).toThrow(
      `E2E_JSON_INVALID:path=${reportPath}:line=3:column=5`,
    );

    const eventsPath = deriveE2EShardPaths(root, 2).browserEventsPath;
    mkdirSync(join(root, 'shard-2', 'logs'), { recursive: true });
    writeFileSync(eventsPath, '{"type":"console","severity":"error","message":"boom"}\nnope\n', {
      flag: 'w',
    });
    expect(() => parseJsonLinesStrict(readFileSync(eventsPath, 'utf8'), eventsPath)).toThrow(
      `E2E_JSON_INVALID:path=${eventsPath}:line=2:column=1`,
    );
    expect(() => readShardBrowserIssues(root, 2)).toThrow(
      `E2E_JSON_INVALID:path=${eventsPath}:line=2:column=1`,
    );

    const statusPath = join(deriveE2EShardPaths(root, 2).resultsDir, '.last-run.json');
    mkdirSync(join(root, 'shard-2', 'artifacts', 'playwright'), { recursive: true });
    writeFileSync(statusPath, '{"status":"mystery"}');
    expect(() => readShardLastRunStatus(root, 2)).toThrow(
      `E2E_LAST_RUN_STATUS_INVALID:path=${statusPath}:status=mystery`,
    );
  });

  test('captures HTTP forensics in parallel and writes every endpoint failure explicitly', async () => {
    const outputDir = temporaryRoot('xln-e2e-forensics-');
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/api/health') return Response.json({ ok: true });
        if (path === '/api/debug/incidents') return Response.json({ ok: true, incidents: [] });
        if (path === '/api/debug/entities') return new Response('{"entities":', { status: 200 });
        if (path === '/api/debug/events') return new Response('unavailable', { status: 503 });
        await Bun.sleep(250);
        return Response.json({ events: [] });
      },
    });
    try {
      const startedAt = performance.now();
      await expect(captureE2EHttpForensics({
        apiUrl: `http://127.0.0.1:${server.port}`,
        outputDir,
        timeoutMs: 40,
      })).rejects.toThrow('E2E_FAILURE_FORENSICS_INCOMPLETE');
      expect(performance.now() - startedAt).toBeLessThan(150);
      expect(JSON.parse(readFileSync(join(outputDir, 'health.json'), 'utf8'))).toEqual({ ok: true });
      expect(JSON.parse(readFileSync(join(outputDir, 'incidents.json'), 'utf8'))).toEqual({
        ok: true,
        incidents: [],
      });
      expect(readFileSync(join(outputDir, 'entities.error.txt'), 'utf8')).toContain('E2E_JSON_INVALID');
      expect(readFileSync(join(outputDir, 'events.error.txt'), 'utf8')).toContain('HTTP_503');
      expect(readFileSync(join(outputDir, 'activity.error.txt'), 'utf8')).toContain('Timeout');
      expect(existsSync(join(outputDir, 'receipts-unknown.error.txt'))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test('debounces fingerprint reads but latches and reports drift at shard completion', () => {
    let now = 0;
    let currentHash = 'a'.repeat(64);
    let reads = 0;
    const guard = createE2ECodeDriftGuard({
      expectedCodeHash: currentHash,
      minIntervalMs: 1_000,
      now: () => now,
      computeCodeHash: () => {
        reads += 1;
        return currentHash;
      },
    });

    guard.assertStable();
    currentHash = 'b'.repeat(64);
    now = 500;
    guard.assertStable();
    expect(reads).toBe(1);
    now = 1_001;
    expect(() => guard.assertStable()).toThrow(
      `E2E_CODE_DRIFT:start=${'a'.repeat(64)}:end=${'b'.repeat(64)}`,
    );
    expect(() => guard.assertStable()).toThrow('E2E_CODE_DRIFT:');
    expect(reads).toBe(2);
  });
});
