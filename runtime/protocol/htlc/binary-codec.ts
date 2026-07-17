import { LIMITS } from '../../constants';

export const MAX_HTLC_BINARY_LAYER_BYTES = Math.floor(
  (LIMITS.MAX_FRAME_SIZE_BYTES - 1_000_000) * 3 / 4,
);

const requireLength = (length: number, max: number, code: string): number => {
  if (!Number.isSafeInteger(length) || length < 0 || length > max) throw new Error(code);
  return length;
};

export const hexToRawBytes = (value: string, code: string, exactBytes?: number): Uint8Array => {
  const normalized = String(value || '').trim();
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(normalized)) throw new Error(code);
  const length = (normalized.length - 2) / 2;
  if (exactBytes !== undefined && length !== exactBytes) throw new Error(code);
  return Uint8Array.from({ length }, (_, index) =>
    Number.parseInt(normalized.slice(2 + index * 2, 4 + index * 2), 16));
};

export const rawBytesToHex = (bytes: Uint8Array): string => {
  let hex = '0x';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
};

export const base64ToRawBytes = (value: string, code: string): Uint8Array => {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(code);
  }
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error(code);
  }
};

export const rawBytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export class BinaryWriter {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  constructor(private readonly maxBytes: number, private readonly code: string) {}

  raw(bytes: Uint8Array): void {
    if (this.length + bytes.length > this.maxBytes) throw new Error(this.code);
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u8(value: number): void {
    requireLength(value, 0xff, this.code);
    this.raw(Uint8Array.of(value));
  }

  u16(value: number): void {
    requireLength(value, 0xffff, this.code);
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, false);
    this.raw(bytes);
  }

  u32(value: number): void {
    requireLength(value, 0xffffffff, this.code);
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, false);
    this.raw(bytes);
  }

  u64(value: bigint): void {
    if (value < 0n || value > 0xffffffffffffffffn) throw new Error(this.code);
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, false);
    this.raw(bytes);
  }

  sized(bytes: Uint8Array): void {
    this.u32(bytes.length);
    this.raw(bytes);
  }

  text(value: string): void {
    const bytes = new TextEncoder().encode(value);
    this.u16(bytes.length);
    this.raw(bytes);
  }

  finish(): Uint8Array {
    const output = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
}

export class BinaryReader {
  private offset = 0;

  constructor(
    private readonly input: Uint8Array,
    private readonly maxBytes: number,
    private readonly code: string,
  ) {
    if (input.length > maxBytes) throw new Error(code);
  }

  raw(length: number): Uint8Array {
    requireLength(length, this.maxBytes, this.code);
    if (this.offset + length > this.input.length) throw new Error(this.code);
    const value = this.input.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  u8(): number {
    return this.raw(1)[0]!;
  }

  u16(): number {
    const bytes = this.raw(2);
    return new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(0, false);
  }

  u32(): number {
    const bytes = this.raw(4);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
  }

  u64(): bigint {
    const bytes = this.raw(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, false);
  }

  sized(): Uint8Array {
    return this.raw(this.u32());
  }

  text(): string {
    const bytes = this.raw(this.u16());
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(this.code);
    }
  }

  done(): void {
    if (this.offset !== this.input.length) throw new Error(this.code);
  }
}
