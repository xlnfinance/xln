import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildPersistenceIssues,
  inspectRecoveryBundleFile,
  repairPlanFor,
  type PersistenceBundleSummary,
  type PersistenceTowerSummary,
  type PersistenceWalTailSummary,
} from '../persistence-inspect';

const walTail = (missingHeights: number[] = []): PersistenceWalTailSummary => ({
  fromHeight: 1,
  toHeight: 3,
  presentCount: 3 - missingHeights.length,
  missingHeights,
  lastFrameLogCount: 0,
});

const bundle = (overrides: Partial<PersistenceBundleSummary> = {}): PersistenceBundleSummary => ({
  checked: true,
  valid: true,
  encrypted: false,
  runtimeId: '0xruntime',
  height: 3,
  checkpointHash: '0xcheckpoint',
  ...overrides,
});

const tower = (overrides: Partial<PersistenceTowerSummary> = {}): PersistenceTowerSummary => ({
  checked: true,
  ok: true,
  url: 'http://127.0.0.1:9100',
  lookupKey: 'lookup',
  receipt: {
    type: 'tower_receipt',
    version: 1,
    towerId: 'tower',
    lookupKey: 'lookup',
    runtimeId: '0xruntime',
    height: 3,
    bundleHash: '0xbundle',
    receivedAt: 1,
    sequence: 1,
    retainedSlots: 1,
  },
  ...overrides,
});

describe('persistence inspection issue model', () => {
  test('empty persistence is critical and never silently self-repairs', () => {
    const issues = buildPersistenceIssues({
      latestHeight: 0,
      checkpointHeights: [],
      walTail: walTail(),
      bundle: { checked: false, valid: false, encrypted: false },
      tower: { checked: false, ok: false },
    });

    expect(issues.map((issue) => issue.code)).toContain('PERSISTENCE_EMPTY');
    expect(issues.find((issue) => issue.code === 'PERSISTENCE_EMPTY')?.severity).toBe('critical');
    expect(repairPlanFor(issues).join('\n')).toContain('Restore from a recovery bundle');
  });

  test('missing WAL tail frame is critical corruption evidence', () => {
    const issues = buildPersistenceIssues({
      latestHeight: 3,
      checkpointHeights: [2],
      walTail: walTail([2]),
      bundle: bundle(),
      tower: tower(),
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'WAL_TAIL_MISSING', severity: 'critical' }),
    ]));
    expect(repairPlanFor(issues).join('\n')).toContain('Do not advance or rewrite local WAL');
  });

  test('stale bundle and stale tower are warnings with explicit operator actions', () => {
    const issues = buildPersistenceIssues({
      latestHeight: 12,
      checkpointHeights: [10],
      walTail: walTail(),
      bundle: bundle({ height: 7 }),
      tower: tower({
        receipt: {
          ...(tower().receipt!),
          height: 9,
        },
      }),
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BUNDLE_STALE', severity: 'warning' }),
      expect.objectContaining({ code: 'TOWER_STALE', severity: 'warning' }),
    ]));
    const plan = repairPlanFor(issues).join('\n');
    expect(plan).toContain('Create and upload a fresh recovery bundle');
    expect(plan).toContain('confirm a fresh tower receipt');
  });

  test('encrypted bundle metadata is inspectable without decrypting payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xln-persistence-inspect-'));
    try {
      const path = join(dir, 'bundle.json');
      writeFileSync(path, JSON.stringify({
        version: 1,
        runtimeId: '0xABCDEF',
        lookupKey: 'lookup',
        height: 41,
        bundleHash: '0xbundle',
        iv: '00',
        ciphertext: '01',
      }));

      expect(inspectRecoveryBundleFile(path)).toEqual(expect.objectContaining({
        checked: true,
        valid: true,
        encrypted: true,
        runtimeId: '0xabcdef',
        height: 41,
        bundleHash: '0xbundle',
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
