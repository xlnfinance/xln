#!/usr/bin/env bun

import { createHash } from 'node:crypto';

import {
  packWireValue,
  RSCORE_OP,
  RSCORE_PROTOCOL_FINGERPRINT,
  unpackWireValue,
  type RscoreWireValue,
} from '../../../rscore/client';

const DOMAIN = 'xln.rscore.account';
const GENERATION = Buffer.alloc(8, 0xa0);
const RUNTIME_ID = Buffer.alloc(20, 0x10);
const SESSION_ID = Buffer.alloc(16, 0x20);

const digest = (opTag: number, messageKind: number, body: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return createHash('sha256')
    .update(DOMAIN)
    .update(RSCORE_PROTOCOL_FINGERPRINT)
    .update(RUNTIME_ID)
    .update(Buffer.from([opTag, messageKind]))
    .update(length)
    .update(body)
    .digest();
};

const reply = (
  requestId: bigint,
  opTag: number,
  value: RscoreWireValue,
  abiVersion: RscoreWireValue = 1,
  messageKind = 1,
): Buffer => {
  const requestIdBytes = Buffer.alloc(8);
  requestIdBytes.writeBigUInt64BE(requestId);
  const body = packWireValue([value]);
  const fields: RscoreWireValue[] = [
    DOMAIN,
    abiVersion,
    1,
    1,
    RSCORE_PROTOCOL_FINGERPRINT,
    GENERATION,
    RUNTIME_ID,
    SESSION_ID,
    requestIdBytes,
    opTag,
    messageKind,
    body.length,
    digest(opTag, messageKind, body),
  ];
  const envelope = Buffer.concat([
    Buffer.from([0x03, 0x9e]),
    ...fields.map(packWireValue),
    body,
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(envelope.length);
  return Buffer.concat([length, envelope]);
};

const malformed = Buffer.from([0, 0, 0, 1, 0xff]);
let input = Buffer.alloc(0);
let requestCount = 0;
let firstSummarySent = false;
const queuedSummaryReplies: Buffer[] = [];

const summaryObservation = (decoded: unknown[]): RscoreWireValue => {
  const body = decoded[13];
  const payload = Array.isArray(body) ? body[0] : null;
  const cursor = Array.isArray(payload) ? payload[0] : null;
  const tokenIds = Array.isArray(payload) ? payload[2] : null;
  if (!(cursor instanceof Uint8Array) || !Array.isArray(tokenIds)) {
    throw new Error('POISON_FIXTURE_SUMMARY_PAYLOAD');
  }
  return ['observed', cursor[0] ?? -1, Number(tokenIds[0])];
};

const handleRequest = (envelope: Buffer): void => {
  const decoded = unpackWireValue(envelope.subarray(1));
  if (!Array.isArray(decoded)) throw new Error('POISON_FIXTURE_ENVELOPE');
  const requestIdBytes = decoded[8];
  const opTag = Number(decoded[9]);
  if (!(requestIdBytes instanceof Uint8Array) || requestIdBytes.length !== 8) {
    throw new Error('POISON_FIXTURE_REQUEST_ID');
  }
  const requestId = Buffer.from(requestIdBytes).readBigUInt64BE();

  if (opTag === RSCORE_OP.readCapacityBatch) {
    if (requestCount === 0) process.stdout.write(malformed);
    else process.stdout.write(reply(requestId, opTag, ['second-succeeded']));
  } else if (opTag === RSCORE_OP.readAccountEnvelope) {
    const body = decoded[13];
    const payload = Array.isArray(body) ? body[0] : null;
    const accountId = Array.isArray(payload) ? payload[0] : null;
    if (!(accountId instanceof Uint8Array)) throw new Error('POISON_FIXTURE_ACCOUNT_ID');
    const response = reply(requestId, opTag, ['first-succeeded']);
    const unsolicited = reply(requestId + 1n, opTag, ['unsolicited-extra']);
    if (accountId[0] === 0x55) {
      // A boolean is a valid MessagePack value but not the envelope's unsigned
      // ABI version. Its digest remains otherwise valid to isolate decoding.
      process.stdout.write(reply(requestId, opTag, ['must-not-return'], true));
    } else if (accountId[0] === 0x56) {
      // The digest binds this value, but replies have a closed OK/Error kind.
      process.stdout.write(reply(requestId, opTag, ['must-not-return'], 1, 3));
    } else if (accountId[0] === 0x44) {
      // Leave only one byte of the next frame in the same stdout write. The
      // rest arrives later, after the valid response would otherwise escape.
      process.stdout.write(Buffer.concat([response, unsolicited.subarray(0, 1)]));
      setTimeout(() => process.stdout.write(unsolicited.subarray(1)), 25);
    } else {
      process.stdout.write(Buffer.concat([response, unsolicited]));
    }
  } else if (opTag === RSCORE_OP.readAccountSummaryPage) {
    const response = reply(requestId, opTag, summaryObservation(decoded));
    if (requestCount === 0) {
      setTimeout(() => {
        process.stdout.write(response);
        firstSummarySent = true;
        for (const queued of queuedSummaryReplies.splice(0)) process.stdout.write(queued);
      }, 25);
    } else if (firstSummarySent) {
      process.stdout.write(response);
    } else {
      queuedSummaryReplies.push(response);
    }
  } else {
    throw new Error(`POISON_FIXTURE_OP:${opTag}`);
  }
  requestCount += 1;
};

process.stdin.on('data', chunk => {
  input = Buffer.concat([input, Buffer.from(chunk)]);
  while (input.length >= 4) {
    const length = input.readUInt32BE(0);
    if (input.length < length + 4) return;
    const envelope = input.subarray(4, length + 4);
    input = input.subarray(length + 4);
    handleRequest(envelope);
  }
});
process.stdin.resume();
