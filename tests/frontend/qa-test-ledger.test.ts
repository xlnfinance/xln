import { describe, expect, test } from 'bun:test';

import type { QaTestLedgerEntry } from '../../frontend/src/lib/qa/types';
import {
  filterQaTestLedger,
  sortQaTestLedger,
  summarizeQaTestLedger,
  type QaTestLedgerSortKey,
} from '../../frontend/src/lib/qa/testLedger';

const rows: QaTestLedgerEntry[] = [
  {
    testId: 'tests/payment.spec.ts::opens wallet',
    category: 'functional',
    target: 'tests/payment.spec.ts',
    title: 'opens wallet',
    description: 'Creates and unlocks a wallet.',
    status: 'passed',
    durationMs: 1_200,
    lastRunId: 'run-2',
    lastRunAt: 2_000,
  },
  {
    testId: 'tests/recovery.spec.ts::restores after crash',
    category: 'resilience',
    target: 'tests/recovery.spec.ts',
    title: 'restores after crash',
    description: 'Kills and restores the runtime.',
    status: 'failed',
    durationMs: 3_400,
    lastRunId: 'run-3',
    lastRunAt: 3_000,
  },
  {
    testId: 'tests/account.spec.ts::opens account',
    category: 'functional',
    target: 'tests/account.spec.ts',
    title: 'opens account',
    description: 'Connects to a hub account.',
    status: 'unknown',
    durationMs: null,
    lastRunId: 'run-1',
    lastRunAt: 1_000,
  },
];

describe('QA concrete test ledger', () => {
  test('filters functional, resilience, and failed rows without merging intents', () => {
    expect(filterQaTestLedger(rows, 'all').map(row => row.testId)).toHaveLength(3);
    expect(filterQaTestLedger(rows, 'functional').map(row => row.testId)).toEqual([
      'tests/payment.spec.ts::opens wallet',
      'tests/account.spec.ts::opens account',
    ]);
    expect(filterQaTestLedger(rows, 'resilience').map(row => row.testId)).toEqual([
      'tests/recovery.spec.ts::restores after crash',
    ]);
    expect(filterQaTestLedger(rows, 'failed').map(row => row.testId)).toEqual([
      'tests/recovery.spec.ts::restores after crash',
    ]);
  });

  test('sorts every visible column in both directions', () => {
    const expectedByKey: Record<QaTestLedgerSortKey, { asc: string; desc: string }> = {
      category: {
        asc: 'tests/account.spec.ts::opens account',
        desc: 'tests/recovery.spec.ts::restores after crash',
      },
      test: {
        asc: 'tests/account.spec.ts::opens account',
        desc: 'tests/recovery.spec.ts::restores after crash',
      },
      description: {
        asc: 'tests/account.spec.ts::opens account',
        desc: 'tests/recovery.spec.ts::restores after crash',
      },
      status: {
        asc: 'tests/recovery.spec.ts::restores after crash',
        desc: 'tests/account.spec.ts::opens account',
      },
      duration: {
        asc: 'tests/payment.spec.ts::opens wallet',
        desc: 'tests/recovery.spec.ts::restores after crash',
      },
      'last-run': {
        asc: 'tests/account.spec.ts::opens account',
        desc: 'tests/recovery.spec.ts::restores after crash',
      },
    };

    for (const [key, expected] of Object.entries(expectedByKey) as Array<[QaTestLedgerSortKey, { asc: string; desc: string }]>) {
      const ascending = sortQaTestLedger(rows, key, 'asc');
      const descending = sortQaTestLedger(rows, key, 'desc');
      expect(ascending[0]?.testId, `${key} ascending`).toBe(expected.asc);
      expect(descending[0]?.testId, `${key} descending`).toBe(expected.desc);
      expect(new Set(ascending.map(row => row.testId))).toEqual(new Set(rows.map(row => row.testId)));
      expect(new Set(descending.map(row => row.testId))).toEqual(new Set(rows.map(row => row.testId)));
    }
  });

  test('summarizes category counts, failures, and measured time', () => {
    expect(summarizeQaTestLedger(rows)).toEqual({
      total: { count: 3, failed: 1, measured: 2, durationMs: 4_600 },
      functional: { count: 2, failed: 0, measured: 1, durationMs: 1_200 },
      resilience: { count: 1, failed: 1, measured: 1, durationMs: 3_400 },
      unknown: { count: 0, failed: 0, measured: 0, durationMs: 0 },
    });
  });
});
