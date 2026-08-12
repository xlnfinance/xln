import { describe, expect, test } from 'bun:test';

import {
  collectUnusedSurface,
  evaluateUnusedSurface,
} from '../../runtime/scripts/checks/repository/check-unused-surface';

describe('unused surface ratchet', () => {
  test('normalizes every Knip public-surface issue deterministically', () => {
    expect(collectUnusedSurface({ issues: [{
      file: 'b.ts',
      exports: [{ name: 'value' }],
      types: [{ name: 'Shape' }],
      cycles: ['a.ts'],
    }] })).toEqual([
      'b.ts::cycle:a.ts',
      'b.ts::export:value',
      'b.ts::type:Shape',
    ]);
  });

  test('rejects growth and forces debt removal after cleanup', () => {
    const debt = new Set(['a.ts::export:old']);
    expect(evaluateUnusedSurface(['a.ts::export:old'], debt)).toEqual([]);
    expect(evaluateUnusedSurface(['a.ts::export:new'], debt)).toEqual([
      'NEW_UNUSED_SURFACE:a.ts::export:new',
      'STALE_UNUSED_SURFACE_DEBT:a.ts::export:old',
    ]);
    expect(evaluateUnusedSurface([], debt)).toEqual([
      'STALE_UNUSED_SURFACE_DEBT:a.ts::export:old',
    ]);
  });
});
