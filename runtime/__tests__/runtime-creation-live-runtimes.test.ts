import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  estimatePasswordStrength,
  formatLiveRuntimeImportStatus,
} from '../../frontend/src/lib/components/Views/runtime-creation-model';

describe('runtime creation live runtime discovery', () => {
  test('formats runtime-import readiness as an explicit visible status', () => {
    expect(formatLiveRuntimeImportStatus({
      ready: false,
      partial: true,
      code: 'MARKET_MAKER_CHILD_INACTIVE',
      reason: 'degraded:marketMaker,custody',
      degraded: ['marketMaker', 'custody'],
    }, 3)).toBe(
      'Runtime network still converging; showing 3 import targets. code=MARKET_MAKER_CHILD_INACTIVE · reason=degraded:marketMaker,custody · degraded=marketMaker,custody',
    );

    expect(formatLiveRuntimeImportStatus({ ready: true }, 0)).toBe('');
  });

  test('keeps password strength estimation exported for RuntimeCreation', () => {
    expect(estimatePasswordStrength('').rating).toBe('weak');
    expect(estimatePasswordStrength('correct horse battery staple').bits).toBeGreaterThan(100);
  });

  test('RuntimeCreation does not mask reachable runtime-import failures as an empty list', () => {
    const source = readFileSync(
      join(process.cwd(), 'frontend/src/lib/components/Views/RuntimeCreation.svelte'),
      'utf8',
    );

    expect(source).toContain('formatLiveRuntimeImportStatus(payload, next.length)');
    expect(source).toContain('liveRuntimesLoaded && !liveRuntimesError');
    expect(source).toContain('Auto-discovery suppresses transport failures only');
    expect(source).not.toContain('swallows errors');
    expect(source).not.toContain('next.length === 0 && payload.ready === false');
  });
});
