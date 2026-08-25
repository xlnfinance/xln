/** Bit-exact MessagePack value codec shared by the process client and strict decoders. */
export type RscoreWireValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | RscoreWireValue[];

/** Minimal encoding required by the Rust decoder's re-encode check. */
export const packWireValue = (value: RscoreWireValue): Buffer => {
  const chunks: Buffer[] = [];
  writeValue(chunks, value);
  return Buffer.concat(chunks);
};

const writeValue = (out: Buffer[], value: RscoreWireValue): void => {
  if (value === null) { out.push(Buffer.from([0xc0])); return; }
  if (typeof value === 'boolean') { out.push(Buffer.from([value ? 0xc3 : 0xc2])); return; }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`RSCORE_CLIENT_INTEGER_UNSAFE:${String(value)}`);
    writeInteger(out, BigInt(value));
    return;
  }
  if (typeof value === 'bigint') { writeInteger(out, value); return; }
  if (typeof value === 'string') { writeText(out, value); return; }
  if (value instanceof Uint8Array) { writeBinary(out, value); return; }
  if (Array.isArray(value)) {
    writeArrayHeader(out, value.length);
    for (const item of value) writeValue(out, item);
    return;
  }
  throw new Error(`RSCORE_CLIENT_VALUE_UNSUPPORTED:${typeof value}`);
};

const writeInteger = (out: Buffer[], value: bigint): void => {
  if (value < -0x8000_0000_0000_0000n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`RSCORE_CLIENT_INTEGER_RANGE:${value.toString()}`);
  }
  if (value >= 0n && value <= 127n) { out.push(Buffer.from([Number(value)])); return; }
  if (value >= 128n && value <= 255n) { out.push(Buffer.from([0xcc, Number(value)])); return; }
  if (value >= 256n && value <= 65_535n) { out.push(tagged(0xcd, be(value, 2))); return; }
  if (value >= 65_536n && value <= 0xffff_ffffn) { out.push(tagged(0xce, be(value, 4))); return; }
  if (value >= 0n && value <= 0xffff_ffff_ffff_ffffn) { out.push(tagged(0xcf, be(value, 8))); return; }
  if (value >= -32n && value < 0n) { out.push(Buffer.from([Number(value) & 0xff])); return; }
  if (value >= -128n) { out.push(tagged(0xd0, be(value & 0xffn, 1))); return; }
  if (value >= -32_768n) { out.push(tagged(0xd1, be(value & 0xffffn, 2))); return; }
  if (value >= -2_147_483_648n) { out.push(tagged(0xd2, be(value & 0xffff_ffffn, 4))); return; }
  out.push(tagged(0xd3, be(value & 0xffff_ffff_ffff_ffffn, 8)));
};

const be = (value: bigint, bytes: number): Buffer => {
  const buffer = Buffer.alloc(bytes);
  let cursor = value;
  for (let index = bytes - 1; index >= 0; index -= 1) {
    buffer[index] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
  return buffer;
};

const tagged = (tag: number, payload: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), payload]);

const writeText = (out: Buffer[], value: string): void => {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= 31) out.push(Buffer.from([0xa0 | bytes.length]));
  else out.push(lengthHeader(bytes.length, [0xd9, 0xda, 0xdb]));
  out.push(bytes);
};

const writeBinary = (out: Buffer[], value: Uint8Array): void => {
  out.push(lengthHeader(value.length, [0xc4, 0xc5, 0xc6]), Buffer.from(value));
};

const lengthHeader = (length: number, tags: [number, number, number]): Buffer => {
  if (length <= 255) return Buffer.from([tags[0], length]);
  if (length <= 65_535) return tagged(tags[1], be(BigInt(length), 2));
  return tagged(tags[2], be(BigInt(length), 4));
};

const writeArrayHeader = (out: Buffer[], length: number): void => {
  if (length <= 15) out.push(Buffer.from([0x90 | length]));
  else if (length <= 65_535) out.push(tagged(0xdc, be(BigInt(length), 2)));
  else out.push(tagged(0xdd, be(BigInt(length), 4)));
};

type ReadCursor = { buffer: Buffer; offset: number };

const readByte = (cursor: ReadCursor, offset: number): number => {
  const byte = cursor.buffer[offset];
  if (byte === undefined) throw new Error(`RSCORE_CLIENT_TRUNCATED:${offset}`);
  return byte;
};

/** Decode one value embedded in a larger process frame. */
export const unpackWireValueAt = (
  bytes: Buffer,
  offset: number,
): Readonly<{ value: unknown; nextOffset: number }> => {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) {
    throw new Error(`RSCORE_CLIENT_OFFSET:${offset}:${bytes.length}`);
  }
  const cursor: ReadCursor = { buffer: bytes, offset };
  const value = readValue(cursor);
  return { value, nextOffset: cursor.offset };
};

/** Exact inverse of `packWireValue`; rejects trailing or truncated bytes. */
export const unpackWireValue = (bytes: Buffer): unknown => {
  const decoded = unpackWireValueAt(bytes, 0);
  if (decoded.nextOffset !== bytes.length) {
    throw new Error(`RSCORE_CLIENT_TRAILING_BYTES:${decoded.nextOffset}:${bytes.length}`);
  }
  return decoded.value;
};

const readValue = (cursor: ReadCursor): unknown => {
  const marker = readByte(cursor, cursor.offset);
  cursor.offset += 1;
  if (marker <= 0x7f) return marker;
  if (marker >= 0xe0) return marker - 256;
  if (marker >= 0x90 && marker <= 0x9f) return readArray(cursor, marker & 0x0f);
  if (marker >= 0xa0 && marker <= 0xbf) return readText(cursor, marker & 0x1f);
  switch (marker) {
    case 0xc0: return null;
    case 0xc2: return false;
    case 0xc3: return true;
    case 0xcc: return readUint(cursor, 1);
    case 0xcd: return readUint(cursor, 2);
    case 0xce: return readUint(cursor, 4);
    case 0xcf: return readBigUint(cursor);
    case 0xd0: return readInt(cursor, 1);
    case 0xd1: return readInt(cursor, 2);
    case 0xd2: return readInt(cursor, 4);
    case 0xd3: return readBigInt(cursor);
    case 0xc4: return readBin(cursor, readUint(cursor, 1));
    case 0xc5: return readBin(cursor, readUint(cursor, 2));
    case 0xc6: return readBin(cursor, readUint(cursor, 4));
    case 0xd9: return readText(cursor, readUint(cursor, 1));
    case 0xda: return readText(cursor, readUint(cursor, 2));
    case 0xdb: return readText(cursor, readUint(cursor, 4));
    case 0xdc: return readArray(cursor, readUint(cursor, 2));
    case 0xdd: return readArray(cursor, readUint(cursor, 4));
    default: throw new Error(`RSCORE_CLIENT_MARKER_UNSUPPORTED:0x${marker.toString(16)}`);
  }
};

const readUint = (cursor: ReadCursor, bytes: number): number => {
  let value = 0;
  for (let index = 0; index < bytes; index += 1) {
    value = value * 256 + readByte(cursor, cursor.offset + index);
  }
  cursor.offset += bytes;
  return value;
};

const readInt = (cursor: ReadCursor, bytes: number): number => {
  const unsigned = readUint(cursor, bytes);
  const bound = 2 ** (bytes * 8 - 1);
  return unsigned >= bound ? unsigned - bound * 2 : unsigned;
};

const readBigUint = (cursor: ReadCursor): number | bigint => {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) + BigInt(readByte(cursor, cursor.offset + index));
  }
  cursor.offset += 8;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
};

const readBigInt = (cursor: ReadCursor): number | bigint => {
  const unsigned = readBigUint(cursor);
  const value = typeof unsigned === 'number' ? BigInt(unsigned) : unsigned;
  const signed = value >= 0x8000_0000_0000_0000n ? value - 0x1_0000_0000_0000_0000n : value;
  return signed >= BigInt(Number.MIN_SAFE_INTEGER) && signed <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(signed)
    : signed;
};

const readBin = (cursor: ReadCursor, length: number): Buffer => {
  const value = cursor.buffer.subarray(cursor.offset, cursor.offset + length);
  if (value.byteLength !== length) throw new Error(`RSCORE_CLIENT_TRUNCATED:${cursor.offset + length}`);
  cursor.offset += length;
  return Buffer.from(value);
};

const readText = (cursor: ReadCursor, length: number): string => {
  const end = cursor.offset + length;
  if (end > cursor.buffer.length) throw new Error(`RSCORE_CLIENT_TRUNCATED:${end}`);
  const value = cursor.buffer.toString('utf8', cursor.offset, end);
  cursor.offset = end;
  return value;
};

const readArray = (cursor: ReadCursor, length: number): unknown[] => {
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) values.push(readValue(cursor));
  return values;
};
