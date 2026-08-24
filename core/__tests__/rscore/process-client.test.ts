import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { swapMarketPolicyWire } from '../../rscore/shadow-wire';
import { RSCORE_PROCESS_ABI_VERSION, RscoreProcessClient } from '../../rscore/client';

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
      expect(hello[0]).toBe(RSCORE_PROCESS_ABI_VERSION);
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

  test('an authoritative session runs a wave and commits it', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const seed = `0x${'7a'.repeat(32)}`;
      const hello = (await client.hello(2, swapMarketPolicyWire(), {
        seed,
        signerId: '1',
      })) as unknown[];
      expect(hello[0]).toBe(RSCORE_PROCESS_ABI_VERSION);

      const loaded = (await client.restore(0, [])) as unknown[];
      expect(loaded[0]).toBe(0);

      const { result, token } = await client.prepareAccountWave({
        timestamp: 1_700_000_000_000,
        jHeight: 100,
        entityTimestamp: 1_700_000_000_000,
        finalizedJHeight: 100,
        propose: true,
        admissions: [],
        inputs: [],
      });
      const wave = result as unknown[];
      // No accounts, so nothing moved and nothing was proposed — but the wave
      // is still a candidate that must be committed or taken back.
      expect(wave[0]).toBe(0);
      expect(wave[2]).toEqual([]);
      expect(wave[3]).toEqual([]);

      await expect(
        client.prepareAccountWave({
          timestamp: 1_700_000_000_001,
          jHeight: 100,
          entityTimestamp: 1_700_000_000_001,
          finalizedJHeight: 100,
          propose: true,
          admissions: [],
          inputs: [],
        }),
      ).rejects.toThrow('RSCORE_PROCESS_PREPARE_PENDING');

      const committed = (await client.commit(token)) as unknown[];
      expect(committed[0]).toBe(0);

      await client.shutdown();
    } finally {
      client.kill();
    }
  });
});
