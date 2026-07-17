import { LIMITS } from '../../constants';
import {
  HTLC_MULTI_RECIPIENT_VERSION,
  type MultiRecipientCiphertext,
} from './multi-recipient';
import {
  VALIDATOR_ENCRYPTION_ATTESTATION_VERSION,
} from './validator-encryption';
import {
  BinaryReader,
  BinaryWriter,
  MAX_HTLC_BINARY_LAYER_BYTES,
  base64ToRawBytes,
  hexToRawBytes,
  rawBytesToBase64,
  rawBytesToHex,
} from './binary-codec';

const CIPHERTEXT_MAGIC = Uint8Array.of(0x58, 0x4c, 0x4d, 0x52); // XLMR
const ONION_MAGIC = Uint8Array.of(0x58, 0x4c, 0x4f, 0x4e); // XLON
const SECRET_OFFER_MAGIC = Uint8Array.of(0x58, 0x4c, 0x53, 0x4f); // XLSO
const CIPHERTEXT_CODEC_VERSION = 1;
const ONION_CODEC_VERSION = 2;
const SECRET_OFFER_CODEC_VERSION = 2;
const FINAL_LAYER = 1;
const FORWARD_LAYER = 2;
const MAX_UINT256 = (1n << 256n) - 1n;

export type DecodedOnionLayer = Readonly<{
  finalRecipient: true;
  secretOffer: MultiRecipientCiphertext;
  description?: string;
  startedAtMs?: number;
}> | Readonly<{
  nextHop: string;
  innerEnvelope: MultiRecipientCiphertext;
  forwardAmount: string;
}>;

export type DecodedHtlcSecretOffer = Readonly<{
  secret: string;
}>;

const requireCount = (value: number, code: string): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS.MAX_VALIDATORS) {
    throw new Error(code);
  }
  return value;
};

const expectMagic = (reader: BinaryReader, expected: Uint8Array, code: string): void => {
  const actual = reader.raw(expected.length);
  if (actual.some((byte, index) => byte !== expected[index])) throw new Error(code);
};

const uint256Bytes = (value: bigint, code: string): Uint8Array => {
  if (value <= 0n || value > MAX_UINT256) throw new Error(code);
  return hexToRawBytes(`0x${value.toString(16).padStart(64, '0')}`, code, 32);
};

const bytesToUint256 = (bytes: Uint8Array): bigint => BigInt(rawBytesToHex(bytes));

/**
 * Encode the nested recipient envelope without recursively base64-encoding its
 * tail. Base64 remains the outer transport representation used by the existing
 * ciphertext object; every nested binary field is length-delimited exactly once.
 */
export const encodeMultiRecipientCiphertext = (
  value: MultiRecipientCiphertext,
): Uint8Array => {
  const writer = new BinaryWriter(MAX_HTLC_BINARY_LAYER_BYTES, 'HTLC_CIPHERTEXT_BINARY_TOO_LARGE');
  writer.raw(CIPHERTEXT_MAGIC);
  writer.u8(CIPHERTEXT_CODEC_VERSION);
  writer.text(value.manifest.entityId);
  writer.u16(value.manifest.threshold);
  writer.u16(requireCount(value.manifest.attestations.length, 'HTLC_CIPHERTEXT_ATTESTATION_COUNT_INVALID'));
  for (const attestation of value.manifest.attestations) {
    writer.text(attestation.signerId);
    writer.raw(hexToRawBytes(attestation.signer, 'HTLC_CIPHERTEXT_SIGNER_INVALID', 20));
    const publicKey = hexToRawBytes(attestation.publicKey, 'HTLC_CIPHERTEXT_PUBLIC_KEY_INVALID');
    if (publicKey.length !== 33 && publicKey.length !== 65) {
      throw new Error('HTLC_CIPHERTEXT_PUBLIC_KEY_INVALID');
    }
    writer.u8(publicKey.length);
    writer.raw(publicKey);
    writer.u16(attestation.weight);
    writer.raw(hexToRawBytes(
      attestation.encryptionPublicKey,
      'HTLC_CIPHERTEXT_ENCRYPTION_KEY_INVALID',
      32,
    ));
    writer.raw(hexToRawBytes(attestation.signature, 'HTLC_CIPHERTEXT_ATTESTATION_SIGNATURE_INVALID', 65));
  }
  writer.raw(hexToRawBytes(value.manifest.hash, 'HTLC_CIPHERTEXT_MANIFEST_HASH_INVALID', 32));
  writer.raw(hexToRawBytes(value.profileCertification.profileHash, 'HTLC_CIPHERTEXT_PROFILE_HASH_INVALID', 32));
  writer.raw(hexToRawBytes(
    value.profileCertification.routingStateHash,
    'HTLC_CIPHERTEXT_ROUTING_HASH_INVALID',
    32,
  ));
  writer.sized(hexToRawBytes(value.profileCertification.hanko, 'HTLC_CIPHERTEXT_PROFILE_HANKO_INVALID'));
  writer.raw(hexToRawBytes(value.contextHash, 'HTLC_CIPHERTEXT_CONTEXT_HASH_INVALID', 32));
  writer.raw(base64ToRawBytes(value.nonce, 'HTLC_CIPHERTEXT_NONCE_INVALID'));
  writer.sized(base64ToRawBytes(value.ciphertext, 'HTLC_CIPHERTEXT_BODY_INVALID'));
  writer.u16(requireCount(value.recipients.length, 'HTLC_CIPHERTEXT_RECIPIENT_COUNT_INVALID'));
  for (const recipient of value.recipients) {
    writer.text(recipient.signerId);
    writer.raw(hexToRawBytes(recipient.encryptionPublicKey, 'HTLC_CIPHERTEXT_RECIPIENT_KEY_INVALID', 32));
    writer.sized(base64ToRawBytes(recipient.wrappedKey, 'HTLC_CIPHERTEXT_WRAPPED_KEY_INVALID'));
  }
  return writer.finish();
};

export const decodeMultiRecipientCiphertext = (
  encoded: Uint8Array,
): MultiRecipientCiphertext => {
  const code = 'HTLC_CIPHERTEXT_BINARY_INVALID';
  const reader = new BinaryReader(encoded, MAX_HTLC_BINARY_LAYER_BYTES, code);
  expectMagic(reader, CIPHERTEXT_MAGIC, code);
  if (reader.u8() !== CIPHERTEXT_CODEC_VERSION) throw new Error('HTLC_CIPHERTEXT_BINARY_VERSION_INVALID');
  const entityId = reader.text();
  const threshold = reader.u16();
  const attestationCount = requireCount(reader.u16(), 'HTLC_CIPHERTEXT_ATTESTATION_COUNT_INVALID');
  const attestations = Array.from({ length: attestationCount }, () => {
    const signerId = reader.text();
    const signer = rawBytesToHex(reader.raw(20));
    const publicKeyLength = reader.u8();
    if (publicKeyLength !== 33 && publicKeyLength !== 65) throw new Error(code);
    return {
      version: VALIDATOR_ENCRYPTION_ATTESTATION_VERSION,
      entityId,
      signerId,
      signer,
      publicKey: rawBytesToHex(reader.raw(publicKeyLength)),
      weight: reader.u16(),
      encryptionPublicKey: rawBytesToHex(reader.raw(32)),
      signature: rawBytesToHex(reader.raw(65)),
    };
  });
  const hash = rawBytesToHex(reader.raw(32));
  const profileHash = rawBytesToHex(reader.raw(32));
  const routingStateHash = rawBytesToHex(reader.raw(32));
  const hanko = rawBytesToHex(reader.sized());
  const contextHash = rawBytesToHex(reader.raw(32));
  const nonce = rawBytesToBase64(reader.raw(12));
  const ciphertext = rawBytesToBase64(reader.sized());
  const recipientCount = requireCount(reader.u16(), 'HTLC_CIPHERTEXT_RECIPIENT_COUNT_INVALID');
  const recipients = Array.from({ length: recipientCount }, () => ({
    signerId: reader.text(),
    encryptionPublicKey: rawBytesToHex(reader.raw(32)),
    wrappedKey: rawBytesToBase64(reader.sized()),
  }));
  reader.done();
  return {
    version: HTLC_MULTI_RECIPIENT_VERSION,
    manifest: { entityId, threshold, attestations, hash },
    profileCertification: { profileHash, routingStateHash, hanko },
    contextHash,
    nonce,
    ciphertext,
    recipients,
  };
};

export const encodeHtlcSecretOffer = (offer: DecodedHtlcSecretOffer): Uint8Array => {
  const writer = new BinaryWriter(MAX_HTLC_BINARY_LAYER_BYTES, 'HTLC_SECRET_OFFER_TOO_LARGE');
  writer.raw(SECRET_OFFER_MAGIC);
  writer.u8(SECRET_OFFER_CODEC_VERSION);
  writer.raw(hexToRawBytes(offer.secret, 'HTLC_SECRET_OFFER_SECRET_INVALID', 32));
  return writer.finish();
};

export const decodeHtlcSecretOffer = (encoded: Uint8Array): DecodedHtlcSecretOffer => {
  const code = 'HTLC_SECRET_OFFER_INVALID';
  const reader = new BinaryReader(encoded, MAX_HTLC_BINARY_LAYER_BYTES, code);
  expectMagic(reader, SECRET_OFFER_MAGIC, code);
  if (reader.u8() !== SECRET_OFFER_CODEC_VERSION) throw new Error('HTLC_SECRET_OFFER_VERSION_INVALID');
  const secret = rawBytesToHex(reader.raw(32));
  reader.done();
  return { secret };
};

export const encodeOnionLayer = (layer: DecodedOnionLayer): Uint8Array => {
  const writer = new BinaryWriter(MAX_HTLC_BINARY_LAYER_BYTES, 'HTLC_ONION_LAYER_TOO_LARGE');
  writer.raw(ONION_MAGIC);
  writer.u8(ONION_CODEC_VERSION);
  if ('finalRecipient' in layer) {
    writer.u8(FINAL_LAYER);
    writer.sized(encodeMultiRecipientCiphertext(layer.secretOffer));
    const flags = (layer.description !== undefined ? 1 : 0) | (layer.startedAtMs !== undefined ? 2 : 0);
    writer.u8(flags);
    if (layer.description !== undefined) writer.text(layer.description);
    if (layer.startedAtMs !== undefined) {
      if (!Number.isSafeInteger(layer.startedAtMs) || layer.startedAtMs <= 0) {
        throw new Error('HTLC_ONION_STARTED_AT_INVALID');
      }
      writer.u64(BigInt(layer.startedAtMs));
    }
  } else {
    writer.u8(FORWARD_LAYER);
    writer.text(layer.nextHop);
    writer.raw(uint256Bytes(BigInt(layer.forwardAmount), 'HTLC_ONION_FORWARD_AMOUNT_INVALID'));
    writer.sized(encodeMultiRecipientCiphertext(layer.innerEnvelope));
  }
  return writer.finish();
};

export const decodeOnionLayer = (encoded: Uint8Array): DecodedOnionLayer => {
  const code = 'HTLC_ONION_LAYER_INVALID';
  const reader = new BinaryReader(encoded, MAX_HTLC_BINARY_LAYER_BYTES, code);
  expectMagic(reader, ONION_MAGIC, code);
  if (reader.u8() !== ONION_CODEC_VERSION) throw new Error('HTLC_ONION_LAYER_VERSION_INVALID');
  const kind = reader.u8();
  if (kind === FINAL_LAYER) {
    const secretOffer = decodeMultiRecipientCiphertext(reader.sized());
    const flags = reader.u8();
    if ((flags & ~3) !== 0) throw new Error(code);
    const description = (flags & 1) !== 0 ? reader.text() : undefined;
    const rawStartedAt = (flags & 2) !== 0 ? reader.u64() : undefined;
    if (rawStartedAt !== undefined && rawStartedAt > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(code);
    reader.done();
    return {
      finalRecipient: true,
      secretOffer,
      ...(description !== undefined ? { description } : {}),
      ...(rawStartedAt !== undefined ? { startedAtMs: Number(rawStartedAt) } : {}),
    };
  }
  if (kind !== FORWARD_LAYER) throw new Error(code);
  const nextHop = reader.text();
  const amount = bytesToUint256(reader.raw(32));
  if (amount <= 0n) throw new Error(code);
  const innerEnvelope = decodeMultiRecipientCiphertext(reader.sized());
  reader.done();
  return { nextHop, innerEnvelope, forwardAmount: amount.toString() };
};
