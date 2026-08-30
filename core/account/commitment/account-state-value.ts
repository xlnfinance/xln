/**
 * Canonical RLP encoding of Account collection values.
 * Isolated from state-root so Patricia maps can hash leaves without an import cycle.
 */
import { ethers } from 'ethers';
import { utf8Bytes } from '../../protocol/crypto/keccak-text';
import { compareStableText } from '../../protocol/serialization';
import { countOp, OP_COUNTERS_ENABLED } from '../../support/performance/op-counters';
import { getPerfMs } from '../../support/time';

type RlpNode = string | RlpNode[];

const textNode = (value: string): string => ethers.hexlify(utf8Bytes(value));

const scalarNode = (value: null | boolean | number | bigint | string): RlpNode => {
  if (value === null) return [textNode('null')];
  if (typeof value === 'boolean') return [textNode('bool'), value ? '0x01' : '0x00'];
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`ACCOUNT_STATE_RLP_NON_FINITE_NUMBER:${String(value)}`);
    return [textNode('number'), textNode(String(value))];
  }
  if (typeof value === 'bigint') {
    const magnitude = value < 0n ? -value : value;
    return [textNode('bigint'), value < 0n ? '0x01' : '0x00', ethers.toBeHex(magnitude)];
  }
  return [textNode('string'), textNode(value)];
};

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const limit = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < limit; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
};

const rlpLengthBytes = (length: number): Uint8Array => {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`ACCOUNT_STATE_RLP_LENGTH_INVALID:${String(length)}`);
  }
  if (length === 0) return Uint8Array.of(0);
  let count = 0;
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) count += 1;
  const bytes = new Uint8Array(count);
  let remaining = length;
  for (let index = count - 1; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return bytes;
};

const concatBytes = (parts: readonly Uint8Array[], totalLength: number): Uint8Array => {
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

const encodeRlpPayload = (payload: Uint8Array, list: boolean): Uint8Array => {
  if (!list && payload.byteLength === 1 && payload[0]! < 0x80) return payload;
  const shortBase = list ? 0xc0 : 0x80;
  const longBase = list ? 0xf7 : 0xb7;
  if (payload.byteLength <= 55) {
    return concatBytes([Uint8Array.of(shortBase + payload.byteLength), payload], payload.byteLength + 1);
  }
  const lengthBytes = rlpLengthBytes(payload.byteLength);
  return concatBytes(
    [Uint8Array.of(longBase + lengthBytes.byteLength), lengthBytes, payload],
    1 + lengthBytes.byteLength + payload.byteLength,
  );
};

const encodeRlpNode = (node: RlpNode): Uint8Array => {
  if (typeof node === 'string') return encodeRlpPayload(ethers.getBytes(node), false);
  const children = node.map(encodeRlpNode);
  const payloadLength = children.reduce((total, child) => total + child.byteLength, 0);
  return encodeRlpPayload(concatBytes(children, payloadLength), true);
};

const encodeRlpList = (children: readonly Uint8Array[]): Uint8Array => {
  let payloadLength = 0;
  for (const child of children) payloadLength += child.byteLength;
  const lengthBytes = payloadLength <= 55 ? null : rlpLengthBytes(payloadLength);
  const headerLength = lengthBytes ? 1 + lengthBytes.byteLength : 1;
  const output = new Uint8Array(headerLength + payloadLength);
  if (lengthBytes) {
    output[0] = 0xf7 + lengthBytes.byteLength;
    output.set(lengthBytes, 1);
  } else {
    output[0] = 0xc0 + payloadLength;
  }
  let offset = headerLength;
  for (const child of children) {
    output.set(child, offset);
    offset += child.byteLength;
  }
  return output;
};

const TEXT_MEMO_MAX_LENGTH = 64;
const TEXT_MEMO_MAX = 8192;
const textMemo = new Map<string, Uint8Array>();
const encodeText = (value: string): Uint8Array => {
  if (value.length > TEXT_MEMO_MAX_LENGTH) return encodeRlpPayload(utf8Bytes(value), false);
  const cached = textMemo.get(value);
  if (cached) return cached;
  const encoded = encodeRlpPayload(utf8Bytes(value), false);
  if (textMemo.size >= TEXT_MEMO_MAX) textMemo.clear();
  textMemo.set(value, encoded);
  return encoded;
};

const HEX_NIBBLE = new Int8Array(128).fill(-1);
for (let index = 0; index < 16; index += 1) HEX_NIBBLE['0123456789abcdef'.charCodeAt(index)] = index;

const bigintMagnitudeBytes = (magnitude: bigint): Uint8Array => {
  if (magnitude === 0n) return Uint8Array.of(0);
  const hex = magnitude.toString(16);
  const odd = hex.length & 1;
  const bytes = new Uint8Array((hex.length + odd) >> 1);
  let out = 0;
  const nibble = (index: number): number => HEX_NIBBLE[hex.charCodeAt(index)] ?? 0;
  if (odd) bytes[out++] = nibble(0);
  for (let index = odd; index < hex.length; index += 2) {
    bytes[out++] = (nibble(index) << 4) | nibble(index + 1);
  }
  return bytes;
};

const nodeSortKey = (node: RlpNode): Uint8Array => encodeRlpNode(node);

const canonicalRlpNode = (value: unknown): RlpNode => {
  if (value === null || ['boolean', 'number', 'bigint', 'string'].includes(typeof value)) {
    return scalarNode(value as null | boolean | number | bigint | string);
  }
  if (Array.isArray(value)) return [textNode('array'), ...value.map(canonicalRlpNode)];
  if (value instanceof Map) {
    const entries = Array.from(value.entries()).map(([key, entry]) => {
      const keyNode = canonicalRlpNode(key);
      return {
        node: [keyNode, canonicalRlpNode(entry)] satisfies RlpNode[],
        sortKey: nodeSortKey(keyNode),
      };
    });
    entries.sort((left, right) => compareBytes(left.sortKey, right.sortKey));
    return [textNode('map'), ...entries.map(entry => entry.node)];
  }
  if (value instanceof Set) {
    const entries = Array.from(value.values()).map((entry) => {
      const node = canonicalRlpNode(entry);
      return { node, sortKey: nodeSortKey(node) };
    }).sort((left, right) => compareBytes(left.sortKey, right.sortKey));
    return [textNode('set'), ...entries.map(entry => entry.node)];
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([key, entry]) => [textNode(key), canonicalRlpNode(entry)] satisfies RlpNode[]);
    return [textNode('object'), ...entries];
  }
  throw new Error(`ACCOUNT_STATE_RLP_UNSUPPORTED:${typeof value}`);
};

const encodeAccountStateValueDirect = (value: unknown): Uint8Array => {
  if (value === null) return encodeRlpList([encodeText('null')]);
  if (typeof value === 'boolean') {
    return encodeRlpList([encodeText('bool'), encodeRlpPayload(Uint8Array.of(value ? 1 : 0), false)]);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`ACCOUNT_STATE_RLP_NON_FINITE_NUMBER:${String(value)}`);
    return encodeRlpList([encodeText('number'), encodeText(String(value))]);
  }
  if (typeof value === 'bigint') {
    const magnitude = value < 0n ? -value : value;
    return encodeRlpList([
      encodeText('bigint'),
      encodeRlpPayload(Uint8Array.of(value < 0n ? 1 : 0), false),
      encodeRlpPayload(bigintMagnitudeBytes(magnitude), false),
    ]);
  }
  if (typeof value === 'string') {
    return encodeRlpList([encodeText('string'), encodeText(value)]);
  }
  if (Array.isArray(value)) {
    return encodeRlpList([encodeText('array'), ...value.map(encodeAccountStateValueDirect)]);
  }
  if (value instanceof Map) {
    const entries = Array.from(value.entries()).map(([key, entry]) => {
      const encodedKey = encodeAccountStateValueDirect(key);
      return {
        encodedKey,
        encodedEntry: encodeRlpList([encodedKey, encodeAccountStateValueDirect(entry)]),
      };
    }).sort((left, right) => compareBytes(left.encodedKey, right.encodedKey));
    return encodeRlpList([encodeText('map'), ...entries.map(entry => entry.encodedEntry)]);
  }
  if (value instanceof Set) {
    const entries = Array.from(value.values(), encodeAccountStateValueDirect).sort(compareBytes);
    return encodeRlpList([encodeText('set'), ...entries]);
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([key, entry]) => encodeRlpList([encodeText(key), encodeAccountStateValueDirect(entry)]));
    return encodeRlpList([encodeText('object'), ...entries]);
  }
  throw new Error(`ACCOUNT_STATE_RLP_UNSUPPORTED:${typeof value}`);
};

export const encodeAccountStateValueOracle = (value: unknown): Uint8Array =>
  encodeRlpNode(canonicalRlpNode(value));

/**
 * Single-pass writer: children are appended first, then the list header is
 * inserted with one copyWithin. Byte-identical to the node encoder above,
 * without an allocation per scalar, per list and per concatenation.
 */
class RlpWriter {
  buf = new Uint8Array(4_096);
  len = 0;

  ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < needed) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(value: number): void {
    this.ensure(1);
    this.buf[this.len] = value;
    this.len += 1;
  }

  bytes(value: Uint8Array): void {
    const length = value.byteLength;
    this.ensure(length);
    const buf = this.buf;
    let offset = this.len;
    // TypedArray.set has a fixed call cost that dominates for the short
    // tags, keys and scalars that make up almost every item.
    if (length <= 64) {
      for (let index = 0; index < length; index += 1) buf[offset++] = value[index] ?? 0;
    } else {
      buf.set(value, offset);
      offset += length;
    }
    this.len = offset;
  }

  /** RLP string item. */
  payload(value: Uint8Array): void {
    const single = value.byteLength === 1 ? value[0] : undefined;
    if (single !== undefined && single < 0x80) { this.byte(single); return; }
    this.header(0x80, 0xb7, value.byteLength);
    this.bytes(value);
  }

  header(shortBase: number, longBase: number, payloadLength: number): void {
    if (payloadLength <= 55) { this.byte(shortBase + payloadLength); return; }
    const lengthBytes = rlpLengthBytes(payloadLength);
    this.byte(longBase + lengthBytes.byteLength);
    this.bytes(lengthBytes);
  }

  /**
   * RLP list item: one header byte is reserved before the body; only a body
   * longer than 55 bytes (rare: whole maps) shifts to make room for a length.
   */
  list(body: () => void): void {
    this.ensure(1);
    const start = this.len;
    this.len += 1;
    body();
    const payloadLength = this.len - start - 1;
    if (payloadLength <= 55) {
      this.buf[start] = 0xc0 + payloadLength;
      return;
    }
    const lengthBytes = rlpLengthBytes(payloadLength);
    const extra = lengthBytes.byteLength;
    this.ensure(extra);
    this.buf.copyWithin(start + 1 + extra, start + 1, this.len);
    this.buf[start] = 0xf7 + extra;
    for (let index = 0; index < extra; index += 1) this.buf[start + 1 + index] = lengthBytes[index] ?? 0;
    this.len += extra;
  }

  take(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

const TYPE_TAGS = {
  null: encodeText('null'), bool: encodeText('bool'), number: encodeText('number'),
  bigint: encodeText('bigint'), string: encodeText('string'), array: encodeText('array'),
  map: encodeText('map'), set: encodeText('set'), object: encodeText('object'),
} as const;
const RLP_BYTE_0 = Uint8Array.of(0);
const RLP_BYTE_1 = Uint8Array.of(1);

// Writers are reused: Map keys and Set members encode on a nested writer.
const writerPool: RlpWriter[] = [];
const encodeStandalone = (value: unknown): Uint8Array => {
  const writer = writerPool.pop() ?? new RlpWriter();
  writer.len = 0;
  try {
    writeAccountStateValue(writer, value);
    return writer.take();
  } finally {
    writerPool.push(writer);
  }
};

const writeAccountStateValue = (w: RlpWriter, value: unknown): void => {
  if (value === null) { w.list(() => w.bytes(TYPE_TAGS.null)); return; }
  switch (typeof value) {
    case 'boolean':
      w.list(() => { w.bytes(TYPE_TAGS.bool); w.payload(value ? RLP_BYTE_1 : RLP_BYTE_0); });
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`ACCOUNT_STATE_RLP_NON_FINITE_NUMBER:${String(value)}`);
      w.list(() => { w.bytes(TYPE_TAGS.number); w.bytes(encodeText(String(value))); });
      return;
    case 'bigint':
      w.list(() => {
        w.bytes(TYPE_TAGS.bigint);
        w.payload(value < 0n ? RLP_BYTE_1 : RLP_BYTE_0);
        w.payload(bigintMagnitudeBytes(value < 0n ? -value : value));
      });
      return;
    case 'string':
      w.list(() => { w.bytes(TYPE_TAGS.string); w.bytes(encodeText(value)); });
      return;
    case 'object':
      break;
    default:
      throw new Error(`ACCOUNT_STATE_RLP_UNSUPPORTED:${typeof value}`);
  }
  if (Array.isArray(value)) {
    w.list(() => {
      w.bytes(TYPE_TAGS.array);
      for (const entry of value) writeAccountStateValue(w, entry);
    });
    return;
  }
  if (value instanceof Map) {
    const entries = Array.from(value.entries(), ([key, entry]) => ({ encodedKey: encodeStandalone(key), entry }))
      .sort((left, right) => compareBytes(left.encodedKey, right.encodedKey));
    w.list(() => {
      w.bytes(TYPE_TAGS.map);
      for (const { encodedKey, entry } of entries) {
        w.list(() => { w.bytes(encodedKey); writeAccountStateValue(w, entry); });
      }
    });
    return;
  }
  if (value instanceof Set) {
    const entries = Array.from(value.values(), encodeStandalone).sort(compareBytes);
    w.list(() => {
      w.bytes(TYPE_TAGS.set);
      for (const entry of entries) w.bytes(entry);
    });
    return;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort(compareStableText);
  w.list(() => {
    w.bytes(TYPE_TAGS.object);
    for (const key of keys) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      w.list(() => { w.bytes(encodeText(key)); writeAccountStateValue(w, entry); });
    }
  });
};

export const encodeAccountStateValue = (value: unknown): Uint8Array => {
  const startedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
  const bytes = encodeStandalone(value);
  countOp(
    'account.canonical.encode',
    bytes.byteLength,
    OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - startedAt) * 1_000) : 0,
  );
  return bytes;
};
