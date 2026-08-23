/**
 * TS client for the Rust account engine process (`rscore/crates/process`).
 *
 * Wire: 4-byte big-endian length frames over stdin/stdout; each frame is one
 * ABI envelope — magic 0x03 + one MessagePack array of 14 fields:
 * [domain, abiVersion, protocolVersion, storageSchemaVersion,
 *  protocolFingerprint(32), engineGeneration(8), runtimeId(20), sessionId(16),
 *  requestId(8), opTag, messageKind, bodyLength, bodyDigest(32), body].
 * The body digest binds domain, fingerprint, runtimeId, opTag, messageKind and
 * the exact body bytes, so the two sides cannot disagree about what was asked.
 *
 * The session is strictly sequential (request ids 0,1,2,…) — one in-flight
 * request per client. The engine is OPTIONAL: nothing in the runtime imports
 * this module unless the rscore flag wiring asks for it.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { Packr } from 'msgpackr';

export const RSCORE_ABI_MAGIC = 0x03;
export const RSCORE_ABI_DOMAIN = 'xln.rscore.account';
export const RSCORE_ABI_VERSION = 1;
export const RSCORE_PROCESS_ABI_VERSION = 1;
export const RSCORE_PROCESS_PROFILE = 'payment-v1';
export const RSCORE_PROTOCOL_VERSION = 1;
export const RSCORE_STORAGE_SCHEMA_VERSION = 1;
// sha256("xln.rscore.account:v1:protocol=1:storage=1:hanko:payment-v1")
export const RSCORE_PROTOCOL_FINGERPRINT = Buffer.from(
  '883bd6650cbc2fdd9ff73ada850f1b876c976f53d3721b987b615e9304333d4f',
  'hex',
);

export const RSCORE_OP = {
  hello: 0,
  restoreCheckpoint: 1,
  readCapacityBatch: 4,
  executeWave: 5,
  commitRuntime: 10,
  abortRuntime: 11,
  readAccountSummaryPage: 12,
  shutdown: 13,
} as const;

const MESSAGE_KIND_REQUEST = 0;
const MESSAGE_KIND_OK = 1;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type RscoreWireValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | RscoreWireValue[];

// Value-only MessagePack, arrays stay arrays — mirrors the Rust abi parser.
const packr = new Packr({ mapsAsObjects: false, moreTypes: true, useRecords: false });

const packValue = (value: RscoreWireValue): Buffer => Buffer.from(packr.pack(normalize(value)));

const normalize = (value: RscoreWireValue): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'bigint') {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    return value;
  }
  return value;
};

const bodyDigest = (
  runtimeId: Buffer,
  opTag: number,
  messageKind: number,
  bodyBytes: Buffer,
): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bodyBytes.length);
  return createHash('sha256')
    .update(RSCORE_ABI_DOMAIN)
    .update(RSCORE_PROTOCOL_FINGERPRINT)
    .update(runtimeId)
    .update(Buffer.from([opTag]))
    .update(Buffer.from([messageKind]))
    .update(length)
    .update(bodyBytes)
    .digest();
};

export type RscoreSessionIdentity = Readonly<{
  engineGeneration: Buffer; // 8 bytes
  runtimeId: Buffer; // 20 bytes
  sessionId: Buffer; // 16 bytes
}>;

const encodeEnvelope = (
  identity: RscoreSessionIdentity,
  requestId: bigint,
  opTag: number,
  payload: RscoreWireValue[],
): Buffer => {
  const requestIdBytes = Buffer.alloc(8);
  requestIdBytes.writeBigUInt64BE(requestId);
  // body = one payload tuple (BODY_ARITY = 1 on the Rust side)
  const bodyBytes = packValue([payload]);
  const digest = bodyDigest(identity.runtimeId, opTag, MESSAGE_KIND_REQUEST, bodyBytes);
  const head = [
    RSCORE_ABI_DOMAIN,
    RSCORE_ABI_VERSION,
    RSCORE_PROTOCOL_VERSION,
    RSCORE_STORAGE_SCHEMA_VERSION,
    RSCORE_PROTOCOL_FINGERPRINT,
    identity.engineGeneration,
    identity.runtimeId,
    identity.sessionId,
    requestIdBytes,
    opTag,
    MESSAGE_KIND_REQUEST,
    bodyBytes.length,
    digest,
  ] as const;
  // Outer msgpack array of 14: header byte 0x9E, then the 13 head fields and
  // the raw body bytes (already a complete msgpack value) concatenated —
  // msgpack values compose by concatenation under an explicit array header.
  const headBytes = head.map(field => packValue(field as RscoreWireValue));
  // fixarray(14) = 0x9e
  return Buffer.concat([Buffer.from([RSCORE_ABI_MAGIC, 0x9e]), ...headBytes, bodyBytes]);
};

type DecodedReply = Readonly<{
  opTag: number;
  messageKind: number;
  body: unknown;
}>;

const decodeEnvelope = (frame: Buffer): DecodedReply => {
  if (frame[0] !== RSCORE_ABI_MAGIC) throw new Error(`RSCORE_CLIENT_MAGIC_INVALID:${frame[0]}`);
  const outer = packr.unpack(frame.subarray(1)) as unknown[];
  if (!Array.isArray(outer) || outer.length !== 14) {
    throw new Error(`RSCORE_CLIENT_ENVELOPE_ARITY:${Array.isArray(outer) ? outer.length : typeof outer}`);
  }
  if (outer[0] !== RSCORE_ABI_DOMAIN) throw new Error('RSCORE_CLIENT_DOMAIN_INVALID');
  return {
    opTag: Number(outer[9]),
    messageKind: Number(outer[10]),
    body: outer[13],
  };
};

export class RscoreProcessClient {
  #child: ChildProcessByStdio<Writable, Readable, null>;
  #identity: RscoreSessionIdentity;
  #nextRequestId = 0n;
  #buffer: Buffer = Buffer.alloc(0);
  #waiters: Array<{ resolve: (frame: Buffer) => void; reject: (error: Error) => void }> = [];
  #dead: Error | null = null;

  constructor(binaryPath: string, identity: RscoreSessionIdentity) {
    this.#identity = identity;
    this.#child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.#child.stdout.on('data', chunk => this.#onData(chunk as Buffer));
    this.#child.on('exit', code => this.#fail(new Error(`RSCORE_PROCESS_EXITED:${String(code)}`)));
    this.#child.on('error', error => this.#fail(error as Error));
  }

  #fail(error: Error): void {
    if (this.#dead) return;
    this.#dead = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  #onData(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.#fail(new Error(`RSCORE_CLIENT_FRAME_LENGTH:${length}`));
        return;
      }
      if (this.#buffer.length < 4 + length) return;
      const frame = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      const waiter = this.#waiters.shift();
      if (!waiter) {
        this.#fail(new Error('RSCORE_CLIENT_UNEXPECTED_FRAME'));
        return;
      }
      waiter.resolve(Buffer.from(frame));
    }
  }

  async request(opTag: number, payload: RscoreWireValue[]): Promise<unknown> {
    if (this.#dead) throw this.#dead;
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1n;
    const envelope = encodeEnvelope(this.#identity, requestId, opTag, payload);
    const framed = Buffer.alloc(4 + envelope.length);
    framed.writeUInt32BE(envelope.length);
    envelope.copy(framed, 4);
    const reply = new Promise<Buffer>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
    if (!this.#child.stdin.write(framed)) await once(this.#child.stdin, 'drain');
    const decoded = decodeEnvelope(await reply);
    if (decoded.messageKind !== MESSAGE_KIND_OK) {
      const body = decoded.body as unknown[];
      const error = Array.isArray(body) && Array.isArray(body[0]) ? body[0] : body;
      throw new Error(`RSCORE_PROCESS_ERROR:${JSON.stringify(error)}`);
    }
    const body = decoded.body as unknown[];
    return Array.isArray(body) && body.length === 1 ? body[0] : body;
  }

  async hello(workerCount: number): Promise<unknown> {
    return this.request(RSCORE_OP.hello, [RSCORE_PROCESS_ABI_VERSION, workerCount]);
  }

  async restore(revision: number, accounts: RscoreWireValue[]): Promise<unknown> {
    return this.request(RSCORE_OP.restoreCheckpoint, [RSCORE_PROCESS_PROFILE, revision, accounts]);
  }

  async prepare(jobs: RscoreWireValue[]): Promise<unknown> {
    return this.request(RSCORE_OP.executeWave, [jobs]);
  }

  async commit(prepareRequestId: Buffer): Promise<unknown> {
    return this.request(RSCORE_OP.commitRuntime, [prepareRequestId]);
  }

  async abort(prepareRequestId: Buffer): Promise<unknown> {
    return this.request(RSCORE_OP.abortRuntime, [prepareRequestId]);
  }

  async readCapacityBatch(rows: Array<[Uint8Array, number, number]>): Promise<unknown> {
    return this.request(RSCORE_OP.readCapacityBatch, [rows as RscoreWireValue[]]);
  }

  async readAccountSummaryPage(
    cursor: Uint8Array | null,
    limit: number,
    tokenIds: number[],
  ): Promise<unknown> {
    return this.request(RSCORE_OP.readAccountSummaryPage, [cursor, limit, tokenIds]);
  }

  async shutdown(): Promise<void> {
    await this.request(RSCORE_OP.shutdown, []);
    this.#child.stdin.end();
  }

  requestIdBytes(requestId: bigint): Buffer {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(requestId);
    return bytes;
  }

  get lastRequestId(): bigint {
    return this.#nextRequestId - 1n;
  }

  kill(): void {
    this.#child.kill('SIGKILL');
  }
}
