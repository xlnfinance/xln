import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { safeStringify } from '../../../protocol/serialization';

import {
  assertBroadRunHasNoUnresolvedReruns,
  assertBroadE2ERunHasNoUnresolvedReruns,
  assertE2ESelectionMayStart,
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
  test('admits an exact concurrent failure cohort without clearing failures or admitting broad work', () =>
    withLedger(path => {
      const file = 'tests/e2e-cross-j-swap.spec.ts';
      const targets = ['first', 'second', 'third', 'fourth'].map(title => selectiveE2ETarget(file, title));
      for (const target of targets)
        recordSelectiveRerunFailure(
          {
            kind: 'e2e',
            target,
            failedCodeHash: CODE_HASH,
            failedAt: '2026-10-20T00:00:00.000Z',
            reason: 'startup:hub-config',
          },
          path,
        );
      const before = readFileSync(path, 'utf8');
      expect(() => assertE2ESelectionMayStart(targets, path)).not.toThrow();
      expect(readFileSync(path, 'utf8')).toBe(before);
      for (const selection of [[], [file], [targets[0]!, file]]) {
        expect(() => assertE2ESelectionMayStart(selection, path)).toThrow('BROAD_RUN_BLOCKED_EXACT_RERUN_REQUIRED');
      }
      recordSelectiveRerunPass('e2e', targets[0]!, path);
      expect(readSelectiveRerunLedger(path).unresolved.map(row => row.target)).toEqual(targets.slice(1).sort());
      expect(() => assertE2ESelectionMayStart([], path)).toThrow('BROAD_RUN_BLOCKED_EXACT_RERUN_REQUIRED');
    }));

  test('blocks broad work until the exact failing target passes', () =>
    withLedger(path => {
      const target = selectiveE2ETarget('tests/e2e/example.spec.ts', 'fails exactly once');
      recordSelectiveRerunFailure(
        {
          kind: 'e2e',
          target,
          failedCodeHash: CODE_HASH,
          failedAt: '2026-08-14T00:00:00.000Z',
          reason: 'playwright:expected failure',
        },
        path,
      );

      expect(() => assertBroadRunHasNoUnresolvedReruns(path)).toThrow('BROAD_RUN_BLOCKED_EXACT_RERUN_REQUIRED');
      recordSelectiveRerunPass('scenario', target, path);
      expect(() => assertBroadRunHasNoUnresolvedReruns(path)).toThrow();
      recordSelectiveRerunPass('e2e', target, path);
      expect(() => assertBroadRunHasNoUnresolvedReruns(path)).not.toThrow();
    }));

  test('broad scenario runs ignore demoted catalog failures and E2E-only evidence', () =>
    withLedger(path => {
      recordSelectiveRerunFailure(
        {
          kind: 'scenario',
          target: 'company-ipo',
          failedCodeHash: CODE_HASH,
          failedAt: '2026-08-14T00:00:00.000Z',
          reason: 'BOARD_HANDOVER_ACTIVATION_CHAIN_INVALID',
        },
        path,
      );
      recordSelectiveRerunFailure(
        {
          kind: 'e2e',
          target: selectiveE2ETarget('tests/e2e/example.spec.ts', 'other'),
          failedCodeHash: CODE_HASH,
          failedAt: '2026-08-14T00:00:00.000Z',
          reason: 'playwright:unrelated',
        },
        path,
      );

      expect(() =>
        assertBroadRunHasNoUnresolvedReruns(path, {
          kind: 'scenario',
          targets: ['processbatch', 'swap-tps'],
        }),
      ).not.toThrow();
      expect(() => assertBroadRunHasNoUnresolvedReruns(path, { kind: 'e2e' })).toThrow(
        'BROAD_RUN_BLOCKED_EXACT_RERUN_REQUIRED',
      );
      expect(() =>
        assertBroadRunHasNoUnresolvedReruns(path, {
          kind: 'scenario',
          targets: ['company-ipo'],
        }),
      ).toThrow('BROAD_RUN_BLOCKED_EXACT_RERUN_REQUIRED');
    }));

  test('removed UI source remains failed history and blocks again if restored', () =>
    withLedger(path => {
      const sourceRoot = join(path, '..');
      const file = 'tests/e2e/retired.spec.ts';
      const target = selectiveE2ETarget(file, 'retired UI contract');
      recordSelectiveRerunFailure(
        {
          kind: 'e2e',
          target,
          failedCodeHash: CODE_HASH,
          failedAt: '2026-10-20T00:00:00.000Z',
          reason: 'missing retired UI',
        },
        path,
      );
      const before = readFileSync(path, 'utf8');
      expect(() => assertBroadE2ERunHasNoUnresolvedReruns(path, sourceRoot)).not.toThrow();
      expect(readFileSync(path, 'utf8')).toBe(before);
      mkdirSync(join(sourceRoot, 'tests/e2e'), { recursive: true });
      writeFileSync(join(sourceRoot, file), '// restored source with a renamed test');
      expect(() => assertBroadE2ERunHasNoUnresolvedReruns(path, sourceRoot)).toThrow(
        'BROAD_RUN_BLOCKED_EXACT_RERUN_REQUIRED',
      );
      expect(readFileSync(path, 'utf8')).toBe(before);
    }));

  test('existing failures in every browser package and malformed targets remain blocking', () => {
    for (const file of ['tests/e2e/present.spec.ts', 'ui/tests/present.spec.ts', 'frontend/tests/present.spec.ts']) {
      withLedger(path => {
        const sourceRoot = join(path, '..');
        mkdirSync(join(sourceRoot, file, '..'), { recursive: true });
        writeFileSync(join(sourceRoot, file), '// current source');
        recordSelectiveRerunFailure(
          {
            kind: 'e2e',
            target: selectiveE2ETarget(file, 'previous title'),
            failedCodeHash: CODE_HASH,
            failedAt: '2026-10-20T00:00:00.000Z',
            reason: 'failed in owning package',
          },
          path,
        );
        expect(() => assertBroadE2ERunHasNoUnresolvedReruns(path, sourceRoot)).toThrow(
          'BROAD_RUN_BLOCKED_EXACT_RERUN_REQUIRED',
        );
      });
    }
    for (const target of ['unknown-target', 'tests/../missing.spec.ts::untrusted path']) {
      withLedger(path => {
        recordSelectiveRerunFailure(
          {
            kind: 'e2e',
            target,
            failedCodeHash: CODE_HASH,
            failedAt: '2026-10-20T00:00:00.000Z',
            reason: 'unrecognized source',
          },
          path,
        );
        expect(() => assertBroadE2ERunHasNoUnresolvedReruns(path, join(path, '..'))).toThrow(
          'BROAD_RUN_BLOCKED_EXACT_RERUN_REQUIRED',
        );
      });
    }
  });

  test('replaces one target failure without dropping other unresolved rows', () =>
    withLedger(path => {
      const first = selectiveE2ETarget('tests/e2e/a.spec.ts', 'A');
      const second = selectiveE2ETarget('tests/e2e/b.spec.ts', 'B');
      for (const [target, reason] of [
        [first, 'first'],
        [second, 'second'],
        [first, 'newest'],
      ] as const) {
        recordSelectiveRerunFailure(
          {
            kind: 'e2e',
            target,
            failedCodeHash: CODE_HASH,
            failedAt: '2026-08-14T00:00:00.000Z',
            reason,
          },
          path,
        );
      }
      const ledger = readSelectiveRerunLedger(path);
      expect(ledger.unresolved).toHaveLength(2);
      expect(ledger.unresolved.find(entry => entry.target === first)?.reason).toBe('newest');
    }));

  test('rejects malformed or duplicate disk rows instead of laundering QA evidence', () =>
    withLedger(path => {
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

  test('recovers a lock left by a terminated process', () =>
    withLedger(path => {
      writeFileSync(`${path}.lock`, '2147483647\n');
      recordSelectiveRerunFailure(
        {
          kind: 'scenario',
          target: 'company-ipo',
          failedCodeHash: CODE_HASH,
          failedAt: '2026-08-14T00:00:00.000Z',
          reason: '',
        },
        path,
      );
      expect(readSelectiveRerunLedger(path).unresolved[0]?.reason).toBe('unknown-failure');
    }));

  test('records a bounded one-line reason without masking the original failure', () =>
    withLedger(path => {
      recordSelectiveRerunFailure(
        {
          kind: 'scenario',
          target: 'company-ipo',
          failedCodeHash: CODE_HASH,
          failedAt: '2026-08-14T00:00:00.000Z',
          reason: `primary failure\n${'stack '.repeat(120)}`,
        },
        path,
      );
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
