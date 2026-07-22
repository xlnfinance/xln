import { describe, expect, test } from 'bun:test';
import { LIMITS } from '../constants';
import { NobleCryptoProvider } from '../protocol/crypto/noble';
import { createOnionEnvelopes, validateEnvelope } from '../protocol/htlc/envelope';

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
        innerEnvelope: {
          version: 'xln:htlc-multi-recipient:v1',
          manifest: {
            entityId: `0x${'22'.repeat(32)}`,
            threshold: 1,
            attestations: [],
            hash: `0x${'33'.repeat(32)}`,
          },
          profileCertification: {
            profileHash: `0x${'55'.repeat(32)}`,
            routingStateHash: `0x${'66'.repeat(32)}`,
            hanko: '0x01',
          },
          contextHash: `0x${'44'.repeat(32)}`,
          nonce: 'AAAAAAAAAAAAAAAA',
          ciphertext: 'x'.repeat(LIMITS.MAX_FRAME_SIZE_BYTES + 1),
          recipients: [],
        },
        forwardAmount: '1',
      }),
    ).toThrow(`Envelope exceeds ${LIMITS.MAX_FRAME_SIZE_BYTES} bytes`);
  });

  test('rejects routes above the configured HTLC hop limit', async () => {
    const route = Array.from({ length: 102 }, (_, index) => `entity-${index}`);

    await expect(createOnionEnvelopes(route, 'secret')).rejects.toThrow('101 hops > MAX_HOPS (100)');
  });

  test('fails closed when encryption inputs or certified recipient keys are missing', async () => {
    const route = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`];
    const binding = {
      rootLockId: `0x${'33'.repeat(32)}`,
      hashlock: `0x${'44'.repeat(32)}`,
      tokenId: 1,
      senderLockAmount: 1n,
      timelock: 60_000n,
      revealBeforeHeight: 100,
    };

    await expect(createOnionEnvelopes(route, `0x${'55'.repeat(32)}`))
      .rejects.toThrow('Onion envelope encryption requires crypto, certified manifests, amounts, and lock binding');
    await expect(createOnionEnvelopes(
      route,
      `0x${'55'.repeat(32)}`,
      new Map(),
      new NobleCryptoProvider({ deterministicSeed: 'missing-htlc-manifest' }),
      new Map(),
      undefined,
      1,
      binding,
    )).rejects.toThrow(`Missing validator encryption manifest for payer ${route[0]}`);
  });
});
