import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
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

test('incremental fatal scanner fails closed if an observed log disappears', () => {
  withLog(path => {
    const scanner = createIncrementalRuntimeFatalLogScanner(path);
    expect(scanner.scan()).toBeNull();
    unlinkSync(path);
    expect(() => scanner.scan()).toThrow('E2E_FATAL_LOG_SCAN_FAILED');
  });
});

test('cross-j pair-drop warnings remain observable without killing the E2E stack', () => {
  withLog(path => {
    const scanner = createIncrementalRuntimeFatalLogScanner(path);
    appendFileSync(path, '[network] INBOUND_CROSS_J_ACCOUNT_PAIR_DROPPED received=1 retained=0\n');
    expect(scanner.scan()).toBeNull();

    appendFileSync(path, '[ERROR][runtime] apply_input.failed CROSS_J_ROUTE_HASH_MISMATCH\n');
    expect(scanner.scan()).toMatchObject({
      pattern: '/\\[ERROR\\].*CROSS_J_[A-Z0-9_:-]*/',
      lineNumber: 2,
    });
  });
});

test('recoverable child exits remain observable without aborting the E2E stack', () => {
  withLog(path => {
    const scanner = createIncrementalRuntimeFatalLogScanner(path);
    appendFileSync(
      path,
      '[ERROR][mesh.orchestrator] child.unexpected_exit '
      + '{"child":"H2","action":"recover","reasonCode":"SIGKILL"}\n',
    );
    expect(scanner.scan()).toBeNull();

    appendFileSync(
      path,
      '[ERROR][mesh.orchestrator] child.unexpected_exit '
      + '{"child":"H2","action":"fail-stop","reasonCode":"RUNTIME_LOOP_HALTED"}\n',
    );
    expect(scanner.scan()).toMatchObject({
      pattern: '/child\\.unexpected_exit/',
      lineNumber: 2,
    });
  });
});

test('malformed or unclassified child exits fail closed', () => {
  withLog(path => {
    const scanner = createIncrementalRuntimeFatalLogScanner(path);
    appendFileSync(
      path,
      '[ERROR][mesh.orchestrator] child.unexpected_exit {"child":"H2","action":"recover"\n',
    );
    expect(scanner.scan()).toMatchObject({
      pattern: '/child\\.unexpected_exit/',
      lineNumber: 1,
    });
  });

  withLog(path => {
    const scanner = createIncrementalRuntimeFatalLogScanner(path);
    appendFileSync(path, '[ERROR][mesh.orchestrator] child.unexpected_exit {"message":"fatal"}\n');
    expect(scanner.scan()).toMatchObject({
      pattern: '/child\\.unexpected_exit/',
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
