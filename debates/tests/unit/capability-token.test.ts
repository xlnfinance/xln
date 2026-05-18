import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { deriveDebatesCapabilityToken } from '../../xln-client';

const decode = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');

describe('deriveDebatesCapabilityToken', () => {
  test('encodes role, expiry, audience, key id, token id, and HMAC signature', () => {
    const token = deriveDebatesCapabilityToken('seed-1', 'full', 123456, {
      audience: 'DEBATES.SERVICE',
      keyId: 'debates-test',
      tokenId: 'tok-1',
    });
    const parts = token.split('.');
    expect(parts).toHaveLength(7);
    expect(parts[0]).toBe('xlnra1');
    expect(parts[1]).toBe('full');
    expect(parts[2]).toBe('123456');
    expect(decode(parts[3]!)).toBe('debates.service');
    expect(decode(parts[4]!)).toBe('debates-test');
    expect(decode(parts[5]!)).toBe('tok-1');

    const payload = 'xln-radapter-v1:cap:admin:123456:debates.service:debates-test:tok-1';
    expect(parts[6]).toBe(createHmac('sha256', 'seed-1').update(payload).digest('hex'));
  });

  test('separates read and full capability levels', () => {
    const read = deriveDebatesCapabilityToken('seed-1', 'read', 123456, {
      audience: 'debates.service',
      keyId: 'debates-test',
      tokenId: 'tok-1',
    });
    const full = deriveDebatesCapabilityToken('seed-1', 'full', 123456, {
      audience: 'debates.service',
      keyId: 'debates-test',
      tokenId: 'tok-1',
    });

    expect(read.split('.')[1]).toBe('read');
    expect(full.split('.')[1]).toBe('full');
    expect(read.split('.')[6]).not.toBe(full.split('.')[6]);
  });
});
