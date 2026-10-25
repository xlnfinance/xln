import { describe, expect, test } from 'bun:test';
import {
  canonicalizeBinaryPayload,
  canonicalConsensusValuesEqual,
  decodeBinaryPayload,
  encodeBinaryPayload,
  encodeCanonicalConsensusBytes,
  packPreorderedBinaryPayload,
  withSharedBinaryProjection,
} from '../../../protocol/serialization/binary-codec';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/**
 * Hashes and socket MACs are computed over these bytes on both ends of a link
 * (Bun hub, browser wallet, Rust engine). msgpackr alone encodes a Uint8Array
 * as its typed-array extension under Node/Bun but as msgpack `bin` in
 * browsers; the codec pins the extension form everywhere. These are the exact
 * bytes Bun produced before the pin, so Rust parity and stored hashes hold.
 */
describe('binary codec byte form', () => {
  test('canonical preparation cannot change consensus bytes or long-hex projection', () => {
    const digest = `0x${'ab'.repeat(32)}`;
    const values = [
      { digest }, [digest], new Map([[digest, { digest }]]), new Set([digest]),
      { nested: [{ digest }, new Map([[digest, new Set([digest])]])] },
    ];
    for (const value of values) {
      const prepared = canonicalizeBinaryPayload(value);
      expect(hex(encodeCanonicalConsensusBytes(prepared))).toBe(hex(encodeCanonicalConsensusBytes(value)));
      expect(canonicalConsensusValuesEqual(prepared, value)).toBe(true);
      expect(hex(encodeCanonicalConsensusBytes({ child: prepared })))
        .toBe(hex(encodeCanonicalConsensusBytes({ child: value })));
    }
  });

  test('a payload preparation marker cannot admit undefined into consensus bytes', () => {
    for (const value of [{ missing: undefined }, [undefined], new Map([['missing', undefined]]), new Set([undefined])]) {
      expect(() => encodeCanonicalConsensusBytes(value)).toThrow('type=undefined');
      expect(() => encodeCanonicalConsensusBytes(canonicalizeBinaryPayload(value))).toThrow('type=undefined');
    }
  });

  test('Uint8Array encodes as the typed-array extension (c7/c8/c9, 0x74, index 1)', () => {
    expect(hex(packPreorderedBinaryPayload(new Uint8Array([1, 2, 3, 4, 5])))).toBe('03c70674010102030405');
    expect(hex(packPreorderedBinaryPayload(new Uint8Array(0)))).toBe('03c7017401');
    const wide = new Uint8Array(300).fill(7);
    expect(hex(packPreorderedBinaryPayload(wide)).slice(0, 12)).toBe('03c8012d7401');
    const huge = new Uint8Array(70_000);
    expect(hex(packPreorderedBinaryPayload(huge)).slice(0, 16)).toBe('03c90001117174' + '01');
  });

  test('a Buffer on the preordered path keeps the msgpack bin form msgpackr writes for it; the canonical path folds it into Uint8Array', () => {
    expect(hex(packPreorderedBinaryPayload(Buffer.from([1, 2, 3, 4, 5])))).toBe('03c4050102030405');
    expect(hex(encodeBinaryPayload(Buffer.from([1, 2, 3, 4, 5])))).toBe('03c70674010102030405');
  });

  test('a frame with a byte payload round-trips to a Uint8Array with identical bytes', () => {
    const payload = new Uint8Array(3525).map((_, index) => (index * 31) & 0xff);
    const encoded = encodeBinaryPayload({ payload, encSeq: 1, type: 'entity_inputs' });
    const decoded = decodeBinaryPayload(encoded) as { payload: Uint8Array; encSeq: number };
    expect(decoded.payload).toBeInstanceOf(Uint8Array);
    expect(hex(decoded.payload)).toBe(hex(payload));
    expect(decoded.encSeq).toBe(1);
    // Re-encoding the decoded frame reproduces the bytes a peer MACs.
    expect(hex(encodeBinaryPayload({ payload: decoded.payload, encSeq: decoded.encSeq, type: 'entity_inputs' }))).toBe(hex(encoded));
  });

  // The storage frame hash and its WAL row pack one canonical input log.
  test('shared projection keeps every frame-hash and row byte and projects the shared log once', () => {
    const headers = Array.from({ length: 64 }, (_, index) => ({
      jHeight: index + 1,
      jBlockHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
    }));
    const log = canonicalizeBinaryPayload({ headers, label: 'observeJRange', amount: 7n }, { omitSymbolKeys: true });
    const frameHash = `0x${'ab'.repeat(32)}`;
    const hashDomain = (): Uint8Array => encodeBinaryPayload({ kind: 'frame', log }, { omitSymbolKeys: true });
    const row = (): Uint8Array => packPreorderedBinaryPayload({ log, frameHash });
    const separate = [hashDomain(), row()].map(hex);
    expect(withSharedBinaryProjection(() => [hashDomain(), row()].map(hex))).toEqual(separate);

    // Discriminating: inside one block the second pack reuses the first
    // projection, so a (forbidden) mid-block edit is not re-read; outside
    // the block nothing is cached.
    const edited = `0x${'cd'.repeat(32)}`;
    const shared = withSharedBinaryProjection(() => {
      const first = hex(row());
      (log.headers[0] as { jBlockHash: string }).jBlockHash = edited;
      return [first, hex(row())];
    });
    expect(shared[1]).toBe(shared[0]);
    expect(shared[0]).not.toContain('cd'.repeat(32));
    expect(hex(row())).toContain('cd'.repeat(32));
  });
});
