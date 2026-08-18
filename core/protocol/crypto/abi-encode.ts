/**
 * Minimal ABI encoder for a fixed schema tree (tuple / T[] / bytes / static
 * words). Byte-identical to `AbiCoder.encode([param], [value])` for the
 * supported types — differential-tested in `__tests__/protocol/abi-encode.test.ts`.
 *
 * Why: the generic ethers coder re-walks ParamType, wraps values, and copies
 * bytes per word. Consensus paths encode a dispute proof body on every Account
 * commit and a Hanko per certified output; those two encodes were ~10% of hub
 * CPU. Value validation mirrors ethers (ranges, fixed lengths, checksummed
 * addresses) so an invalid struct still throws instead of encoding garbage.
 */
import { ethers } from 'ethers';

export type AbiSchema =
  | { readonly kind: 'uint'; readonly bits: number }
  | { readonly kind: 'int'; readonly bits: number }
  | { readonly kind: 'bool' }
  | { readonly kind: 'address' }
  | { readonly kind: 'bytesN'; readonly bytes: number }
  | { readonly kind: 'bytes' }
  | { readonly kind: 'string' }
  | { readonly kind: 'array'; readonly item: AbiSchema; readonly dynamic: boolean }
  | {
      readonly kind: 'tuple';
      readonly fields: ReadonlyArray<{ readonly name: string; readonly schema: AbiSchema }>;
      readonly dynamic: boolean;
    };

type ParamFragment = {
  readonly name?: string;
  readonly type: string;
  readonly components?: ReadonlyArray<ParamFragment>;
};

const isDynamic = (schema: AbiSchema): boolean =>
  schema.kind === 'bytes'
  || schema.kind === 'string'
  || ((schema.kind === 'array' || schema.kind === 'tuple') && schema.dynamic);

/** Build the schema from a JSON ABI fragment (`{type, components}`), as used by ethers.ParamType.from. */
export const abiSchemaFromFragment = (fragment: ParamFragment): AbiSchema => {
  const type = fragment.type;
  if (type.endsWith('[]')) {
    const item = abiSchemaFromFragment({ ...fragment, type: type.slice(0, -2) });
    return { kind: 'array', item, dynamic: true };
  }
  if (type === 'tuple') {
    const fields = (fragment.components ?? []).map((component, index) => ({
      name: component.name ?? String(index),
      schema: abiSchemaFromFragment(component),
    }));
    return { kind: 'tuple', fields, dynamic: fields.some(field => isDynamic(field.schema)) };
  }
  if (type === 'bool') return { kind: 'bool' };
  if (type === 'address') return { kind: 'address' };
  if (type === 'bytes') return { kind: 'bytes' };
  if (type === 'string') return { kind: 'string' };
  const uint = /^uint(\d+)?$/.exec(type);
  if (uint) return { kind: 'uint', bits: uint[1] ? Number(uint[1]) : 256 };
  const int = /^int(\d+)?$/.exec(type);
  if (int) return { kind: 'int', bits: int[1] ? Number(int[1]) : 256 };
  const bytesN = /^bytes(\d+)$/.exec(type);
  if (bytesN) return { kind: 'bytesN', bytes: Number(bytesN[1]) };
  throw new Error(`ABI_ENCODE_UNSUPPORTED_TYPE:${type}`);
};

/** Schema for a plain type string such as `uint64[]` or `bytes32`. */
export const abiSchemaFromType = (type: string): AbiSchema => abiSchemaFromFragment({ type });

const WORD = 64;
const TWO_256 = 1n << 256n;
const HEX_BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const MIXED_CASE_RE = /([A-F].*[a-f])|([a-f].*[A-F])/;

const invalid = (path: string, reason: string): never => {
  throw new Error(`ABI_ENCODE_INVALID_VALUE:${reason}:${path}`);
};

const toBigInt = (value: unknown, path: string): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) invalid(path, 'number');
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?(?:0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value);
  return invalid(path, 'integer');
};

const uintWord = (value: bigint): string => value.toString(16).padStart(WORD, '0');

const bytesHex = (value: unknown, path: string): string => {
  if (typeof value === 'string') {
    if (!HEX_BYTES_RE.test(value)) invalid(path, 'hex');
    return value.slice(2).toLowerCase();
  }
  if (value instanceof Uint8Array) return ethers.hexlify(value).slice(2);
  return invalid(path, 'bytes');
};

const encodeStatic = (schema: AbiSchema, value: unknown, path: string): string => {
  switch (schema.kind) {
    case 'uint': {
      const big = toBigInt(value, path);
      if (big < 0n || big >= (1n << BigInt(schema.bits))) invalid(path, 'uint-range');
      return uintWord(big);
    }
    case 'int': {
      const big = toBigInt(value, path);
      const half = 1n << BigInt(schema.bits - 1);
      if (big < -half || big >= half) invalid(path, 'int-range');
      return uintWord(big < 0n ? TWO_256 + big : big);
    }
    case 'bool': {
      if (typeof value !== 'boolean') invalid(path, 'bool');
      return uintWord(value ? 1n : 0n);
    }
    case 'address': {
      if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) invalid(path, 'address');
      const address = value as string;
      // ethers accepts all-lower / all-upper hex; mixed case must be a valid checksum.
      let canonical = address;
      if (MIXED_CASE_RE.test(address.slice(2))) {
        try {
          canonical = ethers.getAddress(address);
        } catch {
          invalid(path, 'address-checksum');
        }
      }
      return canonical.slice(2).toLowerCase().padStart(WORD, '0');
    }
    case 'bytesN': {
      const hex = bytesHex(value, path);
      if (hex.length !== schema.bytes * 2) invalid(path, 'bytesN-length');
      return hex.padEnd(WORD, '0');
    }
    default:
      return invalid(path, 'static');
  }
};

const encodeDynamicBytes = (hex: string): string => {
  const padded = hex + '0'.repeat((WORD - (hex.length % WORD)) % WORD);
  return uintWord(BigInt(hex.length / 2)) + padded;
};

const encodeValue = (schema: AbiSchema, value: unknown, path: string): string => {
  switch (schema.kind) {
    case 'bytes':
      return encodeDynamicBytes(bytesHex(value, path));
    case 'string': {
      if (typeof value !== 'string') invalid(path, 'string');
      // ethers rejects lone surrogates where TextEncoder would substitute U+FFFD.
      let bytes: Uint8Array;
      try {
        bytes = ethers.toUtf8Bytes(value as string);
      } catch {
        return invalid(path, 'utf8');
      }
      return encodeDynamicBytes(ethers.hexlify(bytes).slice(2));
    }
    case 'array': {
      if (!Array.isArray(value)) invalid(path, 'array');
      const items = value as unknown[];
      return uintWord(BigInt(items.length)) + encodeSequence(
        items.map(() => schema.item),
        items,
        items.map((_, index) => `${path}[${index}]`),
      );
    }
    case 'tuple': {
      const values = tupleValues(schema, value, path);
      return encodeSequence(
        schema.fields.map(field => field.schema),
        values,
        schema.fields.map(field => `${path}.${field.name}`),
      );
    }
    default:
      return encodeStatic(schema, value, path);
  }
};

const tupleValues = (
  schema: Extract<AbiSchema, { kind: 'tuple' }>,
  value: unknown,
  path: string,
): unknown[] => {
  if (Array.isArray(value)) {
    if (value.length !== schema.fields.length) invalid(path, 'tuple-length');
    return value as unknown[];
  }
  if (typeof value !== 'object' || value === null) return invalid(path, 'tuple');
  const record = value as Record<string, unknown>;
  return schema.fields.map((field) => {
    if (!(field.name in record)) invalid(`${path}.${field.name}`, 'tuple-field-missing');
    return record[field.name];
  });
};

/** Standard head/tail layout: static items inline, dynamic items as offsets into the tail. */
const encodeSequence = (schemas: readonly AbiSchema[], values: readonly unknown[], paths: readonly string[]): string => {
  let headBytes = 0;
  const encoded: string[] = new Array(schemas.length);
  const dynamic: boolean[] = new Array(schemas.length);
  for (let index = 0; index < schemas.length; index += 1) {
    const schema = schemas[index]!;
    dynamic[index] = isDynamic(schema);
    encoded[index] = encodeValue(schema, values[index], paths[index]!);
    headBytes += dynamic[index] ? 32 : encoded[index]!.length / 2;
  }
  let head = '';
  let tail = '';
  let offset = headBytes;
  for (let index = 0; index < schemas.length; index += 1) {
    if (dynamic[index]) {
      head += uintWord(BigInt(offset));
      tail += encoded[index]!;
      offset += encoded[index]!.length / 2;
    } else {
      head += encoded[index]!;
    }
  }
  return head + tail;
};

/** `0x`-prefixed lowercase hex, identical to `AbiCoder.encode([param], [value])`. */
export const encodeAbi = (schema: AbiSchema, value: unknown): string =>
  `0x${encodeSequence([schema], [value], ['$'])}`;

/** Identical to `AbiCoder.encode(types, values)` for a parameter list. */
export const encodeAbiParams = (schemas: readonly AbiSchema[], values: readonly unknown[]): string => {
  if (schemas.length !== values.length) invalid('$', 'params-length');
  return `0x${encodeSequence(schemas, values, schemas.map((_, index) => `$[${index}]`))}`;
};
