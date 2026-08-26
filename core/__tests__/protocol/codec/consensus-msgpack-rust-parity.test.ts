import { describe, expect, test } from 'bun:test';

import { encodeCanonicalConsensusBytes } from '../../../protocol/serialization/binary-codec';

const hex = (value: unknown): string =>
  Buffer.from(encodeCanonicalConsensusBytes(value)).toString('hex');

describe('Rust canonical consensus MessagePack parity', () => {
  test('pins objects, maps, sets and bigint record bytes', () => {
    expect(hex({
      version: 1,
      object: { z: 2, a: 'x' },
      map: new Map([['z', 2n], ['a', 1n]]),
      set: new Set(['z', 'a']),
      bigint: 12_345_678_901_234_567_890n,
    })).toBe(
      'd4724095a6626967696e74a36d6170a66f626a656374a3736574a776657273696f6e' +
      'cfab54a98ceb1f0ad282a161d30000000000000001a17ad30000000000000002' +
      'd4724192a161a17aa17802d4730092a161a17a01',
    );
  });

  test('pins numeric boundaries and record reuse', () => {
    expect(hex([
      63,
      64,
      4_294_967_296,
      18_446_744_073_709_551_615n,
      18_446_744_073_709_551_616n,
      -9_223_372_036_854_775_809n,
    ])).toBe(
      '963fcc40cb41f0000000000000cfffffffffffffffffd8420000000000000001' +
      '0000000000000000d842ffffffffffffffff7fffffffffffffff',
    );
    expect(hex([{ x: 1 }, { x: 2 }])).toBe('92d4724091a178014002');
  });
});
