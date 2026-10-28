import { expect, test } from 'bun:test';
import { toEntityId, isValidEntityId } from '../../../protocol/identity';
import { asTokenId , toUnixMs, toUnixS, unixMsToUnixSFloor, unixSToUnixMs } from '../../../protocol/units';
import { crossJDeadlines } from '../../../extensions/cross-j/deadlines';

test('EntityId boundary refuses aliases and noncanonical case before branding', () => {
  for (const id of [`0x${'AB'.repeat(32)}`, ` 0x${'ab'.repeat(32)}`, '0x1', 'alice']) {
    expect(isValidEntityId(id)).toBe(false);
    expect(() => toEntityId(id)).toThrow('Invalid EntityId');
  }
  expect(toEntityId(`0x${'ab'.repeat(32)}`)).toBe(`0x${'ab'.repeat(32)}`);
});

test('Unix unit conversion preserves floor semantics and rejects overflow', () => {
  for (const [ms, seconds] of [[1000, 1], [1999, 1], [2000, 2]] as const) {
    expect(unixMsToUnixSFloor(toUnixMs(ms))).toBe(seconds);
    expect(crossJDeadlines(toUnixMs(ms)).source).toBe(seconds);
  }
  for (const invalid of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => toUnixMs(invalid)).toThrow();
    expect(() => toUnixS(invalid)).toThrow();
    expect(() => asTokenId(invalid)).toThrow();
  }
  expect(unixSToUnixMs(toUnixS(1))).toBe(1000);
  expect(() => unixSToUnixMs(toUnixS(Number.MAX_SAFE_INTEGER))).toThrow();
});

test('TokenId boundary has the same uint16 range as Rust', () => {
  for (const id of [0, 1, 65535]) expect(asTokenId(id)).toBe(id);
  expect(() => asTokenId(65536)).toThrow('ACCOUNT_TX_TOKEN_ID_INVALID');
});
