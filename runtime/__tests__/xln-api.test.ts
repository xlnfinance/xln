import { describe, expect, test } from 'bun:test';
import * as runtime from '../runtime';
import { isXLNModuleLoaded } from '../xln-api-guard';

describe('browser runtime API boundary', () => {
  test('accepts the actual runtime module', () => {
    expect(isXLNModuleLoaded(runtime)).toBe(true);
  });

  test('rejects a runtime module with a missing bootstrap function', () => {
    expect(isXLNModuleLoaded({
      ...runtime,
      enqueueRuntimeInput: undefined,
    })).toBe(false);
  });
});
