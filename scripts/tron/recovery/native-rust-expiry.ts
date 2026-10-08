/** Transparent native-node fault injection: crash only before real broadcasts. */
import { strict as assert } from 'node:assert';
import { cpSync } from 'node:fs';
import { Level } from 'level';
import { decodeBuffer } from '../../../core/storage/codec/codec';
import { safeStringify } from '../../../core/protocol/serialization';
import { decodeSignedTronTransaction } from '../../../core/jurisdiction/adapter/operations/tron-transaction';

type Config = { data: string; fullHost: string; solidHost: string; rpc: string; stop(): Promise<void> };

const committedRaw = async (data: string, phase: string, raw: string, expectedType: string) => {
  const copy = `${data}/${phase}-wal-evidence`;
  cpSync(`${data}/runtime/rscore-native`, copy, { recursive: true, errorOnExist: true, force: false });
  const db = new Level<Buffer, Buffer>(copy, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  const matches: unknown[] = [];
  try {
    for await (const [, bytes] of db.iterator({ gte: Buffer.from([0x10]), lt: Buffer.from([0x11]) })) {
      const frame = decodeBuffer(bytes) as { height: number; runtimeInput?: { runtimeTxs?: { type: string; data: { rawTransaction?: string } }[] } };
      for (const tx of frame.runtimeInput?.runtimeTxs ?? []) {
        if (tx.type === expectedType && tx.data.rawTransaction === raw) matches.push({ height: frame.height, tx });
      }
    }
  } finally { await db.close(); }
  assert.equal(matches.length, 1, `${expectedType} must be committed once BEFORE broadcast`);
  await Bun.write(`${data}/${phase}-accepted.json`, safeStringify(matches[0], 2));
};

export const createNativeRustExpiry = (config: Config) => {
  let phase: 'prepared' | 'replacement' | 'forward' = 'prepared';
  let prepared: ReturnType<typeof decodeSignedTronTransaction> | undefined;
  let replacement: ReturnType<typeof decodeSignedTronTransaction> | undefined;
  let failure: unknown;
  const intercept = async (raw: string) => {
    const decoded = decodeSignedTronTransaction(raw);
    await config.stop();
    if (phase === 'prepared') {
      await committedRaw(config.data, phase, raw, 'recordJPreparedTransaction');
      await Bun.write(`${config.data}/prepared-wire.json`, safeStringify({ raw, decoded }, 2));
      prepared = decoded;
    } else {
      assert(prepared);
      assert.notEqual(decoded.hash, prepared.hash);
      for (const field of ['from', 'to', 'data', 'value'] as const) assert.equal(decoded[field], prepared[field]);
      await committedRaw(config.data, phase, raw, 'replaceJPreparedTransaction');
      await Bun.write(`${config.data}/replacement-wire.json`, safeStringify({ raw, decoded }, 2));
      replacement = decoded;
    }
  };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 19292, idleTimeout: 120,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = await request.text();
      if (path === '/full/wallet/broadcasthex' && phase !== 'forward') {
        try { await intercept(`0x${JSON.parse(body).transaction}`); }
        catch (error) { failure = error; }
        // The client has been SIGKILLed. No fabricated native response enters Runtime.
        return new Response('fault injector closed after SIGKILL', { status: 503 });
      }
      const target = path.startsWith('/full/') ? config.fullHost + path.slice(5)
        : path.startsWith('/solid/') ? config.solidHost + path.slice(6) : config.rpc;
      return fetch(target, { method: request.method, headers: { 'content-type': 'application/json' }, body });
    },
  });
  const wait = async (label: string, done: () => boolean) => {
    const deadline = Date.now() + 45_000;
    while (!done()) {
      if (failure) throw failure;
      assert(Date.now() < deadline, label);
      await Bun.sleep(100);
    }
  };
  return {
    rpc: 'http://127.0.0.1:19292/jsonrpc',
    fullHost: 'http://127.0.0.1:19292/full',
    solidHost: 'http://127.0.0.1:19292/solid',
    async recover(start: (label: string) => void) {
      await wait('prepared native raw capture', () => prepared !== undefined);
      assert(prepared);
      const deadline = Date.now() + 85_000;
      let solid;
      do {
        const response = await fetch(`${config.solidHost}/walletsolidity/getnowblock`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
        assert(response.ok);
        solid = await response.json();
        assert(Date.now() < deadline, 'genuine native solid expiration');
        if (BigInt(solid.block_header.raw_data.timestamp) <= prepared.expiration) await Bun.sleep(500);
      } while (BigInt(solid.block_header.raw_data.timestamp) <= prepared.expiration);
      await Bun.write(`${config.data}/expired-solid-head.json`, JSON.stringify(solid, null, 2));
      const receiptResponse = await fetch(config.rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [prepared.hash] }) });
      assert(receiptResponse.ok);
      const absent = await receiptResponse.json();
      assert.equal(absent.error, undefined);
      assert.equal(absent.result, null, 'expired original was never broadcast');
      phase = 'replacement';
      start('expiry-replacement');
      await wait('replacement native raw capture', () => replacement !== undefined);
      phase = 'forward';
      start('replacement-restored');
    },
    hashes() { assert(prepared && replacement); return { old: prepared.hash, replacement: replacement.hash }; },
    close() { server.stop(true); },
  };
};
