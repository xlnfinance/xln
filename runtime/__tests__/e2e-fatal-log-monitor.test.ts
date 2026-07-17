import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIncrementalRuntimeFatalLogScanner } from '../scripts/e2e-fatal-log-monitor';

const withLog = (run: (path: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'xln-incremental-fatal-log-'));
  const path = join(dir, 'e2e-shard-00.log');
  try {
    writeFileSync(path, '');
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('incremental fatal scanner carries a marker split across writes', () => {
  withLog(path => {
    const scanner = createIncrementalRuntimeFatalLogScanner(path);
    appendFileSync(path, '[RUNTIME] RUNTIME_LOOP_');
    expect(scanner.scan()).toBeNull();

    appendFileSync(path, 'HALTED: committed state failed');
    expect(scanner.scan()).toEqual({
      pattern: '/RUNTIME_LOOP_HALTED/',
      lineNumber: 1,
      line: '[RUNTIME] RUNTIME_LOOP_HALTED: committed state failed',
    });
  });
});

test('incremental fatal scanner preserves line numbers across complete and partial appends', () => {
  withLog(path => {
    const scanner = createIncrementalRuntimeFatalLogScanner(path);
    appendFileSync(path, 'ready\nresolved PENDING-FRAME-STALE');
    expect(scanner.scan()).toBeNull();

    appendFileSync(path, '\nstill healthy\n');
    expect(scanner.scan()).toBeNull();

    appendFileSync(path, '[ERROR][runtime] loop.error fatal\n');
    expect(scanner.scan()).toMatchObject({
      pattern: '/\\[ERROR\\]\\[runtime\\] loop\\.error/',
      lineNumber: 4,
    });
  });
});

test('incremental fatal scanner restarts from byte zero after log truncation', () => {
  withLog(path => {
    const scanner = createIncrementalRuntimeFatalLogScanner(path);
    appendFileSync(path, 'healthy line one\nhealthy line two\n');
    expect(scanner.scan()).toBeNull();

    truncateSync(path, 0);
    appendFileSync(path, 'RUNTIME_LOOP_ERROR after restart\n');
    expect(scanner.scan()).toMatchObject({
      pattern: '/RUNTIME_LOOP_ERROR/',
      lineNumber: 1,
    });
  });
});

test('isolated E2E runner polls through the incremental scanner', () => {
  const runner = readFileSync(
    join(process.cwd(), 'runtime/scripts/run-e2e-parallel-isolated.ts'),
    'utf8',
  );
  expect(runner).toContain('const fatalScanner = createIncrementalRuntimeFatalLogScanner(logPath);');
  expect(runner).toContain('const hit = fatalScanner.scan();');
  expect(runner).not.toContain("scannedLines = readFileSync(logPath, 'utf8')");
});
