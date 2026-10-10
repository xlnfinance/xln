import { describe, expect, test } from 'bun:test';

import { readBooleanEnv, readNonNegativeIntegerEnv, readPositiveIntegerEnv } from '../../../config/environment';

describe('environment configuration boundary', () => {
  test('uses the documented default only when the variable is absent', () => {
    expect(readPositiveIntegerEnv('LIMIT', 12, {})).toBe(12);
    expect(readPositiveIntegerEnv('LIMIT', 12, { LIMIT: '34' })).toBe(34);
  });

  test.each(['', '0', '-1', '1.5', '12ms', ' 12'])(
    'rejects a present invalid positive integer: %s',
    (raw) => {
      expect(() => readPositiveIntegerEnv('LIMIT', 12, { LIMIT: raw })).toThrow(
        `ENV_POSITIVE_INTEGER_INVALID:LIMIT:${raw}`,
      );
    },
  );

  test('rejects unsafe integer values', () => {
    const raw = String(Number.MAX_SAFE_INTEGER + 1);
    expect(() => readPositiveIntegerEnv('LIMIT', 12, { LIMIT: raw })).toThrow(
      `ENV_POSITIVE_INTEGER_UNSAFE:LIMIT:${raw}`,
    );
  });

  test('a non-negative limit accepts 0 and rejects every other malformed value', () => {
    expect(readNonNegativeIntegerEnv('LIMIT', 2, {})).toBe(2);
    expect(readNonNegativeIntegerEnv('LIMIT', 2, { LIMIT: '0' })).toBe(0);
    expect(readNonNegativeIntegerEnv('LIMIT', 2, { LIMIT: '7' })).toBe(7);
    for (const raw of ['', '-1', '1.5', 'NaN', '07', ' 1']) {
      expect(() => readNonNegativeIntegerEnv('LIMIT', 2, { LIMIT: raw })).toThrow(
        `ENV_NON_NEGATIVE_INTEGER_INVALID:LIMIT:${raw}`,
      );
    }
  });

  test('decodes explicit booleans and defaults only when absent', () => {
    expect(readBooleanEnv('FLAG', true, {})).toBe(true);
    expect(readBooleanEnv('FLAG', false, { FLAG: 'yes' })).toBe(true);
    expect(readBooleanEnv('FLAG', false, { FLAG: ' true ' })).toBe(true);
    expect(readBooleanEnv('FLAG', true, { FLAG: 'OFF' })).toBe(false);
  });

  test.each(['', 'truthy', '2'])(
    'rejects a present invalid boolean: %s',
    (raw) => {
      expect(() => readBooleanEnv('FLAG', false, { FLAG: raw })).toThrow(
        `ENV_BOOLEAN_INVALID:FLAG:${raw}`,
      );
    },
  );
});
