import { describe, expect, test } from 'bun:test';

import { wireDebug } from '../../frontend/src/lib/utils/wireDebug';

describe('browser wire debug surface', () => {
  test('decodes exact peer and rAdapter wire values without changing production codecs', () => {
    const peer = wireDebug.encodeWs({ type: 'ping' });
    expect(wireDebug.protocolVersion).toBe(1);
    expect(wireDebug.decode(peer)).toEqual({ type: 'ping', v: 1 });
    expect(wireDebug.decodeWs(peer)).toEqual({ type: 'ping' });

    const adapter = wireDebug.encodeRadapter({ v: 1, op: 'tick', height: 9 });
    expect(wireDebug.decodeRadapter(adapter)).toEqual({ v: 1, op: 'tick', height: 9 });
  });

  test('keeps tagged JSON readable and BigInt-safe', () => {
    const json = wireDebug.stringifyJson({ amount: 7n });
    expect(json).toContain('"__xlnType":"BigInt"');
    expect(wireDebug.parseJson(json)).toEqual({ amount: 7n });
  });
});
