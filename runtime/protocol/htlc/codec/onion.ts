import {
  assertOpaqueHtlcCiphertext,
  HTLC_OPAQUE_CIPHERTEXT_VERSION,
  type OpaqueHtlcCiphertext,
} from '../multi-recipient';
import {
  BinaryReader,
  BinaryWriter,
  MAX_HTLC_BINARY_LAYER_BYTES,
  base64ToRawBytes,
  hexToRawBytes,
  rawBytesToBase64,
  rawBytesToHex,
} from './binary';

const CIPHERTEXT_MAGIC = Uint8Array.of(0x58, 0x4c, 0x4d, 0x52); // XLMR
const ONION_MAGIC = Uint8Array.of(0x58, 0x4c, 0x4f, 0x4e); // XLON
const CIPHERTEXT_CODEC_VERSION = 1;
const ONION_CODEC_VERSION = 2;
const FINAL_LAYER = 1;
const FORWARD_LAYER = 2;
const MAX_UINT256 = (1n << 256n) - 1n;

export type DecodedOnionLayer = Readonly<{
  finalRecipient: true;
  secret: string;
  description?: string;
  startedAtMs?: number;
}> | Readonly<{
  nextHop: string;
  innerEnvelope: OpaqueHtlcCiphertext;
  forwardAmount: string;
}>;


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
const encodeOpaqueCiphertext = (value: OpaqueHtlcCiphertext): Uint8Array => {
  const canonical = assertOpaqueHtlcCiphertext(value);
  const writer = new BinaryWriter(MAX_HTLC_BINARY_LAYER_BYTES, 'HTLC_CIPHERTEXT_BINARY_TOO_LARGE');
  writer.raw(CIPHERTEXT_MAGIC);
  writer.u8(CIPHERTEXT_CODEC_VERSION);
  writer.sized(base64ToRawBytes(canonical.ciphertext, 'HTLC_CIPHERTEXT_BODY_INVALID'));
  return writer.finish();
};

const decodeOpaqueCiphertext = (encoded: Uint8Array): OpaqueHtlcCiphertext => {
  const code = 'HTLC_CIPHERTEXT_BINARY_INVALID';
  const reader = new BinaryReader(encoded, MAX_HTLC_BINARY_LAYER_BYTES, code);
  expectMagic(reader, CIPHERTEXT_MAGIC, code);
  if (reader.u8() !== CIPHERTEXT_CODEC_VERSION) throw new Error('HTLC_CIPHERTEXT_BINARY_VERSION_INVALID');
  const ciphertext = rawBytesToBase64(reader.sized());
  reader.done();
  return assertOpaqueHtlcCiphertext({ version: HTLC_OPAQUE_CIPHERTEXT_VERSION, ciphertext });
};

export const encodeOnionLayer = (layer: DecodedOnionLayer): Uint8Array => {
  const writer = new BinaryWriter(MAX_HTLC_BINARY_LAYER_BYTES, 'HTLC_ONION_LAYER_TOO_LARGE');
  writer.raw(ONION_MAGIC);
  writer.u8(ONION_CODEC_VERSION);
  if ('finalRecipient' in layer) {
    writer.u8(FINAL_LAYER);
    writer.raw(hexToRawBytes(layer.secret, 'HTLC_ONION_FINAL_SECRET_INVALID', 32));
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
    writer.sized(encodeOpaqueCiphertext(layer.innerEnvelope));
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
    const secret = rawBytesToHex(reader.raw(32));
    const flags = reader.u8();
    if ((flags & ~3) !== 0) throw new Error(code);
    const description = (flags & 1) !== 0 ? reader.text() : undefined;
    const rawStartedAt = (flags & 2) !== 0 ? reader.u64() : undefined;
    if (rawStartedAt !== undefined && rawStartedAt > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(code);
    reader.done();
    return {
      finalRecipient: true,
      secret,
      ...(description !== undefined ? { description } : {}),
      ...(rawStartedAt !== undefined ? { startedAtMs: Number(rawStartedAt) } : {}),
    };
  }
  if (kind !== FORWARD_LAYER) throw new Error(code);
  const nextHop = reader.text();
  const amount = bytesToUint256(reader.raw(32));
  if (amount <= 0n) throw new Error(code);
  const innerEnvelope = decodeOpaqueCiphertext(reader.sized());
  reader.done();
  return { nextHop, innerEnvelope, forwardAmount: amount.toString() };
};
