import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { safeStringify } from '../../../protocol/serialization';

import {
  assertBroadRunHasNoUnresolvedReruns,
  readSelectiveRerunLedger,
  recordSelectiveRerunFailure,
  recordSelectiveRerunPass,
  selectiveE2ETarget,
} from '../../../scripts/e2e/harness/selective-rerun/ledger';

const CODE_HASH = 'a'.repeat(64);

const withLedger = (run: (path: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-selective-rerun-'));
  try {
    run(join(directory, 'ledger.json'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe('selective rerun ledger', () => {
  test('blocks broad work until the exact failing target passes', () => withLedger(path => {
    const target = selectiveE2ETarget('tests/e2e/example.spec.ts', 'fails exactly once');
    recordSelectiveRerunFailure({
      kind: 'e2e',
      target,
      failedCodeHash: CODE_HASH,
      failedAt: '2026-08-14T00:00:00.000Z',
      reason: 'playwright:expected failure',
    }, path);

    expect(() => assertBroadRunHasNoUnresolvedReruns(path)).toThrow(
      'BROAD_RUN_BLOCKED_EXACT_RERUN_REQUIRED',
    );
    recordSelectiveRerunPass('scenario', target, path);
    expect(() => assertBroadRunHasNoUnresolvedReruns(path)).toThrow();
    recordSelectiveRerunPass('e2e', target, path);
    expect(() => assertBroadRunHasNoUnresolvedReruns(path)).not.toThrow();
  }));

  test('broad scenario runs ignore demoted catalog failures and E2E-only evidence', () => withLedger(path => {
    recordSelectiveRerunFailure({
      kind: 'scenario',
      target: 'company-ipo',
      failedCodeHash: CODE_HASH,
      failedAt: '2026-08-14T00:00:00.000Z',
      reason: 'BOARD_HANDOVER_ACTIVATION_CHAIN_INVALID',
    }, path);
    recordSelectiveRerunFailure({
      kind: 'e2e',
      target: selectiveE2ETarget('tests/e2e/example.spec.ts', 'other'),
      failedCodeHash: CODE_HASH,
      failedAt: '2026-08-14T00:00:00.000Z',
      reason: 'playwright:unrelated',
    }, path);

    expect(() => assertBroadRunHasNoUnresolvedReruns(path, {
      kind: 'scenario',
      targets: ['processbatch', 'swap-tps'],
    })).not.toThrow();
    expect(() => assertBroadRunHasNoUnresolvedReruns(path, { kind: 'e2e' })).toThrow(
      'BROAD_RUN_BLOCKED_EXACT_RERUN_REQUIRED',
    );
    expect(() => assertBroadRunHasNoUnresolvedReruns(path, {
      kind: 'scenario',
      targets: ['company-ipo'],
    })).toThrow('BROAD_RUN_BLOCKED_EXACT_RERUN_REQUIRED');
  }));

  test('replaces one target failure without dropping other unresolved rows', () => withLedger(path => {
    const first = selectiveE2ETarget('tests/e2e/a.spec.ts', 'A');
    const second = selectiveE2ETarget('tests/e2e/b.spec.ts', 'B');
    for (const [target, reason] of [[first, 'first'], [second, 'second'], [first, 'newest']] as const) {
      recordSelectiveRerunFailure({
        kind: 'e2e',
        target,
        failedCodeHash: CODE_HASH,
        failedAt: '2026-08-14T00:00:00.000Z',
        reason,
      }, path);
    }
    const ledger = readSelectiveRerunLedger(path);
    expect(ledger.unresolved).toHaveLength(2);
    expect(ledger.unresolved.find(entry => entry.target === first)?.reason).toBe('newest');
  }));

  test('rejects malformed or duplicate disk rows instead of laundering QA evidence', () => withLedger(path => {
    const entry = {
      kind: 'scenario',
      target: 'company-ipo',
      failedCodeHash: CODE_HASH,
      failedAt: '2026-08-14T00:00:00.000Z',
      reason: 'failed',
    };
    writeFileSync(path, safeStringify({ version: 1, unresolved: [entry, entry] }));
    expect(() => readSelectiveRerunLedger(path)).toThrow('SELECTIVE_RERUN_LEDGER_INVALID');

    writeFileSync(path, safeStringify({ version: 1, unresolved: [{ ...entry, extra: true }] }));
    expect(() => readSelectiveRerunLedger(path)).toThrow('SELECTIVE_RERUN_LEDGER_INVALID');
  }));

  test('recovers a lock left by a terminated process', () => withLedger(path => {
    writeFileSync(`${path}.lock`, '2147483647\n');
    recordSelectiveRerunFailure({
      kind: 'scenario',
      target: 'company-ipo',
      failedCodeHash: CODE_HASH,
      failedAt: '2026-08-14T00:00:00.000Z',
      reason: '',
    }, path);
    expect(readSelectiveRerunLedger(path).unresolved[0]?.reason).toBe('unknown-failure');
  }));

  test('records a bounded one-line reason without masking the original failure', () => withLedger(path => {
    recordSelectiveRerunFailure({
      kind: 'scenario',
      target: 'company-ipo',
      failedCodeHash: CODE_HASH,
      failedAt: '2026-08-14T00:00:00.000Z',
      reason: `primary failure\n${'stack '.repeat(120)}`,
    }, path);
    const reason = readSelectiveRerunLedger(path).unresolved[0]?.reason;
    expect(reason?.startsWith('primary failure stack')).toBe(true);
    expect(reason).not.toContain('\n');
    expect(reason?.length).toBe(500);
  }));

  test('scenario help is side-effect free and cannot erase E2E evidence', () => {
    const evidenceDirectory = resolve(process.cwd(), '.logs', 'e2e-parallel');
    const sentinel = join(evidenceDirectory, `help-sentinel-${String(process.pid)}`);
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(sentinel, 'preserve');
    try {
      const result = spawnSync('bun', ['core/scenarios/run.ts', '--help'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status).toBe(0);
      expect(String(result.stdout)).toContain('Usage: bun core/scenarios/run.ts');
      expect(readFileSync(sentinel, 'utf8')).toBe('preserve');
    } finally {
      rmSync(sentinel, { force: true });
    }
  });
});
