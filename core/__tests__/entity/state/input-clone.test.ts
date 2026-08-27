import { describe, expect, test } from 'bun:test';

import { cloneIsolatedEntityInput } from '../../../entity/state/input-clone';
import type { RoutedEntityInput } from '../../../runtime/types';

describe('isolated Entity input clone', () => {
  test('copies scalar routing records without retaining mutable containers', () => {
    const input: RoutedEntityInput = {
      entityId: `0x${'11'.repeat(32)}`,
      signerId: `0x${'22'.repeat(20)}`,
      runtimeId: `0x${'33'.repeat(20)}`,
      from: `0x${'44'.repeat(20)}`,
      sourceRuntimeFrame: { height: 7, timestamp: 8 },
      atomicCrossJurisdictionPair: { phase: 'proposal', pairKey: 'pair' },
      entityTxs: [],
    };

    const cloned = cloneIsolatedEntityInput(input);

    expect(cloned).toEqual(input);
    expect(cloned).not.toBe(input);
    expect(cloned.sourceRuntimeFrame).not.toBe(input.sourceRuntimeFrame);
    expect(cloned.atomicCrossJurisdictionPair).not.toBe(input.atomicCrossJurisdictionPair);
    expect(cloned.entityTxs).not.toBe(input.entityTxs);
  });
});
