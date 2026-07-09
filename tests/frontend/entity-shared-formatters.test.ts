import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  formatCurrency,
  formatTimestamp,
  formatTokenAmount,
} from '../../frontend/src/lib/view/components/entity/shared/formatters';

describe('entity shared formatters', () => {
  test('formatTokenAmount handles zero-decimal tokens exactly', () => {
    expect(formatTokenAmount(1, 123n, 0)).toBe('123');
    expect(formatTokenAmount(1, -123n, 0)).toBe('-123');
  });

  test('formatters fail loudly without raw console fallback', () => {
    const source = readFileSync('frontend/src/lib/view/components/entity/shared/formatters.ts', 'utf8');

    expect(source).not.toContain('console.error');
    expect(source).not.toContain('console.warn');
    expect(() => formatTokenAmount(1, 1n, -1)).toThrow('Invalid decimals');
    expect(() => formatCurrency(1, 'not-a-code')).toThrow();
    expect(formatTimestamp(Number.NaN)).toBe('Invalid Date');
  });
});
