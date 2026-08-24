import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { swapMarketPolicyWire } from '../../rscore/shadow-wire';
import { RscoreProcessClient } from '../../rscore/client';

const BINARY = join(import.meta.dir, '../../../rscore/target/release/xln-rscore');

const identity = () => ({
  engineGeneration: Buffer.alloc(8, 0xa0),
  runtimeId: Buffer.alloc(20, 0x10),
  sessionId: Buffer.alloc(16, 0x20),
});

// Live TS→Rust IPC over the real binary: hello → restore(empty) → summary →
// prepare/commit → shutdown. Requires `cargo build --release -p
// xln-rscore-process` (deploy/dev builds it; skip when absent so pure-TS
// environments stay green).
// A release gate sets XLN_RSCORE_REQUIRE_BINARY=1: an absent binary is then a
// failure, never a silent skip.
if (!existsSync(BINARY) && process.env['XLN_RSCORE_REQUIRE_BINARY'] === '1') {
  throw new Error(`RSCORE_BINARY_MISSING:${BINARY}`);
}

describe.skipIf(!existsSync(BINARY))('rscore process client', () => {
  test('speaks the framed ABI end to end', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const hello = (await client.hello(4, swapMarketPolicyWire())) as unknown[];
      expect(hello[0]).toBe(1);
      expect(hello[2]).toBe(4);

      const loaded = (await client.restore(7, [])) as unknown[];
      expect(loaded[0]).toBe(7);
      // Empty accounts tree commits to the all-zero root.
      expect(new Uint8Array(loaded[1] as Uint8Array)).toEqual(new Uint8Array(32));

      const page = (await client.readAccountSummaryPage(null, 8, [1])) as unknown[];
      expect(page[0]).toBe(7); // revision
      expect(page[1]).toEqual([]); // no accounts
      const totals = page[3] as unknown[];
      expect(totals[0]).toBe(0);

      // Empty waves are refused loudly — no silent no-op commits.
      await expect(client.prepare([])).rejects.toThrow('RSCORE_BATCH_EMPTY');

      await client.shutdown();
    } finally {
      client.kill();
    }
  });
});
