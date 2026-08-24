import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  RCPAN_COMPARISON_ROWS,
  RCPAN_SYSTEMS,
  RCPAN_UPGRADES,
} from '../../../frontend/apps/site/src/rcpan-content';

const REPOSITORY_ROOT = new URL('../../../', import.meta.url);

describe('React RCPAN pilot', () => {
  test('keeps the three account upgrades explicit', () => {
    expect(RCPAN_UPGRADES.map(([, title]) => title)).toEqual([
      'Portable proof',
      'Visible protection',
      'Executable dispute',
    ]);
  });

  test('compares every architecture across every claim', () => {
    expect(RCPAN_SYSTEMS.map(({ id }) => id)).toEqual([
      'xln',
      'channels',
      'rollups',
      'tradfi',
    ]);
    expect(RCPAN_COMPARISON_ROWS).toHaveLength(6);

    for (const row of RCPAN_COMPARISON_ROWS) {
      for (const { id } of RCPAN_SYSTEMS) {
        expect(row.cells[id].lead.length).toBeGreaterThan(0);
        expect(row.cells[id].detail.length).toBeGreaterThan(0);
      }
    }
  });

  test('consumes the canonical microscope model instead of reproducing account math', async () => {
    const page = await readFile(new URL('frontend/apps/site/src/rcpan-page.tsx', REPOSITORY_ROOT), 'utf8');
    expect(page).toContain("from '../../../src/lib/components/Rcpan/microscope/model/microscope-model'");
    expect(page).toContain('deriveRcpanMicroscopeFrame');
    expect(page).not.toContain('deriveDelta');
    expect(page).not.toContain('deriveDisputeTokenFinalization');
  });
});
