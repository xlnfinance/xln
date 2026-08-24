import { describe, expect, test } from 'bun:test';

import {
  COPY_GENERATED_INPUTS,
  GENERATED_INPUTS,
} from '../../../frontend/config/generated-inputs';
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

  test('keeps implemented copy producers aligned with their source inventory', () => {
    expect(COPY_GENERATED_INPUTS.map(({ id }) => id)).toEqual([
      'site-public-static',
      'ops-comparative-results',
    ]);
    for (const input of COPY_GENERATED_INPUTS) {
      expect(input.producer.entries.map(({ sourcePath }) => sourcePath)).toEqual(input.sourcePaths);
      const destinations = input.producer.entries.map(({ destinationPath }) => destinationPath);
      expect(new Set(destinations).size).toBe(destinations.length);
    }
  });
});
