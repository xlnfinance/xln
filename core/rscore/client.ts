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
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

export const RSCORE_ABI_MAGIC = 0x03;
export const RSCORE_ABI_DOMAIN = 'xln.rscore.account';
/**
 * Deadline for one request/response round trip. Generous next to the largest
 * observed wave, tight enough that a wedged engine fails the run instead of
 * hanging it.
 */
const REQUEST_TIMEOUT_MS = Number(
  (typeof process === 'undefined' ? undefined : process.env['XLN_RSCORE_REQUEST_TIMEOUT_MS'])
  ?? '60000',
);

export const RSCORE_ABI_VERSION = 1;
export const RSCORE_PROCESS_ABI_VERSION = 1;
export const RSCORE_PROCESS_PROFILE = 'payment-v1';
export const RSCORE_PROTOCOL_VERSION = 1;
export const RSCORE_STORAGE_SCHEMA_VERSION = 1;
// sha256("xln.rscore.account:v1:protocol=1:storage=1:hanko:payment-v1")
export const RSCORE_PROTOCOL_FINGERPRINT = Buffer.from(
  '8d08cd9da652b342f3ac3e6c5950f4bb53cdaeabfca13f23431cb2cd8d02902b',
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
  upsertAccounts: 14,
} as const;

const MESSAGE_KIND_REQUEST = 0;
const MESSAGE_KIND_OK = 1;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;

export type RscoreWireValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | RscoreWireValue[];

// Bit-exact MessagePack writer/reader mirroring rscore's abi encoder: the
// Rust decoder re-encodes every envelope and byte-compares, so the TS side
// must produce exactly the same minimal encodings (unsigned-minimal ints,
// bin8/16/32 for bytes, fixstr/str8+, fixarray/array16/32).
const packValue = (value: RscoreWireValue): Buffer => {
  const chunks: Buffer[] = [];
  writeValue(chunks, value);
  return Buffer.concat(chunks);
};

const writeValue = (out: Buffer[], value: RscoreWireValue): void => {
  if (value === null) { out.push(Buffer.from([0xc0])); return; }
  if (typeof value === 'boolean') { out.push(Buffer.from([value ? 0xc3 : 0xc2])); return; }
  if (typeof value === 'number' || typeof value === 'bigint') { writeInteger(out, BigInt(value)); return; }
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

const readValue = (cursor: ReadCursor): unknown => {
  const marker = cursor.buffer[cursor.offset]!;
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
    value = value * 256 + cursor.buffer[cursor.offset + index]!;
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
  for (let index = 0; index < 8; index += 1) value = (value << 8n) + BigInt(cursor.buffer[cursor.offset + index]!);
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
  cursor.offset += length;
  return Buffer.from(value);
};

const readText = (cursor: ReadCursor, length: number): string => {
  const value = cursor.buffer.toString('utf8', cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return value;
};

const readArray = (cursor: ReadCursor, length: number): unknown[] => {
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) values.push(readValue(cursor));
  return values;
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

/**
 * Decode one reply and bind it to the request it answers.
 *
 * The engine validates every request field (digest, declared length, canonical
 * bytes, trailing bytes); replies were only checked for magic, arity and
 * domain, so a stale, cross-session or truncated-but-decodable frame would be
 * accepted as the answer to whatever request happened to be first in the FIFO.
 * Everything the request bound is re-checked here.
 */
const decodeEnvelope = (
  frame: Buffer,
  expected: Readonly<{
    identity: RscoreSessionIdentity;
    requestId: bigint;
    opTag: number;
  }>,
): DecodedReply => {
  if (frame[0] !== RSCORE_ABI_MAGIC) throw new Error(`RSCORE_CLIENT_MAGIC_INVALID:${frame[0]}`);
  if (frame[1] !== 0x9e) throw new Error(`RSCORE_CLIENT_ENVELOPE_HEADER:${frame[1]}`);
  const cursor: ReadCursor = { buffer: frame, offset: 2 };
  const head: unknown[] = [];
  for (let index = 0; index < 13; index += 1) head.push(readValue(cursor));
  const bodyBytes = frame.subarray(cursor.offset);

  const bytesEqual = (value: unknown, want: Buffer): boolean =>
    Buffer.isBuffer(value) && value.equals(want);
  const requestIdBytes = Buffer.alloc(8);
  requestIdBytes.writeBigUInt64BE(expected.requestId);

  if (head[0] !== RSCORE_ABI_DOMAIN) throw new Error('RSCORE_CLIENT_DOMAIN_INVALID');
  if (Number(head[1]) !== RSCORE_ABI_VERSION) throw new Error(`RSCORE_CLIENT_ABI_VERSION:${head[1]}`);
  if (Number(head[2]) !== RSCORE_PROTOCOL_VERSION) throw new Error(`RSCORE_CLIENT_PROTOCOL_VERSION:${head[2]}`);
  if (Number(head[3]) !== RSCORE_STORAGE_SCHEMA_VERSION) {
    throw new Error(`RSCORE_CLIENT_STORAGE_VERSION:${head[3]}`);
  }
  if (!bytesEqual(head[4], RSCORE_PROTOCOL_FINGERPRINT)) throw new Error('RSCORE_CLIENT_FINGERPRINT');
  if (!bytesEqual(head[5], expected.identity.engineGeneration)) throw new Error('RSCORE_CLIENT_GENERATION');
  if (!bytesEqual(head[6], expected.identity.runtimeId)) throw new Error('RSCORE_CLIENT_RUNTIME_ID');
  if (!bytesEqual(head[7], expected.identity.sessionId)) throw new Error('RSCORE_CLIENT_SESSION_ID');
  if (!bytesEqual(head[8], requestIdBytes)) {
    throw new Error(`RSCORE_CLIENT_REQUEST_ID:${Buffer.isBuffer(head[8]) ? head[8].toString('hex') : 'invalid'}`);
  }
  const opTag = Number(head[9]);
  if (opTag !== expected.opTag) throw new Error(`RSCORE_CLIENT_OP_TAG:${opTag}`);
  const messageKind = Number(head[10]);
  if (Number(head[11]) !== bodyBytes.length) {
    throw new Error(`RSCORE_CLIENT_BODY_LENGTH:${head[11]}!=${bodyBytes.length}`);
  }
  const digest = bodyDigest(expected.identity.runtimeId, opTag, messageKind, bodyBytes);
  if (!bytesEqual(head[12], digest)) throw new Error('RSCORE_CLIENT_BODY_DIGEST');

  const bodyCursor: ReadCursor = { buffer: bodyBytes, offset: 0 };
  const body = readValue(bodyCursor);
  if (bodyCursor.offset !== bodyBytes.length) {
    throw new Error(`RSCORE_CLIENT_BODY_TRAILING:${bodyBytes.length - bodyCursor.offset}`);
  }
  return { opTag, messageKind, body };
};

export class RscoreProcessClient {
  #child: ChildProcessWithoutNullStreams;
  #identity: RscoreSessionIdentity;
  #nextRequestId = 0n;
  #buffer: Buffer = Buffer.alloc(0);
  #waiters: Array<{ resolve: (frame: Buffer) => void; reject: (error: Error) => void }> = [];
  #dead: Error | null = null;
  #stderrTail = '';

  constructor(binaryPath: string, identity: RscoreSessionIdentity) {
    this.#identity = identity;
    // stderr is piped, not inherited: a panic or an abort message is the only
    // evidence of why the engine died, and inheriting it makes that evidence
    // unattributable in a busy host log.
    this.#child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child.stdout.on('data', chunk => this.#onData(chunk as Buffer));
    this.#child.stderr.on('data', (chunk: Buffer) => {
      const text = String(chunk);
      this.#stderrTail = `${this.#stderrTail}${text}`.slice(-STDERR_TAIL_BYTES);
      try { console.error(`[rscore] ${text.trimEnd()}`); } catch { /* observer-only */ }
    });
    this.#child.on('exit', (code, signal) => this.#fail(new Error(
      `RSCORE_PROCESS_EXITED:code=${String(code)}:signal=${String(signal)}:stderr=${
        this.#stderrTail.trim() || '<empty>'}`,
    )));
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
    // A live-but-wedged process (header written, body never finished) would
    // otherwise leave this promise pending forever and hang every caller that
    // waits on the mirror. The deadline turns that into a loud failure.
    const reply = new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new Error(`RSCORE_CLIENT_REQUEST_TIMEOUT:op=${opTag}:ms=${REQUEST_TIMEOUT_MS}`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.#waiters.push({
        resolve: (frame: Buffer) => { clearTimeout(timer); resolve(frame); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      });
    });
    if (!this.#child.stdin.write(framed)) await once(this.#child.stdin, 'drain');
    const decoded = decodeEnvelope(await reply, {
      identity: this.#identity,
      requestId,
      opTag,
    });
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

  /** Create or replace accounts between waves; replies [revision, accountsRoot]. */
  async upsertAccounts(accounts: RscoreWireValue[]): Promise<unknown> {
    return this.request(RSCORE_OP.upsertAccounts, [accounts]);
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
