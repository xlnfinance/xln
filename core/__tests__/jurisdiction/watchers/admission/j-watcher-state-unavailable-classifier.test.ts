import { describe, expect, test } from 'bun:test';

import { isHistoricalStateUnavailable } from '../../../../jurisdiction/adapter/rpc/watcher/rpc-watcher-canonical';

// The exact reply Anvil gives for state outside its --prune-history window.
const outOfRange = (head: number, requested: number, code = -32602) => ({
  code,
  message: `BlockOutOfRangeError: block height is ${head} but requested was ${requested}`,
});

describe('historical state-unavailable classification', () => {
  test('only an older height below the reported head skips observation', () => {
    expect(isHistoricalStateUnavailable(outOfRange(1223, 76), 76)).toBe(true);
    // ethers wraps the JSON-RPC error under error/cause.
    expect(isHistoricalStateUnavailable({ error: outOfRange(1223, 76) }, 76)).toBe(true);
    expect(isHistoricalStateUnavailable({ cause: { error: outOfRange(1223, 76) } }, 76)).toBe(true);
  });

  test('current, future and wrong heights stay fail-stop', () => {
    expect(isHistoricalStateUnavailable(outOfRange(76, 76), 76)).toBe(false);
    expect(isHistoricalStateUnavailable(outOfRange(75, 76), 76)).toBe(false);
    expect(isHistoricalStateUnavailable(outOfRange(1223, 75), 76)).toBe(false);
    expect(isHistoricalStateUnavailable(outOfRange(1223, 760), 76)).toBe(false);
  });

  test('other codes, messages and malformed values stay fail-stop', () => {
    expect(isHistoricalStateUnavailable(outOfRange(1223, 76, -32000), 76)).toBe(false);
    expect(isHistoricalStateUnavailable({ code: -32602, message: 'missing trie node' }, 76)).toBe(false);
    expect(isHistoricalStateUnavailable(
      { code: -32602, message: `prefix BlockOutOfRangeError: block height is 1223 but requested was 76` },
      76,
    )).toBe(false);
    expect(isHistoricalStateUnavailable(
      { code: -32602, message: 'BlockOutOfRangeError: block height is 99999999999999999999 but requested was 76' },
      76,
    )).toBe(false);
    expect(isHistoricalStateUnavailable(new Error('HEADER_HASH_MISMATCH'), 76)).toBe(false);
    expect(isHistoricalStateUnavailable(null, 76)).toBe(false);
  });
});
