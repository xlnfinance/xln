import { describe, expect, test } from 'bun:test';
import { createOnionEnvelopes, validateEnvelope } from '../htlc-envelope-types';

describe('htlc envelope validation', () => {
  test('rejects oversized final recipient envelope payload', () => {
    expect(() =>
      validateEnvelope({
        finalRecipient: true,
        secret: 's',
        description: 'x'.repeat(3000),
      }),
    ).toThrow(/Envelope exceeds 2048 bytes|description exceeds 256 characters/);
  });

  test('rejects oversized intermediary envelope payload', () => {
    expect(() =>
      validateEnvelope({
        nextHop: '0x' + '1'.repeat(64),
        innerEnvelope: 'x'.repeat(11000),
        forwardAmount: '1',
      }),
    ).toThrow(/Envelope exceeds 10000 bytes/);
  });

  test('rejects routes above the configured HTLC hop limit', async () => {
    const route = Array.from({ length: 102 }, (_, index) => `entity-${index}`);

    await expect(createOnionEnvelopes(route, 'secret')).rejects.toThrow('101 hops > MAX_HOPS (100)');
  });
});
