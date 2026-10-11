import { describe, expect, test } from 'bun:test';
import {
  canonicalizeBinaryPayload,
  canonicalConsensusValuesEqual,
  decodeBinaryPayload,
  encodeBinaryPayload,
  encodeCanonicalConsensusBytes,
  packPreorderedBinaryPayload,
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
});
