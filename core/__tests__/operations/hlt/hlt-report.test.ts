import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../protocol/boundary-validation';
import { safeParse } from '../../../protocol/serialization';
import { persistReport } from '../../../scripts/operations/hlt/worker-runtime';

test('production load report atomically restores tagged BigInt before exact decode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-production-load-report-'));
  const path = join(directory, 'report.json');
  try {
    persistReport(path, { bestBidPriceTicks: 25_000_000n }, value => {
      const report = requireBoundaryRecord(value, 'TEST_REPORT_INVALID');
      requireExactBoundaryKeys(report, ['bestBidPriceTicks'], [], 'TEST_REPORT_FIELDS_INVALID');
      expect(report['bestBidPriceTicks']).toBe(25_000_000n);
    });
    const persisted = requireBoundaryRecord(safeParse(readFileSync(path, 'utf8')), 'TEST_REPORT_READ_INVALID');
    expect(persisted['bestBidPriceTicks']).toBe(25_000_000n);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
