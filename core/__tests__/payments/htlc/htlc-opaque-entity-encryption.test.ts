import { describe, expect, test } from 'bun:test';
import { x25519 } from '@noble/curves/ed25519.js';
import { getBytes } from 'ethers';
import { createOnionEnvelopes, computeHtlcEnvelopeContextHash, deriveHtlcLockIdAtHop, unwrapEnvelope } from '../../../protocol/htlc/codec/envelope';
import { assertOpaqueHtlcCiphertext, decryptOpaqueHtlcBytes, hashOpaqueHtlcCiphertext } from '../../../protocol/htlc/multi-recipient';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const hex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
const entity = (byte: string): string => `0x${byte.repeat(64)}`;
const domain = { chainId: 31337, depositoryAddress: `0x${'11'.repeat(20)}` };

describe('opaque Entity HTLC encryption', () => {
  test('recreates exact ciphertext and domain-separates payment bindings', async () => {
    const sourceSecret = `0x${'21'.repeat(32)}`;
    const recipientSecret = `0x${'31'.repeat(32)}`;
    const recipientPublic = hex(x25519.getPublicKey(getBytes(recipientSecret)));
    const route = [entity('a'), entity('b')];
    const binding = {
      rootLockId: `0x${'41'.repeat(32)}`, hashlock: `0x${'51'.repeat(32)}`, tokenId: 1,
      senderLockAmount: 10n, timelock: 100_000n, revealBeforeHeight: 100,
    };
    const build = (lockId = binding.rootLockId) => createOnionEnvelopes(
      route, `0x${'81'.repeat(32)}`, new Map([[route[0]!, hex(x25519.getPublicKey(getBytes(sourceSecret)))], [route[1]!, recipientPublic]]),
      [domain], new Map(), undefined, 1, { ...binding, rootLockId: lockId }, () => sourceSecret,
    );
    const first = await build();
    expect(await build()).toEqual(first);
    expect(await build(`0x${'42'.repeat(32)}`)).not.toEqual(first);
    const contextHash = computeHtlcEnvelopeContextHash({
      fromEntityId: route[0]!, toEntityId: route[1]!, domain, lockId: binding.rootLockId,
      hashlock: binding.hashlock, tokenId: 1, amount: 10n, timelock: 100_000n, revealBeforeHeight: 100,
    });
    expect(unwrapEnvelope(decryptOpaqueHtlcBytes(first, recipientPublic, recipientSecret, contextHash))).toEqual({
      finalRecipient: true,
      secret: `0x${'81'.repeat(32)}`,
      startedAtMs: 1,
    });
    expect(JSON.stringify(first)).not.toContain(sourceSecret.slice(2));
  });

  test('intermediary cannot decrypt the final preimage before target disclosure', async () => {
    const source = entity('a');
    const hub = entity('b');
    const target = entity('c');
    const sourceSecret = `0x${'21'.repeat(32)}`;
    const hubSecret = `0x${'31'.repeat(32)}`;
    const targetSecret = `0x${'41'.repeat(32)}`;
    const publicKeys = new Map([
      [source, hex(x25519.getPublicKey(getBytes(sourceSecret)))],
      [hub, hex(x25519.getPublicKey(getBytes(hubSecret)))],
      [target, hex(x25519.getPublicKey(getBytes(targetSecret)))],
    ]);
    const binding = {
      rootLockId: `0x${'51'.repeat(32)}`, hashlock: `0x${'61'.repeat(32)}`, tokenId: 1,
      senderLockAmount: 10n, timelock: 100_000n, revealBeforeHeight: 100,
    };
    const preimage = `0x${'71'.repeat(32)}`;
    const encrypted = await createOnionEnvelopes(
      [source, hub, target], preimage, publicKeys, [domain, domain],
      new Map([[hub, 9n]]), undefined, 1, binding, () => sourceSecret,
    );
    const hubLayer = unwrapEnvelope(decryptOpaqueHtlcBytes(
      encrypted, publicKeys.get(hub)!, hubSecret,
      computeHtlcEnvelopeContextHash({
        fromEntityId: source, toEntityId: hub, domain, lockId: binding.rootLockId,
        hashlock: binding.hashlock, tokenId: 1, amount: 10n, timelock: 100_000n, revealBeforeHeight: 100,
      }),
    ));
    expect('finalRecipient' in hubLayer).toBe(false);
    if ('finalRecipient' in hubLayer) throw new Error('expected intermediary layer');
    expect(Object.keys(hubLayer.innerEnvelope).sort()).toEqual(['ciphertext', 'version']);
    expect(assertOpaqueHtlcCiphertext(hubLayer.innerEnvelope)).toEqual(hubLayer.innerEnvelope);
    expect(JSON.stringify(hubLayer)).not.toContain(preimage.slice(2));
    expect(() => decryptOpaqueHtlcBytes(
      hubLayer.innerEnvelope, publicKeys.get(target)!, hubSecret,
      computeHtlcEnvelopeContextHash({
        fromEntityId: hub, toEntityId: target, domain, lockId: deriveHtlcLockIdAtHop(binding.rootLockId, 2),
        hashlock: binding.hashlock, tokenId: 1, amount: 9n,
        timelock: 100_000n - BigInt(30_000), revealBeforeHeight: 98,
      }),
    )).toThrow('HTLC_ENTITY_ENCRYPTION_KEYPAIR_MISMATCH');
  });

  test('throws loud for local shared-key mismatch', () => {
    const publicKey = hex(x25519.getPublicKey(getBytes(`0x${'21'.repeat(32)}`)));
    expect(() => decryptOpaqueHtlcBytes(
      { version: 'xln:htlc-opaque:v1', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      publicKey, `0x${'31'.repeat(32)}`, `0x${'41'.repeat(32)}`,
    )).toThrow('HTLC_ENTITY_ENCRYPTION_KEYPAIR_MISMATCH');
  });

  test('content-keyed hash memos are byte-identical to a cold hash', () => {
    const opaque = {
      version: 'xln:htlc-opaque:v1' as const,
      ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    const context = {
      fromEntityId: entity('a'), toEntityId: entity('b'), domain, lockId: `0x${'41'.repeat(32)}`,
      hashlock: `0x${'51'.repeat(32)}`, tokenId: 1, amount: 10n, timelock: 100_000n, revealBeforeHeight: 100,
    };
    expect(hashOpaqueHtlcCiphertext(opaque)).toBe(hashOpaqueHtlcCiphertext({ ...opaque }));
    expect(computeHtlcEnvelopeContextHash(context)).toBe(computeHtlcEnvelopeContextHash({ ...context }));
    expect(readFileSync(join(import.meta.dir, '../../../protocol/htlc/multi-recipient.ts'), 'utf8'))
      .toContain('opaqueCiphertextHashMemo');
    expect(readFileSync(join(import.meta.dir, '../../../protocol/htlc/codec/envelope.ts'), 'utf8'))
      .toContain('envelopeContextHashMemo');
  });
});
