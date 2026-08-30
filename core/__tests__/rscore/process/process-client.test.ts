import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  RSCORE_PROCESS_ABI_VERSION,
  RscoreProcessClient,
} from '../../../rscore/client';
import { deriveSignerKeySync } from '../../../account/crypto';
import { swapMarketPolicyWire } from '../../../rscore/shadow-wire';

const BINARY = join(import.meta.dir, '../../../../rscore/target/release/xlnrs');
const POISONED_PROCESS = join(
  import.meta.dir,
  '../../fixtures/process/rscore-poisoned-process.ts',
);

const identity = () => ({
  engineGeneration: Buffer.alloc(8, 0xa0),
  runtimeId: Buffer.alloc(20, 0x10),
  sessionId: Buffer.alloc(16, 0x20),
});
const authority = () => ({
  privateKey: deriveSignerKeySync(`0x${'7a'.repeat(32)}`, '1'),
  signerId: '1',
});

if (!existsSync(BINARY) && process.env['XLN_RSCORE_REQUIRE_BINARY'] === '1') {
  throw new Error(`RSCORE_BINARY_MISSING:${BINARY}`);
}

test('a malformed reply poisons every concurrent request before another is sent', async () => {
  const client = new RscoreProcessClient(POISONED_PROCESS, identity());
  try {
    const settled = await Promise.allSettled([
      client.readCapacityBatch([]),
      client.readCapacityBatch([]),
    ]);

    expect(settled[0]).toMatchObject({ status: 'rejected' });
    expect(settled[1]).toMatchObject({ status: 'rejected' });
    if (settled[0]?.status === 'rejected') {
      expect(String(settled[0].reason)).toContain('RSCORE_CLIENT_MAGIC_INVALID');
    }
    if (settled[1]?.status === 'rejected') {
      expect(String(settled[1].reason))
        .toMatch(/RSCORE_CLIENT_(?:MAGIC_INVALID|UNEXPECTED_FRAME)/);
    }
  } finally {
    client.kill();
  }
});

test('an invalid reply header poisons the session', async () => {
  for (const [marker, error] of [
    [0x55, 'RSCORE_CLIENT_ABI_VERSION:true'],
    [0x56, 'RSCORE_CLIENT_MESSAGE_KIND:3'],
  ] as const) {
    const client = new RscoreProcessClient(POISONED_PROCESS, identity());
    try {
      await expect(client.readAccountEnvelope(Buffer.alloc(32, marker)))
        .rejects.toThrow(error);
      await expect(client.readAccountEnvelope(Buffer.alloc(32)))
        .rejects.toThrow(error);
    } finally {
      client.kill();
    }
  }
});

test('an unsolicited frame poisons even the valid response before it can return', async () => {
  const client = new RscoreProcessClient(POISONED_PROCESS, identity());
  try {
    const settled = await Promise.allSettled([
      client.readAccountEnvelope(Buffer.alloc(32)),
      client.readAccountEnvelope(Buffer.alloc(32)),
    ]);

    expect(settled[0]).toMatchObject({ status: 'rejected' });
    expect(settled[1]).toMatchObject({ status: 'rejected' });
    for (const result of settled) {
      if (result.status === 'rejected') {
        expect(String(result.reason)).toContain('RSCORE_CLIENT_UNEXPECTED_FRAME');
      }
    }
  } finally {
    client.kill();
  }
});

test('a fragmented unsolicited frame poisons the valid response before it can return', async () => {
  const client = new RscoreProcessClient(POISONED_PROCESS, identity());
  try {
    await expect(client.readAccountEnvelope(Buffer.alloc(32, 0x44)))
      .rejects.toThrow('RSCORE_CLIENT_UNEXPECTED_FRAME');
  } finally {
    client.kill();
  }
});

test('a queued request owns call-time nested arrays and bytes', async () => {
  const client = new RscoreProcessClient(POISONED_PROCESS, identity());
  try {
    const first = client.readAccountSummaryPage(Buffer.alloc(32, 1), 8, [1]);
    const cursor = Buffer.alloc(32, 7);
    const tokenIds = [7];
    const second = client.readAccountSummaryPage(cursor, 8, tokenIds);

    cursor[0] = 99;
    tokenIds[0] = 99;

    expect(await first).toEqual(['observed', 1, 1]);
    expect(await second).toEqual(['observed', 7, 7]);
  } finally {
    client.kill();
  }
});

describe.skipIf(!existsSync(BINARY))('rscore process client', () => {
  test('a rejected authority Hello cannot downgrade the child to a mirror', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      await expect(client.hello(2, swapMarketPolicyWire(), {
        privateKey: Buffer.alloc(32, 0xff),
        signerId: '1',
      })).rejects.toThrow('RSCORE_PROCESS_ERROR');

      await expect(client.hello(2, swapMarketPolicyWire()))
        .rejects.toThrow('RSCORE_PROCESS_ERROR');
    } finally {
      client.kill();
    }
  });

  test('speaks the framed authority ABI end to end', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const hello = (await client.hello(4, swapMarketPolicyWire(), authority())) as unknown[];
      expect(hello[0]).toBe(RSCORE_PROCESS_ABI_VERSION);
      expect(hello[2]).toBe(4);

      const loaded = (await client.bootstrapAccounts(0, [])) as unknown[];
      expect(loaded[0]).toBe(0);
      expect(new Uint8Array(loaded[1] as Uint8Array)).toEqual(new Uint8Array(32));
      const inbound = await client.accountInbound({
        ownerEntityId: new Uint8Array(hello[5] as Uint8Array),
        expectedAccountsRoot: new Uint8Array(loaded[1] as Uint8Array),
        entityTimestamp: 0,
        finalizedJHeight: 0,
        rows: [],
        postAccounts: false,
      });
      expect(inbound.revision).toBe(0);
      expect(inbound.accountsRoot).toBe(`0x${'00'.repeat(32)}`);
      await client.shutdown();
    } finally {
      client.kill();
    }
  });

  test('a request that was never written leaves the sequence intact', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const hello = await client.hello(2, swapMarketPolicyWire(), authority()) as unknown[];
      const loaded = await client.bootstrapAccounts(0, []) as unknown[];

      await expect(client.accountInbound({
        ownerEntityId: new Uint8Array(hello[5] as Uint8Array),
        expectedAccountsRoot: new Uint8Array(loaded[1] as Uint8Array),
        entityTimestamp: 0,
        finalizedJHeight: 0,
        rows: [undefined as never],
        postAccounts: false,
      }))
        .rejects.toThrow('RSCORE_CLIENT_VALUE_UNSUPPORTED');

      const inbound = await client.accountInbound({
        ownerEntityId: new Uint8Array(hello[5] as Uint8Array),
        expectedAccountsRoot: new Uint8Array(loaded[1] as Uint8Array),
        entityTimestamp: 0,
        finalizedJHeight: 0,
        rows: [],
        postAccounts: false,
      });
      expect(inbound.revision).toBe(0);
      await client.shutdown();
    } finally {
      client.kill();
    }
  });
});
