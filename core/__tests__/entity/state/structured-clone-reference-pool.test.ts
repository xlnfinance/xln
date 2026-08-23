import { expect, test } from 'bun:test';

/**
 * Bun 1.3.x corrupted repeated object references within a single
 * structuredClone call (PRs oven-sh/bun#32791, #32796). The workaround in
 * cloneIsolatedEntityInput was to clone each field separately. Bun 1.4.0
 * fixes the reference pool sync; these tests guard against regression.
 */

test('structuredClone preserves repeated object references', () => {
  const shared = { validators: ['1', '2', '3', '4'] };
  const input = {
    boardA: { config: shared, isProposer: true },
    boardB: { config: shared, isProposer: false },
    boardC: { config: shared, isProposer: true },
  };

  const cloned = structuredClone(input);

  expect(cloned.boardA.config).toEqual(shared);
  expect(cloned.boardB.config).toEqual(shared);
  expect(cloned.boardC.config).toEqual(shared);
  // Identity must be preserved within the clone.
  expect(cloned.boardA.config).toBe(cloned.boardB.config);
  expect(cloned.boardB.config).toBe(cloned.boardC.config);
});

test('structuredClone preserves repeated references after BigInt boundary', () => {
  // The original bug: BigInt objects deserialized the reference pool
  // incorrectly, corrupting subsequent back-references.
  const shared = { jurisdiction: { chainId: 31_337, name: 'test' } };
  const input = {
    amount: 1n,
    boardA: { config: shared },
    amount2: 2n,
    boardB: { config: shared },
    amount3: 3n,
    boardC: { config: shared },
  };

  const cloned = structuredClone(input);

  expect(cloned.boardA.config).toEqual(shared);
  expect(cloned.boardB.config).toEqual(shared);
  expect(cloned.boardC.config).toEqual(shared);
  expect(cloned.boardA.config).toBe(cloned.boardB.config);
  expect(cloned.boardB.config).toBe(cloned.boardC.config);
});

test('structuredClone preserves repeated Map references', () => {
  const sharedMap = new Map([
    ['key1', 'value1'],
    ['key2', 'value2'],
  ]);
  const input = {
    first: { data: sharedMap },
    second: { data: sharedMap },
    third: { data: sharedMap },
  };

  const cloned = structuredClone(input);

  expect(cloned.first.data).toEqual(sharedMap);
  expect(cloned.second.data).toEqual(sharedMap);
  expect(cloned.third.data).toEqual(sharedMap);
  expect(cloned.first.data).toBe(cloned.second.data);
  expect(cloned.second.data).toBe(cloned.third.data);
});

test('structuredClone preserves repeated array references', () => {
  const sharedArray = [1, 2, 3, 4, 5];
  const input = {
    a: { validators: sharedArray },
    b: { validators: sharedArray },
    c: { validators: sharedArray },
  };

  const cloned = structuredClone(input);

  expect(cloned.a.validators).toEqual(sharedArray);
  expect(cloned.b.validators).toEqual(sharedArray);
  expect(cloned.c.validators).toEqual(sharedArray);
  expect(cloned.a.validators).toBe(cloned.b.validators);
  expect(cloned.b.validators).toBe(cloned.c.validators);
});

test('structuredClone preserves 255-boundary repeated references', () => {
  // The original bug desynchronized at the 255-object pool boundary.
  const shared = { marker: 'shared-value' };
  const input: Record<string, unknown> = {};
  // Fill with 254 unique objects to push the shared ref past the boundary.
  for (let i = 0; i < 254; i += 1) {
    input[`filler${i}`] = { index: i };
  }
  input.shared1 = shared;
  input.shared2 = shared;
  input.shared3 = shared;

  const cloned = structuredClone(input);

  expect(cloned.shared1).toEqual(shared);
  expect(cloned.shared2).toEqual(shared);
  expect(cloned.shared3).toEqual(shared);
  expect(cloned.shared1).toBe(cloned.shared2);
  expect(cloned.shared2).toBe(cloned.shared3);
});
