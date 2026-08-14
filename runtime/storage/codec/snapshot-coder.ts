/**
 * Canonical tagged-JSON snapshot codec for public debug and test tooling.
 * Decoding intentionally returns unknown: callers must validate persisted or
 * network-controlled bytes before treating them as a protocol type.
 */

import { deserializeTaggedJson, serializeTaggedJson } from '../../protocol/serialization';

export const encode = (data: unknown): Buffer => Buffer.from(serializeTaggedJson(data));

export const decode = (buffer: Buffer): unknown => deserializeTaggedJson(buffer.toString());

import { Buffer } from '../../infra/platform-crypto';
