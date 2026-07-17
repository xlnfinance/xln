import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { ethers } from 'ethers';
import { Level } from 'level';

import type { AccountFrame } from '../types';
import { decodeBinaryPayload, encodeBinaryPayload } from '../storage/binary-codec';
import { decodeBuffer, encodeBuffer } from '../storage/codec';
import {
  readFrameDbAccountFrames,
  readFrameDbHead,
  readFrameDbRuntimeActivity,
  type StoredAccountFrameValue,
} from '../storage/frame-db';
import {
  KEY_FRAME_DB_HEAD,
  STORAGE_SCHEMA_VERSION,
  keyFrameDbAccountFrame,
  keyFrameDbRuntimeActivity,
} from '../storage/keys';
import type { RuntimeFrameDbLike, StorageRuntimeConfig } from '../storage/types';
import {
  encodePersistedFrameJournal,
  readPersistedLatestHeight,
  type PersistedFrameJournal,
} from '../wal/store';

const tempPaths: string[] = [];
const zeroHash = `0x${'00'.repeat(32)}`;
const entityId = `0x${'11'.repeat(32)}`;
const counterpartyId = `0x${'22'.repeat(32)}`;

// XLN_BINARY_FORMAT_V1 is pinned independently from the implementation.
// Changing a literal requires a new codec magic/storage schema version plus an
// independently reviewed vector; never "refresh" these after a refactor.
const GOLDEN_MSGPACK_V1_HEX =
  '01d4724098a6626967696e74a6627566666572a464617465a36d6170a66f626a656374a3736574a57479706564a776657273696f6e' +
  'cfab54a98ceb1f0ad2c4040001feffd7ffa1a5d60065937d2582a161d30000000000000001a17ad30000000000000002d4724192' +
  'a161a17aa17802d4730092a161a17ac704740109080701';
const GOLDEN_JSON_V1_BODY =
  '{"bigint":{"__xlnType":"BigInt","value":"12345678901234567890"},' +
  '"buffer":{"__xlnType":"Buffer","value":[0,1,254,255]},' +
  '"date":{"__xlnType":"Date","value":"2024-01-02T03:04:05.678Z"},' +
  '"map":{"__xlnType":"Map","value":[["a",{"__xlnType":"BigInt","value":"1"}],["z",{"__xlnType":"BigInt","value":"2"}]]},' +
  '"object":{"a":"x","z":2},"set":{"__xlnType":"Set","value":["a","z"]},' +
  '"typed":{"__xlnType":"TypedArray","kind":"Uint8Array","value":"CQgH"},"version":1}';
const GOLDEN_HASHES_V1 = {
  msgpack: '0x2155da9edd8ffde80d3a2f4a52b40995ed89a9680979e25c18b998359fe2832f',
  json: '0x36b7663b235d64db039ba8736fa82d9f3f830c1e7d4e351f554f4464b6ba27d6',
  walMsgpack: '0xb3081bbb0c410937b24e950c76d76978c1b87c0285807de6736e1d00abd97ef1',
  walJson: '0xef4eda3e43c93aa5e1c21e21556742c1fdc1915b3dcbbca8ecaf76bcaee5f205',
  frameMsgpack: '0x30b36234718ca0624e8fdb67e45746f3a6dd6c06beadf989797acda5c99fcf03',
  frameJson: '0x863eef139d80887612e7291b04bfec5cbb8f596ef028bbd42610866d672fed7b',
} as const;

const storageConfig: Required<StorageRuntimeConfig> = {
  snapshotPeriodFrames: 100,
  materializePeriodFrames: 1,
  retainSnapshots: 2,
  maxStateBytes: 1024 * 1024,
  warningStateBytes: 512 * 1024,
  maxReplayBytes: 1024 * 1024,
  frameDbMaxBytes: 1024 * 1024,
  frameDbRetainFrames: 100,
};

const openDb = async (label: string): Promise<Level<Buffer, Buffer>> => {
  const path = `/tmp/xln-storage-codec-${label}-${process.pid}-${Date.now()}`;
  tempPaths.push(path);
  const db = new Level<Buffer, Buffer>(path, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
  });
  await db.open();
  return db;
};

const validFrame = (): AccountFrame => ({
  height: 2,
  timestamp: 123,
  jHeight: 7,
  accountTxs: [],
  prevFrameHash: zeroHash,
  accountStateRoot: zeroHash,
  stateHash: zeroHash,
  byLeft: true,
  deltas: [],
});

const goldenCodecValueV1 = () => ({
  version: 1,
  object: { z: 2, a: 'x' },
  map: new Map([['z', 2n], ['a', 1n]]),
  set: new Set(['z', 'a']),
  bigint: 12_345_678_901_234_567_890n,
  buffer: Buffer.from([0, 1, 254, 255]),
  typed: new Uint8Array([9, 8, 7]),
  date: new Date('2024-01-02T03:04:05.678Z'),
});

const goldenWalV1 = (): PersistedFrameJournal => ({
  height: 7,
  timestamp: 123,
  replicaMetaDigest: `0x${'22'.repeat(32)}`,
  runtimeInput: { runtimeTxs: [], entityInputs: [] },
  runtimeStateHash: `0x${'11'.repeat(32)}`,
  logs: [{ id: 1, timestamp: 123, level: 'info', category: 'system', message: 'frame' }],
});

const goldenFrameV1 = (): StoredAccountFrameValue => ({
  source: 'ackCommit',
  frame: validFrame(),
  runtimeHeight: 8,
  timestamp: 456,
});

afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('canonical binary codec', () => {
  test('encodes plain browser payloads without a global Buffer polyfill', () => {
    const moduleUrl = new URL('../storage/binary-codec.ts', import.meta.url).href;
    const serializationUrl = new URL('../protocol/serialization.ts', import.meta.url).href;
    const child = Bun.spawnSync({
      cmd: ['bun', '-e', [
        'globalThis.Buffer = undefined;',
        `const codec = await import(${JSON.stringify(moduleUrl)});`,
        `const serialization = await import(${JSON.stringify(serializationUrl)});`,
        "const encoded = codec.encodeBinaryPayload({ v: 1, op: 'read', path: 'head' });",
        'const decoded = codec.decodeBinaryPayload(encoded);',
        `const bytes = serialization.deserializeTaggedJson(${JSON.stringify('{"__xlnType":"Buffer","value":[1,2,3]}')});`,
        'console.log(JSON.stringify({ decoded, bytes: Array.from(bytes) }));',
      ].join(' ')],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(new TextDecoder().decode(child.stderr)).toBe('');
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(child.stdout).trim())).toEqual({
      decoded: { op: 'read', path: 'head', v: 1 },
      bytes: [1, 2, 3],
    });
  });

  test('matches independent XLN_BINARY_FORMAT_V1 bytes and hashes', () => {
    const value = goldenCodecValueV1();
    const msgpack = encodeBinaryPayload(value, 'msgpack');
    const json = encodeBinaryPayload(value, 'json');

    expect(Buffer.from(msgpack).toString('hex')).toBe(GOLDEN_MSGPACK_V1_HEX);
    expect(ethers.keccak256(msgpack)).toBe(GOLDEN_HASHES_V1.msgpack);
    expect(json[0]).toBe(0x02);
    expect(new TextDecoder().decode(json.subarray(1))).toBe(GOLDEN_JSON_V1_BODY);
    expect(ethers.keccak256(json)).toBe(GOLDEN_HASHES_V1.json);
  });

  test('pins representative WAL and frame wrapper hashes in both codecs', () => {
    const wal = goldenWalV1();
    const walMsgpack = encodePersistedFrameJournal(wal);
    const walJson = encodeBinaryPayload(wal, 'json');
    const frame = goldenFrameV1();
    const frameMsgpack = encodeBinaryPayload(frame, 'msgpack');
    const frameJson = encodeBinaryPayload(frame, 'json');

    expect(ethers.keccak256(walMsgpack)).toBe(GOLDEN_HASHES_V1.walMsgpack);
    expect(ethers.keccak256(walJson)).toBe(GOLDEN_HASHES_V1.walJson);
    expect(ethers.keccak256(frameMsgpack)).toBe(GOLDEN_HASHES_V1.frameMsgpack);
    expect(ethers.keccak256(frameJson)).toBe(GOLDEN_HASHES_V1.frameJson);
  });

  test('produces identical MessagePack bytes independent of insertion order', () => {
    const first = {
      z: new Map<unknown, unknown>([['b', 2n], ['a', new Set([3, 1, 2])]]),
      a: { right: 2, left: 1 },
    };
    const second = {
      a: { left: 1, right: 2 },
      z: new Map<unknown, unknown>([['a', new Set([2, 3, 1])], ['b', 2n]]),
    };

    const firstBytes = encodeBinaryPayload(first, 'msgpack');
    const secondBytes = encodeBinaryPayload(second, 'msgpack');

    expect(Buffer.from(firstBytes).equals(Buffer.from(secondBytes))).toBe(true);
    expect(decodeBinaryPayload(secondBytes)).toEqual(first);
  });

  test('rejects cycles and unsupported values instead of silently changing them', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => encodeBinaryPayload(cyclic, 'msgpack')).toThrow('XLN_BINARY_CODEC_CYCLE');
    expect(() => encodeBinaryPayload({ fn: () => 1 }, 'msgpack'))
      .toThrow('XLN_BINARY_CODEC_UNSUPPORTED');
  });

  test('authoritative MessagePack preserves own undefined while debug JSON rejects it', () => {
    const source = { optional: undefined, array: [1, undefined, 3] };
    const decoded = decodeBinaryPayload<typeof source>(encodeBinaryPayload(source, 'msgpack'));

    expect(Object.hasOwn(decoded, 'optional')).toBe(true);
    expect(decoded.optional).toBeUndefined();
    expect(Object.hasOwn(decoded.array, 1)).toBe(true);
    expect(decoded.array).toEqual([1, undefined, 3]);
    expect(() => encodeBinaryPayload(source, 'json')).toThrow(
      'XLN_BINARY_CODEC_UNSUPPORTED:path=$.array[1]:detail=type=undefined',
    );
  });

  test('canonical JSON preserves every named field and rejects cycles', () => {
    const first = { provider: 'named-domain-value', b: 2, a: 1 };
    const second = { a: 1, b: 2, provider: 'named-domain-value' };
    const firstBytes = encodeBinaryPayload(first, 'json');
    const secondBytes = encodeBinaryPayload(second, 'json');
    expect(Buffer.from(firstBytes).equals(Buffer.from(secondBytes))).toBe(true);
    expect(decodeBinaryPayload(firstBytes)).toEqual(first);

    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => encodeBinaryPayload(cyclic, 'json')).toThrow('XLN_BINARY_CODEC_CYCLE');
  });

  test('authoritative storage rejects debug JSON payloads', () => {
    const debugPayload = Buffer.from(encodeBinaryPayload({ height: 1 }, 'json'));
    expect(() => decodeBuffer(debugPayload)).toThrow('STORAGE_CODEC_MSGPACK_REQUIRED');
  });
});

describe('strict LevelDB decode boundaries', () => {
  test('rejects malformed frame DB head fields after a real close and reopen', async () => {
    const db = await openDb('head');
    const path = db.location;
    await db.put(KEY_FRAME_DB_HEAD, encodeBuffer({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      latestHeight: '7junk',
      latestPrunedRuntimeHeight: 0,
      retainedBytes: 0,
      maxBytes: storageConfig.frameDbMaxBytes,
      retainFrames: storageConfig.frameDbRetainFrames,
    }));
    await db.close();

    const reopened = new Level<Buffer, Buffer>(path, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });
    await reopened.open();
    await expect(readFrameDbHead(reopened as unknown as RuntimeFrameDbLike, storageConfig))
      .rejects.toThrow('FRAME_DB_HEAD_LATEST_HEIGHT_INVALID');
    await reopened.close();
  });

  test('rejects partially parsed WAL scalar pointers', async () => {
    const db = await openDb('wal-pointer');
    await db.put(Buffer.from('strict:latest_height'), Buffer.from('7junk'));
    await expect(readPersistedLatestHeight(db, 'strict'))
      .rejects.toThrow('WAL_LATEST_HEIGHT_INVALID:7junk');
    await db.close();
  });

  test('rejects missing compact activity fields instead of defaulting them', async () => {
    const db = await openDb('activity');
    await db.put(keyFrameDbRuntimeActivity(3), encodeBuffer({
      timestamp: 123,
      runtimeInput: { entityInputs: [] },
      logs: [],
      touchedAccounts: [],
      touchedBookEntities: [],
    }));

    await expect(readFrameDbRuntimeActivity(db as unknown as RuntimeFrameDbLike, 3))
      .rejects.toThrow('FRAME_DB_RUNTIME_ACTIVITY_FIELDS_INVALID:height=3');
    await db.close();
  });

  test('rejects missing and extra compact account-frame fields', async () => {
    const db = await openDb('account');
    const key = keyFrameDbAccountFrame(entityId, counterpartyId, 2);
    await db.put(key, encodeBuffer({
      frame: validFrame(),
      runtimeHeight: 8,
      timestamp: 456,
      unexpected: true,
    }));

    await expect(readFrameDbAccountFrames(
      db as unknown as RuntimeFrameDbLike,
      entityId,
      counterpartyId,
    )).rejects.toThrow('FRAME_DB_ACCOUNT_FRAME_FIELDS_INVALID');
    await db.close();
  });
});
