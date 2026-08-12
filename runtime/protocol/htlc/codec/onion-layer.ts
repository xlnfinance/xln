import { assertOpaqueHtlcCiphertext, hashOpaqueHtlcCiphertext, type OpaqueHtlcCiphertext } from '../multi-recipient';

export type HtlcEncryptedEnvelope = OpaqueHtlcCiphertext | undefined;

export const encryptedHtlcLayer = (
  envelope: HtlcEncryptedEnvelope,
): OpaqueHtlcCiphertext | null => envelope === undefined ? null : assertOpaqueHtlcCiphertext(envelope);

export const hashEncryptedHtlcLayer = hashOpaqueHtlcCiphertext;
