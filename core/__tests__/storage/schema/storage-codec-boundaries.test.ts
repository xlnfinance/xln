import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { decodeBinaryPayload, encodeBinaryPayload } from '../../../protocol/serialization/binary-codec';
import { decodeBuffer, encodeBuffer, writeBatch } from '../../../storage/codec/codec';
import {
  decodeEntityId,
  hexBytes,
  keyCertifiedBoardNodePrefix,
  keyLiveAccount,
  keyLiveBook,
  keyLiveEntity,
  keyLiveReplicaMeta,
  keySnapshotAccountPrefix,
  keySnapshotEntity,
  parseLiveAccountKey,
  parseLiveBookKey,
  parseSnapshotAccountKey,
  parseSnapshotEntityKey,
} from '../../../storage/keys';

const entityId = `0x${'11'.repeat(32)}`;
const counterpartyId = `0x${'22'.repeat(32)}`;

// The only binary format: canonical MessagePack via msgpackr with moreTypes,
// no reference markers, and Buffer folded into Uint8Array.
const GOLDEN_MSGPACK_HEX =
  '03d4724098a6626967696e74a6627566666572a464617465a36d6170a66f626a656374a3736574a57479706564a776657273696f6e' +
  'cfab54a98ceb1f0ad2c70574010001feffd7ffa1a5d60065937d2582a161d30000000000000001a17ad30000000000000002d4724192' +
  'a161a17aa17802d4730092a161a17ac704740109080701';
const GOLDEN_MSGPACK_HASH = '0x6a2608adeb9078a0bec8693b5a8a72827d7f1a0324d3ee3a001f74c8348dd080';

const goldenCodecValue = () => ({
  version: 1,
  object: { z: 2, a: 'x' },
  map: new Map([['z', 2n], ['a', 1n]]),
  set: new Set(['z', 'a']),
  bigint: 12_345_678_901_234_567_890n,
  buffer: Buffer.from([0, 1, 254, 255]),
  typed: new Uint8Array([9, 8, 7]),
  date: new Date('2024-01-02T03:04:05.678Z'),
});

describe('canonical binary codec', () => {
  test('storage keys require exact entity, hash, and signer hex widths', () => {
    const valid32 = `0x${'ab'.repeat(32)}`;
    const validSigner = `0x${'cd'.repeat(20)}`;
    expect(keyLiveEntity(valid32)).toHaveLength(33);
    expect(keyCertifiedBoardNodePrefix(valid32)).toHaveLength(33);
    expect(keyLiveReplicaMeta(valid32, validSigner)).toHaveLength(65);
    expect(decodeEntityId(Uint8Array.from({ length: 32 }, () => 0xab))).toBe(valid32);

    for (const invalid of [
      `0x${'a'.repeat(63)}`,
      `0x${'a'.repeat(62)}`,
      `0x${'a'.repeat(66)}`,
      `0x${'g'.repeat(64)}`,
      'ab'.repeat(32),
    ]) {
      expect(() => keyLiveEntity(invalid), invalid).toThrow('STORAGE_HEX_32_INVALID');
      expect(() => keyCertifiedBoardNodePrefix(invalid), invalid).toThrow('STORAGE_HEX_32_INVALID');
    }
    for (const invalidSigner of [
      `0x${'a'.repeat(39)}`,
      `0x${'a'.repeat(42)}`,
      `0x${'g'.repeat(40)}`,
      'ab'.repeat(20),
    ]) {
      expect(() => keyLiveReplicaMeta(valid32, invalidSigner), invalidSigner)
        .toThrow('STORAGE_SIGNER_HEX_20_INVALID');
    }
    expect(() => decodeEntityId(Uint8Array.from({ length: 31 }))).toThrow(
      'STORAGE_ENTITY_ID_BYTES_INVALID:31',
    );
    expect(() => decodeEntityId(Uint8Array.from({ length: 33 }))).toThrow(
      'STORAGE_ENTITY_ID_BYTES_INVALID:33',
    );
  });

  test('all fixed-width storage key parsers reject wrong tags, truncation, and trailing bytes', () => {
    const validKeys: Array<[Buffer, (key: Buffer) => unknown]> = [
      [keyLiveAccount(entityId, counterpartyId), parseLiveAccountKey],
      [keySnapshotEntity(8, entityId), parseSnapshotEntityKey],
      [Buffer.concat([keySnapshotAccountPrefix(8, entityId), hexBytes(counterpartyId)]), parseSnapshotAccountKey],
    ];
    for (const [key, parse] of validKeys) {
      expect(() => parse(key)).not.toThrow();
      expect(() => parse(key.subarray(0, key.length - 1))).toThrow();
      expect(() => parse(Buffer.concat([key, Buffer.from([0])]))).toThrow();
      const wrongTag = Buffer.from(key);
      wrongTag[0] = 0xff;
      expect(() => parse(wrongTag)).toThrow();
    }

    const bookKey = keyLiveBook(entityId, 'ethereum:2/tron:1');
    expect(parseLiveBookKey(bookKey).pairId).toBe('ethereum:2/tron:1');
    expect(() => parseLiveBookKey(bookKey.subarray(0, bookKey.length - 1))).toThrow();
    expect(() => parseLiveBookKey(Buffer.concat([bookKey, Buffer.from([0])]))).toThrow();
  });

  test('explicit rebuildable-cache writes do not request an fsync', async () => {
    let observed: { sync?: boolean } | undefined = { sync: true };
    await writeBatch({
      write: async (options) => {
        observed = options;
      },
    }, { sync: false });
    expect(observed).toBeUndefined();
  });

  test('encodes plain browser payloads without a global Buffer polyfill', () => {
    const moduleUrl = new URL('../../../protocol/serialization/binary-codec.ts', import.meta.url).href;
    const serializationUrl = new URL('../../../protocol/serialization/index.ts', import.meta.url).href;
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

  test('matches independent canonical MessagePack bytes and hash', () => {
    const msgpack = encodeBinaryPayload(goldenCodecValue());

    expect(Buffer.from(msgpack).toString('hex')).toBe(GOLDEN_MSGPACK_HEX);
    expect(ethers.keccak256(msgpack)).toBe(GOLDEN_MSGPACK_HASH);
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

    const firstBytes = encodeBinaryPayload(first);
    const secondBytes = encodeBinaryPayload(second);

    expect(Buffer.from(firstBytes).equals(Buffer.from(secondBytes))).toBe(true);
    expect(decodeBinaryPayload(secondBytes)).toEqual(first);
  });

  test('rejects cycles and unsupported values instead of silently changing them', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => encodeBinaryPayload(cyclic)).toThrow('XLN_BINARY_CODEC_CYCLE');
    expect(() => encodeBinaryPayload({ fn: () => 1 }))
      .toThrow('XLN_BINARY_CODEC_UNSUPPORTED');
    const symbolKey = Symbol('ephemeral');
    const symbolMarked = { durable: 1, [symbolKey]: true };
    expect(() => encodeBinaryPayload(symbolMarked)).toThrow('detail=symbol-key');
    expect(decodeBinaryPayload(encodeBinaryPayload(symbolMarked, { omitSymbolKeys: true })))
      .toEqual({ durable: 1 });
  });

  test('canonical MessagePack preserves own undefined', () => {
    const source = { optional: undefined, array: [1, undefined, 3] };
    const decoded = decodeBinaryPayload<typeof source>(encodeBinaryPayload(source));

    expect(Object.hasOwn(decoded, 'optional')).toBe(true);
    expect(decoded.optional).toBeUndefined();
    expect(Object.hasOwn(decoded.array, 1)).toBe(true);
    expect(decoded.array).toEqual([1, undefined, 3]);
  });

  test('authoritative storage rejects every non-MessagePack payload', () => {
    const debugPayload = Buffer.from([0x02, 0x00]);
    expect(() => decodeBuffer(debugPayload)).toThrow('STORAGE_CODEC_MSGPACK_REQUIRED');
  });
});
