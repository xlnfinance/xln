import { describe, expect, test } from 'bun:test';

import { entityCommandNoncesWire } from '../../../rscore/entity/command-nonce-wire';
import type { EntityCommandNonceState } from '../../../types/entity-tx';

describe('resident Entity command nonce snapshot wire', () => {
  test('encodes the exact optional bounded state in stable signer order', () => {
    expect(entityCommandNoncesWire(undefined)).toBeNull();
    const state: EntityCommandNonceState = {
      version: 1,
      boardHash: `0x${'aa'.repeat(32)}`,
      boardEpoch: 7,
      bySigner: new Map([
        ['signer-2', { nonce: 9n, commandHash: `0x${'cc'.repeat(32)}` }],
        ['signer-1', { nonce: 8n, commandHash: `0x${'bb'.repeat(32)}` }],
      ]),
    };

    const wire = entityCommandNoncesWire(state)!;
    expect(wire.slice(0, 1)).toEqual([1]);
    expect(Buffer.from(wire[1] as Uint8Array).toString('hex')).toBe('aa'.repeat(32));
    expect(wire[2]).toBe(7);
    const rows = wire[3] as unknown[][];
    expect(rows.map(row => row.slice(0, 2))).toEqual([
      ['signer-1', '8'],
      ['signer-2', '9'],
    ]);
    expect(Buffer.from(rows[0]![2] as Uint8Array).toString('hex')).toBe('bb'.repeat(32));
    expect(Buffer.from(rows[1]![2] as Uint8Array).toString('hex')).toBe('cc'.repeat(32));
  });
});
