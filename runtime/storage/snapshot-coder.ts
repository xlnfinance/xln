/**
 * Unified snapshot encoder/decoder.
 * JSON mode is canonical, deterministic, and BigInt-safe via serialization-utils.
 */

import { deserializeTaggedJson, serializeTaggedJson } from '../protocol/serialization';

export const encode = <T>(data: T): Buffer => Buffer.from(serializeTaggedJson(data));

export const decode = <T>(buffer: Buffer): T => deserializeTaggedJson<T>(buffer.toString());

import { Buffer } from '../infra/platform-crypto';
