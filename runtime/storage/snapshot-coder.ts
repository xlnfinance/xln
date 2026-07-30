/**
 * Unified snapshot encoder/decoder.
 * JSON mode is canonical, deterministic, and BigInt-safe via serialization-utils.
 */

import { deserializeTaggedJson, serializeTaggedJson } from '../protocol/serialization';

// Msgpack path is intentionally disabled until there is a tested, equivalent codec.
const USE_MSGPACK = false;

export const encode = <T>(data: T): Buffer => Buffer.from(serializeTaggedJson(data));

export const decode = <T>(buffer: Buffer): T => deserializeTaggedJson<T>(buffer.toString());

export { USE_MSGPACK };
