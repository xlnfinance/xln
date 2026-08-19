/**
 * Canonical RLP encoding of Account collection values.
 * Isolated from state-root so Patricia maps can hash leaves without an import cycle.
 */
import { ethers } from 'ethers';
import { utf8Bytes } from '../../protocol/crypto/keccak-text';
import { compareStableText } from '../../protocol/serialization';

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
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.push(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  bytes.reverse();
  return Uint8Array.from(bytes);
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

const bigintMagnitudeBytes = (magnitude: bigint): Uint8Array => {
  if (magnitude === 0n) return Uint8Array.of(0);
  const hex = magnitude.toString(16);
  const padded = hex.length % 2 ? `0${hex}` : hex;
  const bytes = new Uint8Array(padded.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(padded.slice(index * 2, index * 2 + 2), 16);
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

export const encodeAccountStateValue = (value: unknown): Uint8Array =>
  encodeAccountStateValueDirect(value);
