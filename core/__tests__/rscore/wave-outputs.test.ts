import { describe, expect, test } from 'bun:test';

import { packWireValue, unpackWireValue, type RscoreWireValue } from '../../rscore/client';
import { decodeWaveOutputForTests, waveOutputRow, waveOutputWireForTests } from '../../rscore/wave-decode';

/**
 * Outputs are the part of a wave the runtime acts on outside the account: a
 * forward becomes the next hop's payment, a revealed secret settles an
 * upstream lock. Decoding them positionally would let a shifted field travel
 * as a route or an amount, so every variant is read by name — and every
 * variant must re-encode to the bytes it came from, because the wave's parity
 * digest is computed over exactly those bytes.
 *
 * Parity target: `account_output` in crates/process/src/wire_encode.rs.
 */

const OFFER: RscoreWireValue[] = [
  3, 'offer-1', `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`,
  1, 6, '1000000', 2, 6, '2000000', '0', '1900000', '20000', 1, 0, 7, '5', '6',
];

const CASES: { name: string; wire: RscoreWireValue[]; row: unknown[] }[] = [
  {
    name: 'directPaymentForward',
    wire: [0, 1, '25', [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`], 'memo', 1, `0x${'aa'.repeat(32)}`],
    row: ['forward', 1, '25', [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`], 'memo', 'trusted', `0x${'aa'.repeat(32)}`],
  },
  {
    name: 'directPaymentForward/no description',
    wire: [0, 1, '25', [`0x${'aa'.repeat(32)}`], null, 1, `0x${'aa'.repeat(32)}`],
    row: ['forward', 1, '25', [`0x${'aa'.repeat(32)}`], null, 'trusted', `0x${'aa'.repeat(32)}`],
  },
  {
    name: 'htlcSecret',
    wire: [1, 'lock-1', `0x${'ab'.repeat(32)}`, `0x${'cd'.repeat(32)}`, 1, '500'],
    row: ['secret', 'lock-1', `0x${'ab'.repeat(32)}`, `0x${'cd'.repeat(32)}`, 1, '500'],
  },
  {
    name: 'htlcError',
    wire: [2, 'lock-1', `0x${'ab'.repeat(32)}`, 1, '500', 'expired'],
    row: ['error', 'lock-1', `0x${'ab'.repeat(32)}`, 1, '500', 'expired'],
  },
  {
    name: 'htlcError/no reason',
    wire: [2, 'lock-1', `0x${'ab'.repeat(32)}`, 1, '500', null],
    row: ['error', 'lock-1', `0x${'ab'.repeat(32)}`, 1, '500', null],
  },
  {
    name: 'swapOfferUpsert',
    wire: OFFER,
    row: [
      'offerUpsert', 'offer-1', `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`,
      1, 6, '1000000', 2, 6, '2000000', '0', '1900000', '20000', 1, 0, 7, '5', '6',
    ],
  },
  {
    name: 'swapOfferUpsert/no time in force',
    wire: [...OFFER.slice(0, 13), null, ...OFFER.slice(14)],
    row: [
      'offerUpsert', 'offer-1', `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`,
      1, 6, '1000000', 2, 6, '2000000', '0', '1900000', '20000', null, 0, 7, '5', '6',
    ],
  },
  { name: 'swapOfferRemove', wire: [4, 'offer-1'], row: ['offerRemove', 'offer-1'] },
  { name: 'swapCancelRequest', wire: [5, 'offer-1'], row: ['cancelRequest', 'offer-1'] },
];

describe('wave outputs', () => {
  test('the wire refuses integers MessagePack cannot represent exactly', () => {
    expect(unpackWireValue(packWireValue(0xffff_ffff_ffff_ffffn)))
      .toBe(0xffff_ffff_ffff_ffffn);
    expect(unpackWireValue(packWireValue(-0x8000_0000_0000_0000n)))
      .toBe(-0x8000_0000_0000_0000n);
    expect(() => packWireValue(0x1_0000_0000_0000_0000n))
      .toThrow('RSCORE_CLIENT_INTEGER_RANGE');
    expect(() => packWireValue(-0x8000_0000_0000_0001n))
      .toThrow('RSCORE_CLIENT_INTEGER_RANGE');
    expect(() => packWireValue(Number.MAX_SAFE_INTEGER + 1))
      .toThrow('RSCORE_CLIENT_INTEGER_UNSAFE');
  });

  test('every variant decodes into the row TypeScript compares against', () => {
    for (const { name, wire, row } of CASES) {
      const decoded = decodeWaveOutputForTests(unpackWireValue(packWireValue(wire)));
      expect({ name, row: waveOutputRow(decoded) }).toEqual({ name, row: row as never });
    }
  });

  test('every variant re-encodes to the bytes it arrived as', () => {
    for (const { name, wire } of CASES) {
      const bytes = packWireValue(wire);
      const decoded = decodeWaveOutputForTests(unpackWireValue(bytes));
      expect(`${name}:${packWireValue(waveOutputWireForTests(decoded)).toString('hex')}`)
        .toBe(`${name}:${bytes.toString('hex')}`);
    }
  });

  test('a field of the wrong arity or kind is refused, never read past', () => {
    // One field short: the old positional reader would have taken the next
    // variant's field as this one's.
    expect(() => decodeWaveOutputForTests([1, 'lock-1', `0x${'ab'.repeat(32)}`, `0x${'cd'.repeat(32)}`, 1]))
      .toThrow('output.htlcSecret:arity:5:6');
    // A forward can only be trusted: that is what the transition emits it for.
    expect(() => decodeWaveOutputForTests([0, 1, '25', [], null, 0, `0x${'aa'.repeat(32)}`]))
      .toThrow('output.deliveryMode:0');
    expect(() => decodeWaveOutputForTests([9, 'offer-1'])).toThrow('output.tag:9');
  });
});
