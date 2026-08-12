import { describe, expect, test } from 'bun:test';

import { decodeBase64Bytes, encodeBase64Bytes } from '../../../protocol/serialization/base64';

describe('canonical protocol Base64', () => {
  test('round-trips protocol bytes with one padded spelling', () => {
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255]);
    const encoded = encodeBase64Bytes(bytes);

    expect(encoded).toBe('AAECf4D/');
    expect(decodeBase64Bytes(encoded)).toEqual(bytes);
  });

  test('rejects permissive decoder spellings at the trust boundary', () => {
    for (const malformed of ['A', 'AA=', 'AA===', 'AA-_', ' AA==', 'AA==\n']) {
      expect(() => decodeBase64Bytes(malformed)).toThrow('PROTOCOL_BASE64_INVALID');
    }
  });
});
