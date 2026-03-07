/**
 * Unified snapshot encoder/decoder.
 * JSON mode is canonical, deterministic, and BigInt-safe via serialization-utils.
 */

import { deserializeTaggedJson, serializeTaggedJson } from './serialization-utils';

// Msgpack path is intentionally disabled until there is a tested, equivalent codec.
const USE_MSGPACK = false;

export const encode = <T>(data: T): Buffer => Buffer.from(serializeTaggedJson(data));

export const decode = <T>(buffer: Buffer): T => deserializeTaggedJson<T>(buffer.toString());

export const encodeAsync = async <T>(data: T): Promise<Buffer> => encode(data);

export const decodeAsync = async <T>(buffer: Buffer): Promise<T> => decode<T>(buffer);

export { USE_MSGPACK };
