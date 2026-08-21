import { describe, expect, test } from 'bun:test';

import { GENERATED_INPUTS } from '../../../frontend/config/generated-inputs';
import { SURFACE_IDS } from '../../../frontend/config/surfaces';

describe('frontend generated input ownership', () => {
  test('uses one owner and output namespace per generated input family', () => {
    const ids = GENERATED_INPUTS.map(({ id }) => id);
    const outputNamespaces = GENERATED_INPUTS.map(({ outputNamespace }) => outputNamespace);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(outputNamespaces).size).toBe(outputNamespaces.length);
  });

  test('assigns at least one input family to every application', () => {
    for (const surfaceId of SURFACE_IDS) {
      expect(GENERATED_INPUTS.some(({ owner }) => owner === surfaceId)).toBe(true);
    }
  });

  test('records concrete source paths for every producer', () => {
    for (const input of GENERATED_INPUTS) {
      expect(input.sourcePaths.length).toBeGreaterThan(0);
      expect(input.sourcePaths.every((sourcePath) => sourcePath.length > 0)).toBe(true);
    }
  });
});
