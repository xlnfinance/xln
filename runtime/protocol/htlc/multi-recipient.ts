import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { CryptoProvider } from '../crypto/provider';
import { serializeTaggedJson } from '../serialization';
import { MAX_HTLC_BINARY_LAYER_BYTES } from './binary-codec';
import { assertExactMultiRecipientCiphertextSchema } from './multi-recipient-schema';
import {
  normalizeValidatorEncryptionPublicKey,
  requireCompleteValidatorEncryptionManifest,
  validateEntityProfileCertificationWitness,
  validateSelfContainedValidatorEncryptionManifest,
  type EntityProfileCertificationWitness,
  type ValidatorEncryptionBoard,
  type ValidatorEncryptionManifest,
} from './validator-encryption';

export const HTLC_MULTI_RECIPIENT_VERSION = 'xln:htlc-multi-recipient:v1' as const;

export type ValidatorWrappedContentKey = Readonly<{
  signerId: string;
  encryptionPublicKey: string;
  wrappedKey: string;
}>;

export type MultiRecipientCiphertext = Readonly<{
  version: typeof HTLC_MULTI_RECIPIENT_VERSION;
  manifest: ValidatorEncryptionManifest;
  profileCertification: EntityProfileCertificationWitness;
  contextHash: string;
  nonce: string;
  ciphertext: string;
  recipients: readonly ValidatorWrappedContentKey[];
}>;

export const isMultiRecipientCiphertext = (value: unknown): value is MultiRecipientCiphertext => {
  try {
    assertExactMultiRecipientCiphertextSchema(value);
    return value.version === HTLC_MULTI_RECIPIENT_VERSION;
  } catch {
    return false;
  }
};

const MAX_HTLC_PLAINTEXT_BYTES = MAX_HTLC_BINARY_LAYER_BYTES;
const MAX_HTLC_CIPHERTEXT_BASE64_CHARS = Math.ceil((MAX_HTLC_PLAINTEXT_BYTES + 16) / 3) * 4;
const MAX_WRAPPED_KEY_BASE64_CHARS = 512;

const normalizeContextHash = (value: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error('HTLC_ENCRYPTION_CONTEXT_HASH_INVALID');
  return normalized;
};

const assertBase64Bound = (value: string, maxChars: number, code: string): void => {
  if (!value || value.length > maxChars || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(code);
  }
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new Error('HTLC_CIPHERTEXT_BASE64_INVALID');
  }
};

const bytesToHex = (bytes: Uint8Array): string => {
  let hex = '0x';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
};

const hexToBytes = (value: string): Uint8Array => {
  if (!/^0x[0-9a-f]{64}$/i.test(value)) throw new Error('HTLC_CONTENT_KEY_INVALID');
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
};

const contentKeyFromGeneratedPair = (privateKey: string): Uint8Array => {
  const bytes = base64ToBytes(privateKey);
  if (bytes.length !== 32) throw new Error(`HTLC_CONTENT_KEY_LENGTH_INVALID: ${bytes.length}`);
  return bytes;
};

const contentNonce = (contentKey: Uint8Array, manifestHash: string, contextHash: string): Uint8Array =>
  sha256(new TextEncoder().encode(
    `${HTLC_MULTI_RECIPIENT_VERSION}:${bytesToHex(contentKey)}:${manifestHash}:${contextHash}`,
  )).slice(0, 12);

const contentAad = (manifestHash: string, contextHash: string): Uint8Array =>
  new TextEncoder().encode(`${HTLC_MULTI_RECIPIENT_VERSION}:${manifestHash}:${contextHash}`);

export const encryptBytesForValidatorManifest = async (
  plaintextBytes: Uint8Array,
  manifest: ValidatorEncryptionManifest,
  profileCertification: EntityProfileCertificationWitness,
  contextHash: string,
  cryptoProvider: CryptoProvider,
  recipientSignerId: string,
): Promise<MultiRecipientCiphertext> => {
  if (plaintextBytes.length > MAX_HTLC_PLAINTEXT_BYTES) throw new Error('HTLC_ENCRYPTION_PLAINTEXT_TOO_LARGE');
  const normalizedContextHash = normalizeContextHash(contextHash);
  const certification = validateEntityProfileCertificationWitness(manifest.hash, profileCertification);
  const generated = await cryptoProvider.generateKeyPair();
  const key = contentKeyFromGeneratedPair(generated.privateKey);
  const nonce = contentNonce(key, manifest.hash, normalizedContextHash);
  const cipher = chacha20poly1305(key, nonce, contentAad(manifest.hash, normalizedContextHash));
  const ciphertext = bytesToBase64(cipher.encrypt(plaintextBytes));
  const normalizedRecipientSignerId = String(recipientSignerId ?? '').trim().toLowerCase();
  const recipientAttestations = manifest.attestations.filter(
    (attestation) => attestation.signerId === normalizedRecipientSignerId,
  );
  if (recipientAttestations.length !== 1) {
    throw new Error(`HTLC_DEFAULT_PROPOSER_ATTESTATION_MATCH: matches=${recipientAttestations.length}`);
  }
  const recipientAttestation = recipientAttestations[0]!;
  const recipients: ValidatorWrappedContentKey[] = [{
    signerId: recipientAttestation.signerId,
    encryptionPublicKey: recipientAttestation.encryptionPublicKey,
    wrappedKey: await cryptoProvider.encrypt(bytesToHex(key), recipientAttestation.encryptionPublicKey),
  }];
  return {
    version: HTLC_MULTI_RECIPIENT_VERSION,
    manifest,
    profileCertification: certification,
    contextHash: normalizedContextHash,
    nonce: bytesToBase64(nonce),
    ciphertext,
    recipients,
  };
};

export const encryptForValidatorManifest = async (
  plaintext: string,
  manifest: ValidatorEncryptionManifest,
  profileCertification: EntityProfileCertificationWitness,
  contextHash: string,
  cryptoProvider: CryptoProvider,
  recipientSignerId: string,
): Promise<MultiRecipientCiphertext> => encryptBytesForValidatorManifest(
  new TextEncoder().encode(plaintext),
  manifest,
  profileCertification,
  contextHash,
  cryptoProvider,
  recipientSignerId,
);

const validateCiphertextRecipients = (
  ciphertext: MultiRecipientCiphertext,
  manifest: ValidatorEncryptionManifest,
  expectedRecipientSignerId?: string,
): ValidatorWrappedContentKey[] => {
  if (ciphertext.version !== HTLC_MULTI_RECIPIENT_VERSION) throw new Error('HTLC_MULTI_RECIPIENT_VERSION_INVALID');
  validateEntityProfileCertificationWitness(manifest.hash, ciphertext.profileCertification);
  assertBase64Bound(ciphertext.ciphertext, MAX_HTLC_CIPHERTEXT_BASE64_CHARS, 'HTLC_CIPHERTEXT_SIZE_INVALID');
  assertBase64Bound(ciphertext.nonce, 16, 'HTLC_CIPHERTEXT_NONCE_INVALID');
  if (ciphertext.manifest.hash !== manifest.hash) throw new Error('HTLC_MULTI_RECIPIENT_MANIFEST_HASH_MISMATCH');
  if (ciphertext.recipients.length !== 1) {
    throw new Error('HTLC_MULTI_RECIPIENT_COUNT_MISMATCH');
  }
  const normalizedExpectedSignerId = expectedRecipientSignerId === undefined
    ? undefined
    : String(expectedRecipientSignerId).trim().toLowerCase();
  return ciphertext.recipients.map((recipient) => {
    const signerId = recipient.signerId.trim().toLowerCase();
    const matching = manifest.attestations.filter((attestation) => attestation.signerId === signerId);
    if (matching.length !== 1) throw new Error('HTLC_MULTI_RECIPIENT_SIGNER_MISMATCH');
    if (normalizedExpectedSignerId !== undefined && signerId !== normalizedExpectedSignerId) {
      throw new Error('HTLC_MULTI_RECIPIENT_DEFAULT_PROPOSER_MISMATCH');
    }
    const expected = matching[0]!;
    const publicKey = normalizeValidatorEncryptionPublicKey(recipient.encryptionPublicKey);
    assertBase64Bound(recipient.wrappedKey, MAX_WRAPPED_KEY_BASE64_CHARS, 'HTLC_WRAPPED_KEY_SIZE_INVALID');
    if (publicKey !== expected.encryptionPublicKey) {
      throw new Error('HTLC_MULTI_RECIPIENT_KEY_MISMATCH');
    }
    return { ...recipient, signerId: expected.signerId, encryptionPublicKey: publicKey };
  });
};

export const validateMultiRecipientCiphertext = (
  ciphertext: MultiRecipientCiphertext,
  expectedEntityId: string,
  expectedContextHash: string,
  expectedRecipientSignerId?: string,
): MultiRecipientCiphertext => {
  assertExactMultiRecipientCiphertextSchema(ciphertext);
  const manifest = validateSelfContainedValidatorEncryptionManifest(ciphertext.manifest);
  if (manifest.entityId !== String(expectedEntityId || '').trim().toLowerCase()) {
    throw new Error('HTLC_MULTI_RECIPIENT_ENTITY_MISMATCH');
  }
  const contextHash = normalizeContextHash(expectedContextHash);
  if (ciphertext.contextHash !== contextHash) {
    throw new Error(`HTLC_ENCRYPTION_CONTEXT_MISMATCH:expected=${contextHash}:actual=${ciphertext.contextHash}`);
  }
  const profileCertification = validateEntityProfileCertificationWitness(
    manifest.hash,
    ciphertext.profileCertification,
  );
  const recipients = validateCiphertextRecipients(ciphertext, manifest, expectedRecipientSignerId);
  const canonical: MultiRecipientCiphertext = {
    version: HTLC_MULTI_RECIPIENT_VERSION,
    manifest,
    profileCertification,
    contextHash,
    nonce: ciphertext.nonce,
    ciphertext: ciphertext.ciphertext,
    recipients,
  };
  if (serializeTaggedJson(ciphertext) !== serializeTaggedJson(canonical)) {
    throw new Error('HTLC_MULTI_RECIPIENT_NON_CANONICAL');
  }
  return canonical;
};

export const decryptBytesForLocalValidator = async (
  ciphertext: MultiRecipientCiphertext,
  board: ValidatorEncryptionBoard,
  localSignerId: string,
  localPublicKey: string,
  localPrivateKey: string,
  expectedContextHash: string,
  cryptoProvider: CryptoProvider,
): Promise<Uint8Array> => {
  const manifest = requireCompleteValidatorEncryptionManifest(board, ciphertext.manifest.attestations);
  if (ciphertext.manifest.hash !== manifest.hash) throw new Error('HTLC_MULTI_RECIPIENT_MANIFEST_CORRUPTION');
  const defaultProposerSignerId = String(board.validators[0]?.signerId ?? '').trim().toLowerCase();
  if (!defaultProposerSignerId) throw new Error('HTLC_DEFAULT_PROPOSER_RECIPIENT_REQUIRED');
  const recipients = validateCiphertextRecipients(ciphertext, manifest, defaultProposerSignerId);
  const normalizedLocalKey = normalizeValidatorEncryptionPublicKey(localPublicKey);
  const normalizedSignerId = String(localSignerId || '').trim().toLowerCase();
  const contextHash = normalizeContextHash(expectedContextHash);
  if (ciphertext.contextHash !== contextHash) {
    throw new Error(`HTLC_ENCRYPTION_CONTEXT_MISMATCH:expected=${contextHash}:actual=${ciphertext.contextHash}`);
  }
  const matching = recipients.filter((recipient) =>
    recipient.signerId === normalizedSignerId && recipient.encryptionPublicKey === normalizedLocalKey
  );
  if (matching.length !== 1) {
    throw new Error(`HTLC_MULTI_RECIPIENT_LOCAL_KEY_MATCH: matches=${matching.length}`);
  }
  const unwrapped = await cryptoProvider.decrypt(matching[0]!.wrappedKey, localPrivateKey);
  const contentKey = hexToBytes(unwrapped);
  const expectedNonce = contentNonce(contentKey, manifest.hash, contextHash);
  if (ciphertext.nonce !== bytesToBase64(expectedNonce)) throw new Error('HTLC_MULTI_RECIPIENT_NONCE_MISMATCH');
  const cipher = chacha20poly1305(contentKey, expectedNonce, contentAad(manifest.hash, contextHash));
  const plaintext = cipher.decrypt(base64ToBytes(ciphertext.ciphertext));
  if (plaintext.length > MAX_HTLC_PLAINTEXT_BYTES) throw new Error('HTLC_DECRYPTED_PLAINTEXT_TOO_LARGE');
  return plaintext;
};

export const decryptForLocalValidator = async (
  ciphertext: MultiRecipientCiphertext,
  board: ValidatorEncryptionBoard,
  localSignerId: string,
  localPublicKey: string,
  localPrivateKey: string,
  expectedContextHash: string,
  cryptoProvider: CryptoProvider,
): Promise<string> => new TextDecoder().decode(await decryptBytesForLocalValidator(
  ciphertext,
  board,
  localSignerId,
  localPublicKey,
  localPrivateKey,
  expectedContextHash,
  cryptoProvider,
));
