import { describe, expect, test } from 'bun:test';
import { LIMITS } from '../../../config/constants';
import { createOnionEnvelopes, validateEnvelope } from '../../../protocol/htlc/codec/envelope';
import { decodeAccountTx } from '../../../account/tx-validation';

describe('htlc envelope validation', () => {
  test('rejects oversized final recipient envelope payload', () => {
    expect(() =>
      validateEnvelope({
        finalRecipient: true,
        secret: `0x${'ab'.repeat(32)}`,
        description: 'x'.repeat(3000),
      }),
    ).toThrow('Envelope description exceeds 256 UTF-8 bytes');
  });

  test('measures the final description in UTF-8 bytes, like the prepared context and Rust', () => {
    const final = (description: string) => ({
      finalRecipient: true as const,
      secret: `0x${'ab'.repeat(32)}`,
      description,
    });
    // 85 x 3-byte euro = 255 bytes: inside the prepared-context limit.
    expect(validateEnvelope(final('€'.repeat(85)))).toBe(true);
    // 86 UTF-16 units but 258 bytes. Counting units admitted this, then the
    // recipient's own prepared context threw HTLC_PREPARED_DESCRIPTION_INVALID.
    expect(() => validateEnvelope(final('€'.repeat(86))))
      .toThrow('Envelope description exceeds 256 UTF-8 bytes');
  });

  test('rejects oversized intermediary envelope payload', () => {
    expect(() =>
      validateEnvelope({
        nextHop: '0x' + '1'.repeat(64),
        innerEnvelope: {
          version: 'xln:htlc-opaque:aes-gcm',
          ciphertext: 'x'.repeat(LIMITS.MAX_FRAME_SIZE_BYTES + 1),
        },
        forwardAmount: '1',
      }),
    ).toThrow(`Envelope exceeds ${LIMITS.MAX_FRAME_SIZE_BYTES} bytes`);
  });

  test('rejects routes above the configured HTLC hop limit', async () => {
    const route = Array.from({ length: 102 }, (_, index) => `entity-${index}`);

    await expect(createOnionEnvelopes(route, 'secret')).rejects.toThrow('101 hops > MAX_HOPS (100)');
  });

  test('rejects non-canonical uppercase Account hashlocks', () => {
    expect(() => decodeAccountTx({
      type: 'htlc_lock',
      data: {
        lockId: `0x${'11'.repeat(32)}`,
        hashlock: `0x${'AB'.repeat(32)}`,
        timelock: 60_000n,
        revealBeforeHeight: 100,
        amount: 1n,
        tokenId: 1,
      },
    }, 'ACCOUNT_TX')).toThrow('ACCOUNT_TX_DATA_HASHLOCK');
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
      .rejects.toThrow('Onion envelope encryption requires Entity keys, aligned Account domains, amounts, lock binding, and proposer entropy');
    await expect(createOnionEnvelopes(
      route,
      `0x${'55'.repeat(32)}`,
      new Map(),
      [{ chainId: 31337, depositoryAddress: `0x${'66'.repeat(20)}` }],
      new Map(),
      undefined,
      1,
      binding,
      () => `0x${'77'.repeat(32)}`,
    )).rejects.toThrow(`Missing Entity encryption key for final recipient ${route[1]}`);
  });
});
