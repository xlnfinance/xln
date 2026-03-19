import { describe, expect, test } from 'bun:test';
import { validateEnvelope } from '../htlc-envelope-types';

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
        innerEnvelope: 'x'.repeat(3000),
        forwardAmount: '1',
      }),
    ).toThrow(/Envelope exceeds 2048 bytes/);
  });
});
