import { expect, test } from 'bun:test';
import { SigningKey, computeAddress } from 'ethers';

import {
  deriveSignerKeySync,
  signDigestBytesWithPrivateKey,
} from '../account/crypto';
import { HTLC, LIMITS } from '../constants';
import { generateLazyEntityId } from '../entity/factory';
import { buildQuorumHanko } from '../hanko/signing';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../networking/p2p-crypto';
import { NobleCryptoProvider } from '../protocol/crypto/noble';
import {
  computeHtlcEnvelopeContextHash,
  createOnionEnvelopes,
} from '../protocol/htlc/envelope';
import { decryptBytesForLocalValidator } from '../protocol/htlc/multi-recipient';
import { decodeOnionLayer } from '../protocol/htlc/onion-codec';
import {
  computeEntityProfileCertificationHash,
  computeValidatorEncryptionAttestationDigest,
  requireCompleteValidatorEncryptionManifest,
  type CertifiedValidatorEncryptionManifest,
} from '../protocol/htlc/validator-encryption';
import type { Env } from '../types';

const bytesHex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;
const bytes32 = (value: number): string => `0x${value.toString(16).padStart(64, '0')}`;

const signDigest = (privateKey: Uint8Array, digest: string): string => {
  const signed = signDigestBytesWithPrivateKey(privateKey, Buffer.from(digest.slice(2), 'hex'));
  return `${bytesHex(signed.signature)}${signed.recovery.toString(16).padStart(2, '0')}`;
};

const certifiedHop = async (
  index: number,
): Promise<{
  entityId: string;
  certification: CertifiedValidatorEncryptionManifest;
  validator: {
    signerId: string;
    signer: string;
    publicKey: string;
    encryptionPublicKey: string;
    encryptionPrivateKey: string;
  };
}> => {
  const privateKey = deriveSignerKeySync('htlc-max-hop-onion', String(index + 1));
  const signingKey = new SigningKey(bytesHex(privateKey));
  const publicKey = signingKey.publicKey.toLowerCase();
  const signer = computeAddress(publicKey).toLowerCase();
  const entityId = generateLazyEntityId([{ name: signer, weight: 1 }], 1n).toLowerCase();
  const encryption = deriveEncryptionKeyPair(`${bytesHex(privateKey)}:${entityId}:htlc-v1`);
  const attestationBody = {
    version: 'xln:validator-encryption-key:v1' as const,
    entityId,
    signerId: signer,
    signer,
    publicKey,
    weight: 1,
    encryptionPublicKey: pubKeyToHex(encryption.publicKey),
  };
  const manifest = requireCompleteValidatorEncryptionManifest(
    {
      entityId,
      threshold: 1,
      validators: [{ signerId: signer, signer, publicKey, weight: 1 }],
    },
    [{
      ...attestationBody,
      signature: signDigest(
        privateKey,
        computeValidatorEncryptionAttestationDigest(attestationBody),
      ),
    }],
  );
  const routingStateHash = bytes32(0xa0 + index);
  const profileHash = computeEntityProfileCertificationHash(manifest.hash, routingStateHash);
  const hanko = await buildQuorumHanko(
    {} as Env,
    entityId,
    profileHash,
    [{ signerId: signer, signature: signDigest(privateKey, profileHash) }],
    { threshold: 1n, validators: [signer], shares: { [signer]: 1n } },
  );
  return {
    entityId,
    certification: {
      manifest,
      recipientSignerId: signer,
      profileCertification: { profileHash, routingStateHash, hanko },
    },
    validator: {
      signerId: signer,
      signer,
      publicKey,
      encryptionPublicKey: pubKeyToHex(encryption.publicKey),
      encryptionPrivateKey: pubKeyToHex(encryption.privateKey),
    },
  };
};

test('every route admitted by MAX_HOPS has a constructible bounded onion', async () => {
  // A route length fence is an admission promise. Recursive JSON containing a
  // base64 ciphertext re-encodes the complete tail at every hop and currently
  // breaks that promise after only a few real certified manifests. The wire
  // codec must grow linearly and base64 only the outer transport value.
  const hops = await Promise.all(
    Array.from({ length: HTLC.MAX_HOPS + 1 }, (_, index) => certifiedHop(index)),
  );
  const route = hops.map(({ entityId }) => entityId);
  const manifests = new Map(
    hops.map(({ entityId, certification }) => [entityId, certification]),
  );
  const hopForwardAmounts = new Map(route.slice(1, -1).map((entityId) => [entityId, 1n]));
  const minimumTimelock = BigInt(HTLC.MIN_TIMELOCK_DELTA_MS * (HTLC.MAX_HOPS + 1));
  const minimumRevealHeight = HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS * (HTLC.MAX_HOPS + 1);

  const rootLockId = bytes32(0x72);
  const hashlock = bytes32(0x73);
  const envelope = await createOnionEnvelopes(
    route,
    bytes32(0x71),
    manifests,
    new NobleCryptoProvider({ deterministicSeed: 'htlc-max-hop-onion' }),
    hopForwardAmounts,
    undefined,
    1,
    {
      rootLockId,
      hashlock,
      tokenId: 1,
      senderLockAmount: 1n,
      timelock: minimumTimelock,
      revealBeforeHeight: minimumRevealHeight,
    },
  );

  expect(envelope.nextHop).toBe(route[1]);
  expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength)
    .toBeLessThanOrEqual(LIMITS.MAX_FRAME_SIZE_BYTES);

  // Exercise the same decode boundary used after each committed account frame.
  // This proves the compact representation is not merely constructible: every
  // independently keyed hop can recover exactly one layer through MAX_HOPS.
  let encryptedLayer = envelope.innerEnvelope!;
  for (let hopIndex = 1; hopIndex < route.length; hopIndex += 1) {
    const hop = hops[hopIndex]!;
    const plaintext = await decryptBytesForLocalValidator(
      encryptedLayer,
      {
        entityId: hop.entityId,
        threshold: 1,
        validators: [{ ...hop.validator, weight: 1 }],
      },
      hop.validator.signerId,
      hop.validator.encryptionPublicKey,
      hop.validator.encryptionPrivateKey,
      computeHtlcEnvelopeContextHash({
        entityId: hop.entityId,
        lockId: `${rootLockId}${'-fwd'.repeat(hopIndex - 1)}`,
        hashlock,
        tokenId: 1,
        amount: 1n,
        timelock: minimumTimelock - BigInt(hopIndex - 1) * BigInt(HTLC.MIN_TIMELOCK_DELTA_MS),
        revealBeforeHeight: minimumRevealHeight
          - (hopIndex - 1) * HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS,
      }),
      new NobleCryptoProvider(),
    );
    const layer = decodeOnionLayer(plaintext);
    if ('finalRecipient' in layer) {
      expect(hopIndex).toBe(HTLC.MAX_HOPS);
      expect(layer).not.toHaveProperty('secret');
      expect(layer.secretOffer.manifest.entityId).toBe(route[route.length - 2]);
      continue;
    }
    expect(layer.nextHop).toBe(route[hopIndex + 1]);
    expect(layer.forwardAmount).toBe('1');
    encryptedLayer = layer.innerEnvelope;
  }
}, 30_000);
