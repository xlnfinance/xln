import { expect, test } from 'bun:test';

import { selectInitialEntityWireFitCount } from '../../../entity/consensus/proposal/wire-budget';

test('zero fit hint cannot starve the next non-empty Account ACK frame', () => {
  expect(selectInitialEntityWireFitCount(1, 0)).toBe(1);
  expect(selectInitialEntityWireFitCount(500, 0)).toBe(1);
  expect(selectInitialEntityWireFitCount(0, 0)).toBe(0);
});

test('wire fit hint stays bounded by the available transaction count', () => {
  expect(selectInitialEntityWireFitCount(10, undefined)).toBe(10);
  expect(selectInitialEntityWireFitCount(10, 4)).toBe(5);
  expect(selectInitialEntityWireFitCount(3, 100)).toBe(3);
  expect(() => selectInitialEntityWireFitCount(1, -1)).toThrow('ENTITY_WIRE_FIT_HINT_INVALID');
});
