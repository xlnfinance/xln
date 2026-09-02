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
import { RSCORE_CUTOVER_VERIFY } from './cutover/verify';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { safeStringify } from '../protocol/serialization';
import {
  decodeRscoreCheckpointChanges,
  decodeRscoreCheckpointToken,
  rscoreCheckpointBytes,
  type RscoreCheckpointChanges,
  type RscoreCheckpointToken,
} from './checkpoint/checkpoint-wire';
import {
  packWireValue,
  unpackWireValue,
  unpackWireValueAt,
  type RscoreWireValue,
} from './process-wire-value';
import { decodeEntityRound, type RscoreEntityRound } from './entity/round-wire';
import { RscoreResponseFrameQueue } from './process/response-frame-queue';
export { packWireValue, unpackWireValue } from './process-wire-value';
export type { RscoreWireValue } from './process-wire-value';
export type {
  RscoreCheckpointChanges,
  RscoreCheckpointToken,
  RscoreExactCheckpoint,
} from './checkpoint/checkpoint-wire';

const RSCORE_ABI_MAGIC = 0x03;
const RSCORE_ABI_DOMAIN = 'xln.rscore.account';
/**
 * Deadline for one request/response round trip. Generous next to the largest
 * observed wave, tight enough that a wedged engine fails the run instead of
 * hanging it.
 */
const requestTimeoutMs = (): number => {
  const value = Number(
    (typeof process === 'undefined' ? undefined : process.env['XLN_RSCORE_REQUEST_TIMEOUT_MS'])
    ?? '60000',
  );
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`RSCORE_REQUEST_TIMEOUT_INVALID:${String(value)}`);
  }
  return value;
};
const REQUEST_TIMEOUT_MS = requestTimeoutMs();

const RSCORE_ABI_VERSION = 1;
// 2: Hello carries the authority config, and the authoritative wave joins the
// op set. An engine built against the old Hello fails at Hello, not later.
// 5: that config carries the signer key instead of the runtime seed.
// 6: exact recovery carries the full durable Account consensus snapshot.
// 7: the diagnostic envelope read and exact checkpoint operations coexist at
// distinct tags in one closed operation set.
// 8: checkpoint rows are bound to one pending authority wave and carry
// separate commit and exact-restore tokens.
// 9: an authority wave is one held candidate with repeatable Apply/Propose
// stages and an explicit Seal before checkpoint or commit.
// 10: Account creation is an atomic candidate operation rather than a
// committed upsert performed before or after the Runtime frame.
// 11: Prepare returns one opaque server-issued bin32 capability consumed by
// every later operation on that candidate.
// 12: commit verdicts carry exact committed-frame evidence and exact
// checkpoint ACK rows retain the frame Hanko required after restart.
// 13: every parent Entity input owns an abortable Account savepoint. Apply and
// Propose are bound to its content-derived key; Seal cannot cross an open
// stage, and accept/rollback advance the explicit accepted-stage ordinal.
// 14: Account inputs carry the exact Account envelope plus the closed
// Frame/Ack/AckFrame shapes. AckFrame is one ACK-first operation and returns
// one ordered composite row; its valid ACK survives a rejected proposal.
// 21: inbound-first Account genesis carries trusted Entity policy and returns
// its exact H=1 materialization separately from the final touched rows.
// 23: a resident round reply carries one optional exact incremental checkpoint
// manifest; the next input root selects or rejects its pending baseline.
// 24: swap-offer removal carries the maker side observed by the Account
// transition, so Entity never needs a stale Account read model.
// 25: AccountSettled J-claim bodies, witnesses and typed finality output.
// 26: exact checkpoints persist the J-claim Patricia nodes needed to prove
// non-empty accumulator roots after a process restart.
// 27: one resident Entity round owns Account inbound, paybook/orderbook work,
// and Account outbound without returning Account replicas to TypeScript.
// 28: swap removal retains the exact maker side after the row leaves state.
// 29: AccountSettled carries J-claim bodies, witnesses and finality output.
// 30: exact checkpoints retain the J-claim Patricia node store.
// 31: Entity snapshots carry crontab state and PreparedFinal descriptions.
// 32: incoming verdicts carry an explicit signed DisputeRequired outcome.
// 33: Entity snapshots carry reserves, and Account input verdicts carry standalone
// dispute / board-Hanko-refresh results without aliasing frame verdict tags.
// 34: Account frames no longer duplicate deltas or proposer side.
// 35: Account input rows carry full peer/local certified-board authority.
// 36: Entity snapshots carry the bounded Entity-command nonce fence.
// 38: fresh Account bootstrap returns its exact empty checkpoint with the
// loaded root, so an idle Runtime persists one canonical restore base.
// 39: one explicit checkpoint barrier exports the accepted Account forest
// without manufacturing an Entity round.
export const RSCORE_PROCESS_ABI_VERSION = 39;
export const RSCORE_PROCESS_PROFILE = 'payment-v1';
const RSCORE_PROTOCOL_VERSION = 1;
const RSCORE_STORAGE_SCHEMA_VERSION = 1;
// sha256("xln.rscore.account:v1:protocol=1:storage=1:hanko:payment-v1:wire=36")
export const RSCORE_PROTOCOL_FINGERPRINT = Buffer.from(
  '0d0e71b61e8319a6a3514059b0167b56f0b03a22422937731184b4b3a9cfaceb',
  'hex',
);

export const RSCORE_OP = {
  hello: 0,
  bootstrapAccounts: 1,
  readCapacityBatch: 4,
  executeWave: 5,
  commitRuntime: 10,
  abortRuntime: 11,
  readAccountSummaryPage: 12,
  shutdown: 13,
  upsertAccounts: 14,
  updateAccountShells: 15,
  removeAccounts: 16,
  readAccountEnvelope: 18,
  restoreExact: 21,
  checkpoint: 30,
  bootstrapEntity: 27,
  entityRound: 28,
} as const;

/**
 * Bytes crossing the process boundary, counted for measurement only.
 *
 * The engine's own work is cheap; what a reply costs to serialize, ship and
 * decode is not, and that cost is invisible unless something counts it.
 */
export const rscoreTransportBytes = { sent: 0, received: 0 };

const MESSAGE_KIND_REQUEST = 0;
const MESSAGE_KIND_OK = 1;
const MESSAGE_KIND_ERROR = 2;
// Rust accepts a 63 MiB request body inside a 64 MiB framed response. Keep the
// two directions distinct: allowing a 64 MiB request here would kill the
// session after the client had already consumed its request id.
const MAX_REQUEST_FRAME_BYTES = 63 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;

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
  bodyBytes: Buffer,
): Buffer => {
  const requestIdBytes = Buffer.alloc(8);
  requestIdBytes.writeBigUInt64BE(requestId);
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
  const headBytes = head.map(field => packWireValue(field as RscoreWireValue));
  // fixarray(14) = 0x9e
  return Buffer.concat([Buffer.from([RSCORE_ABI_MAGIC, 0x9e]), ...headBytes, bodyBytes]);
};

type DecodedReply = Readonly<{
  opTag: number;
  messageKind: number;
  body: unknown;
}>;

type ResponseWaiter = Readonly<{
  resolve: (frame: Buffer) => void;
  reject: (error: Error) => void;
}>;

/** Own caller-retained arrays and bytes before this request joins the queue. */
const ownWireValue = (value: RscoreWireValue): RscoreWireValue => {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(ownWireValue);
  throw new Error(`RSCORE_CLIENT_VALUE_UNSUPPORTED:${typeof value}`);
};

const ownWirePayload = (payload: RscoreWireValue[]): RscoreWireValue[] =>
  payload.map(ownWireValue);

const exactUnsigned = (value: unknown, code: string): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (
    typeof value === 'bigint' &&
    value >= 0n &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  throw new Error(`${code}:${String(value)}`);
};

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
  const head: unknown[] = [];
  let offset = 2;
  for (let index = 0; index < 13; index += 1) {
    const decoded = unpackWireValueAt(frame, offset);
    head.push(decoded.value);
    offset = decoded.nextOffset;
  }
  const bodyBytes = frame.subarray(offset);

  const bytesEqual = (value: unknown, want: Buffer): boolean =>
    Buffer.isBuffer(value) && value.equals(want);
  const requestIdBytes = Buffer.alloc(8);
  requestIdBytes.writeBigUInt64BE(expected.requestId);

  if (head[0] !== RSCORE_ABI_DOMAIN) throw new Error('RSCORE_CLIENT_DOMAIN_INVALID');
  const abiVersion = exactUnsigned(head[1], 'RSCORE_CLIENT_ABI_VERSION');
  if (abiVersion !== RSCORE_ABI_VERSION) throw new Error(`RSCORE_CLIENT_ABI_VERSION:${abiVersion}`);
  const protocolVersion = exactUnsigned(head[2], 'RSCORE_CLIENT_PROTOCOL_VERSION');
  if (protocolVersion !== RSCORE_PROTOCOL_VERSION) {
    throw new Error(`RSCORE_CLIENT_PROTOCOL_VERSION:${protocolVersion}`);
  }
  const storageVersion = exactUnsigned(head[3], 'RSCORE_CLIENT_STORAGE_VERSION');
  if (storageVersion !== RSCORE_STORAGE_SCHEMA_VERSION) {
    throw new Error(`RSCORE_CLIENT_STORAGE_VERSION:${head[3]}`);
  }
  if (!bytesEqual(head[4], RSCORE_PROTOCOL_FINGERPRINT)) throw new Error('RSCORE_CLIENT_FINGERPRINT');
  if (!bytesEqual(head[5], expected.identity.engineGeneration)) throw new Error('RSCORE_CLIENT_GENERATION');
  if (!bytesEqual(head[6], expected.identity.runtimeId)) throw new Error('RSCORE_CLIENT_RUNTIME_ID');
  if (!bytesEqual(head[7], expected.identity.sessionId)) throw new Error('RSCORE_CLIENT_SESSION_ID');
  if (!bytesEqual(head[8], requestIdBytes)) {
    throw new Error(`RSCORE_CLIENT_REQUEST_ID:${Buffer.isBuffer(head[8]) ? head[8].toString('hex') : 'invalid'}`);
  }
  const opTag = exactUnsigned(head[9], 'RSCORE_CLIENT_OP_TAG');
  if (opTag !== expected.opTag) throw new Error(`RSCORE_CLIENT_OP_TAG:${opTag}`);
  const messageKind = exactUnsigned(head[10], 'RSCORE_CLIENT_MESSAGE_KIND');
  if (messageKind !== MESSAGE_KIND_OK && messageKind !== MESSAGE_KIND_ERROR) {
    throw new Error(`RSCORE_CLIENT_MESSAGE_KIND:${messageKind}`);
  }
  const bodyLength = exactUnsigned(head[11], 'RSCORE_CLIENT_BODY_LENGTH');
  if (bodyLength !== bodyBytes.length) {
    throw new Error(`RSCORE_CLIENT_BODY_LENGTH:${head[11]}!=${bodyBytes.length}`);
  }
  const digest = bodyDigest(expected.identity.runtimeId, opTag, messageKind, bodyBytes);
  if (!bytesEqual(head[12], digest)) throw new Error('RSCORE_CLIENT_BODY_DIGEST');

  const body = unpackWireValue(bodyBytes);
  return { opTag, messageKind, body };
};

export class RscoreProcessClient {
  #child: ChildProcessWithoutNullStreams;
  #identity: RscoreSessionIdentity;
  #nextRequestId = 0n;
  #responseFrames = new RscoreResponseFrameQueue();
  #waiter: ResponseWaiter | null = null;
  #requestTurn: Promise<void> = Promise.resolve();
  #dead: Error | null = null;
  #stderrTail = '';

  constructor(binaryPath: string, identity: RscoreSessionIdentity) {
    this.#identity = identity;
    // stderr is piped, not inherited: a panic or an abort message is the only
    // evidence of why the engine died, and inheriting it makes that evidence
    // unattributable in a busy host log.
    this.#child = spawn(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // The engine never authors the Account envelope, so it echoes one back
      // only when this side intends to re-derive the leaf from it.
      env: { ...process.env, XLN_RSCORE_CARRY_ENVELOPE: RSCORE_CUTOVER_VERIFY ? '1' : '0' },
    });
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
    // Without this an EPIPE on a closed pipe is an unhandled error event, and
    // a writer parked on 'drain' would never learn the peer is gone.
    this.#child.stdin.on('error', error => this.#fail(error as Error));
  }

  #fail(error: Error): void {
    if (this.#dead) return;
    this.#dead = error;
    this.#responseFrames.reset();
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.reject(error);
    if (this.#child.exitCode === null && !this.#child.killed) {
      this.#child.kill('SIGKILL');
    }
  }

  #onData(chunk: Buffer): void {
    if (this.#dead || chunk.length === 0) return;
    rscoreTransportBytes.received += chunk.length;
    // Requests are serialized and install their sole waiter before writing.
    // Therefore any stdout byte observed without that waiter is unsolicited,
    // even when it is only a fragment too short to contain a frame header.
    if (this.#waiter === null) {
      this.#fail(new Error('RSCORE_CLIENT_UNEXPECTED_FRAME'));
      return;
    }
    let frame: Buffer | null;
    try {
      frame = this.#responseFrames.push(chunk);
    } catch (cause) {
      this.#fail(cause instanceof Error ? cause : new Error(String(cause)));
      return;
    }
    if (frame === null) return;
    const waiter = this.#waiter;
    if (!waiter) {
      this.#fail(new Error('RSCORE_CLIENT_UNEXPECTED_FRAME'));
      return;
    }
    this.#waiter = null;
    waiter.resolve(frame);
  }

  async #requestWithId(
    opTag: number,
    payload: RscoreWireValue[],
  ): Promise<{ result: unknown; requestId: bigint }> {
    const ownedPayload = ownWirePayload(payload);
    return this.#withRequestTurn(() => this.#requestOwnedNow(opTag, ownedPayload));
  }

  async #withRequestTurn<T>(operation: () => Promise<T>): Promise<T> {
    let releaseTurn = (): void => {};
    const previousTurn = this.#requestTurn;
    this.#requestTurn = new Promise<void>(resolve => { releaseTurn = resolve; });
    await previousTurn;
    try {
      return await operation();
    } finally {
      releaseTurn();
    }
  }

  async #requestOwnedNow(
    opTag: number,
    payload: RscoreWireValue[],
  ): Promise<{ result: unknown; requestId: bigint }> {
    // body = one payload tuple (BODY_ARITY = 1 on the Rust side). Encoding is
    // inside the serialized turn; caller-owned values were copied before it.
    const bodyBytes = packWireValue([payload]);
    return this.#requestNow(opTag, bodyBytes);
  }

  async #authorityRequestOwnedNow(
    opTag: number,
    payload: RscoreWireValue[],
  ): Promise<{ result: unknown; requestId: bigint }> {
    let requestCommitted = false;
    try {
      const bodyBytes = packWireValue([payload]);
      return await this.#requestNow(opTag, bodyBytes, () => { requestCommitted = true; });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      // Encoding and frame-size failures happen before the request id is
      // consumed, so the held candidate is still exact and may be retried or
      // aborted. Once consumption starts, an authority error is ambiguous:
      // Rust may have mutated the candidate even if no usable reply survived.
      if (requestCommitted) throw this.#poisonAuthority(error);
      throw error;
    }
  }

  async #requestNow(
    opTag: number,
    bodyBytes: Buffer,
    onRequestCommitted?: () => void,
  ): Promise<{ result: unknown; requestId: bigint }> {
    if (this.#dead) throw this.#dead;
    const requestId = this.#nextRequestId;
    const envelope = encodeEnvelope(this.#identity, requestId, opTag, bodyBytes);
    // The engine refuses an oversized frame and exits, so the caller would
    // otherwise see EPIPE and a dead mirror instead of the actual cause. A
    // wave that does not fit is the caller's to split.
    if (envelope.length > MAX_REQUEST_FRAME_BYTES) {
      throw new Error(
        `RSCORE_CLIENT_REQUEST_TOO_LARGE:op=${opTag}:bytes=${envelope.length}:max=${MAX_REQUEST_FRAME_BYTES}`,
      );
    }
    // Only now: the session pins request ids to an exact sequence, so an id
    // spent on a request that was never written would make every later request
    // fail the sequence check and take the process down with it. Encoding and
    // the size check both happen before the id is consumed.
    onRequestCommitted?.();
    this.#nextRequestId += 1n;
    const framed = Buffer.alloc(4 + envelope.length);
    framed.writeUInt32BE(envelope.length);
    envelope.copy(framed, 4);
    // A live-but-wedged process (header written, body never finished) would
    // otherwise leave this promise pending forever and hang every caller that
    // waits on the mirror. The deadline turns that into a loud failure.
    const reply = new Promise<Buffer>((resolve, reject) => {
      if (this.#waiter !== null) {
        const error = new Error('RSCORE_CLIENT_CONCURRENT_WAITER');
        this.#fail(error);
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        this.#fail(new Error(`RSCORE_CLIENT_REQUEST_TIMEOUT:op=${opTag}:ms=${REQUEST_TIMEOUT_MS}`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.#waiter = {
        resolve: (frame: Buffer) => { clearTimeout(timer); resolve(frame); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      };
    });
    let backpressured: boolean;
    try {
      rscoreTransportBytes.sent += framed.length;
      backpressured = !this.#child.stdin.write(framed);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.#fail(error);
      throw error;
    }
    if (backpressured) {
      // Backpressure is raced against the reply, which already carries the
      // request deadline and every process-death path. Awaiting 'drain' alone
      // parked this call forever when the engine died with a full pipe: the
      // waiter was already rejected, but execution had not reached it yet.
      await Promise.race([
        once(this.#child.stdin, 'drain'),
        reply.then(() => undefined),
      ]);
    }
    let decoded: DecodedReply;
    try {
      decoded = decodeEnvelope(await reply, {
        identity: this.#identity,
        requestId,
        opTag,
      });
    } catch (cause) {
      // The reply was already consumed. Continuing would shift the strict
      // request sequence and, for an authority stage, could strand a mutated
      // candidate whose token the caller never received. A binding/codec
      // failure therefore poisons the whole session.
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.#fail(error);
      throw error;
    }
    // stdout can contain more than the frame that just resolved `reply`.
    // `#onData` parses the whole chunk synchronously, so an unsolicited next
    // frame may already have poisoned the session before this continuation
    // decodes the otherwise valid current frame. Never return success from a
    // session whose framing invariant has failed.
    if (this.#dead) throw this.#dead;
    if (decoded.messageKind !== MESSAGE_KIND_OK) {
      const body = decoded.body as unknown[];
      const error = Array.isArray(body) && Array.isArray(body[0]) ? body[0] : body;
      throw new Error(`RSCORE_PROCESS_ERROR:${safeStringify(error)}`);
    }
    const body = decoded.body as unknown[];
    return {
      result: Array.isArray(body) && body.length === 1 ? body[0] : body,
      requestId,
    };
  }

  async #request(opTag: number, payload: RscoreWireValue[]): Promise<unknown> {
    return (await this.#requestWithId(opTag, payload)).result;
  }

  #poisonAuthority(cause: unknown): Error {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.#fail(error);
    return error;
  }

  /**
   * `authority` turns this session into one that owns its accounts: it signs
   * with the key it is given and returns signed frames. Without it the session
   * mirrors what the TypeScript engine already decided.
   *
   * The key, not the seed: this runtime derives signer keys from labels of its
   * own choosing, and an engine holding the seed cannot rebuild a label from
   * the address a replica is keyed by. Handing over one key is also the
   * smaller secret — the seed is every signer this runtime will ever have.
   */
  async hello(
    workerCount: number,
    swapMarket: RscoreWireValue[],
    authority?: Readonly<{ privateKey: Uint8Array; signerId: string }>,
  ): Promise<unknown> {
    const payload = ownWirePayload([
      RSCORE_PROCESS_ABI_VERSION,
      workerCount,
      swapMarket,
      authority ? [Buffer.from(authority.privateKey), authority.signerId] : null,
    ]);
    return this.#withRequestTurn(async () => {
      // A rejected authority Hello has crossed the trust boundary: even when
      // the server rejected it before installing a binding, the caller must
      // not catch that error and reuse this child as a mirror. Authority is a
      // session role, never a best-effort capability negotiation.
      const response = authority === undefined
        ? await this.#requestOwnedNow(RSCORE_OP.hello, payload)
        : await this.#authorityRequestOwnedNow(RSCORE_OP.hello, payload);
      return response.result;
    });
  }

  /** Install the exact Entity-owned state beside an already restored Account forest. */
  async bootstrapEntity(snapshot: RscoreWireValue[]): Promise<Readonly<{
    accountsRoot: string;
    ownedSections: readonly Readonly<{ field: string; digest: string }>[];
  }>> {
    const payload = ownWirePayload([snapshot]);
    return this.#withRequestTurn(async () => {
      const response = await this.#authorityRequestOwnedNow(RSCORE_OP.bootstrapEntity, payload);
      try {
        const result = response.result;
        if (!Array.isArray(result) || result.length !== 2) {
          throw new Error('RSCORE_ENTITY_BOOTSTRAP_RESPONSE_ARITY');
        }
        const root = result[0];
        const rows = result[1];
        if (!(root instanceof Uint8Array) || root.byteLength !== 32 || !Array.isArray(rows)) {
          throw new Error('RSCORE_ENTITY_BOOTSTRAP_RESPONSE_INVALID');
        }
        let previous = '';
        const ownedSections = rows.map((value, index) => {
          if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string') {
            throw new Error(`RSCORE_ENTITY_BOOTSTRAP_SECTION_INVALID:${index}`);
          }
          if (value[0] <= previous) {
            throw new Error(`RSCORE_ENTITY_BOOTSTRAP_SECTION_ORDER:${value[0]}`);
          }
          previous = value[0];
          if (!(value[1] instanceof Uint8Array) || value[1].byteLength !== 32) {
            throw new Error(`RSCORE_ENTITY_BOOTSTRAP_SECTION_DIGEST:${value[0]}`);
          }
          return {
            field: value[0],
            digest: `0x${Buffer.from(value[1]).toString('hex')}`,
          };
        });
        return {
          accountsRoot: `0x${Buffer.from(root).toString('hex')}`,
          ownedSections,
        };
      } catch (cause) {
        throw this.#poisonAuthority(cause);
      }
    });
  }

  /** One process crossing for Account inbound + Entity financial work + Account outbound. */
  async entityRound(round: Readonly<{
    ownerEntityId: Uint8Array;
    expectedAccountsRoot: Uint8Array;
    inboundTimestamp: number;
    inboundJHeight: number;
    inboundRows: readonly RscoreWireValue[];
    inboundPostAccounts?: boolean;
    entityHeight: number;
    outboundTimestamp: number;
    outboundJHeight: number;
    checkpointDue: boolean;
    postAccounts: boolean;
    context: RscoreWireValue[];
  }>): Promise<RscoreEntityRound> {
    const payload = ownWirePayload([
      [
        Buffer.from(round.ownerEntityId),
        Buffer.from(round.expectedAccountsRoot),
        [round.inboundTimestamp, round.inboundJHeight],
        [...round.inboundRows],
        round.inboundPostAccounts ?? false,
      ],
      round.entityHeight,
      round.outboundTimestamp,
      round.outboundJHeight,
      round.checkpointDue,
      round.postAccounts,
      round.context,
    ]);
    return this.#withRequestTurn(async () => {
      const response = await this.#authorityRequestOwnedNow(RSCORE_OP.entityRound, payload);
      try {
        return decodeEntityRound(response.result);
      } catch (cause) {
        throw this.#poisonAuthority(cause);
      }
    });
  }

  /** Export the exact accepted Account forest for an isolated Runtime checkpoint barrier. */
  async exportCheckpoint(expectedAccountsRoot: Uint8Array): Promise<RscoreCheckpointChanges> {
    return this.#withRequestTurn(async () => {
      const response = await this.#authorityRequestOwnedNow(
        RSCORE_OP.checkpoint,
        ownWirePayload([Buffer.from(expectedAccountsRoot)]),
      );
      try {
        if (!Array.isArray(response.result) || response.result.length !== 1) {
          throw new Error('RSCORE_CLIENT_CHECKPOINT_RESPONSE_ARITY');
        }
        return decodeRscoreCheckpointChanges(response.result[0]);
      } catch (cause) {
        throw this.#poisonAuthority(cause);
      }
    });
  }

  /**
   * Create a brand-new empty authority, or — only when the caller declares it
   * — import Account state the engine has no checkpoint for. Production never
   * imports: durable history enters through `restoreExact`.
   */
  async bootstrapAccounts(
    revision: number,
    accounts: RscoreWireValue[],
    importExisting = false,
  ): Promise<unknown> {
    return this.#request(RSCORE_OP.bootstrapAccounts, [
      RSCORE_PROCESS_PROFILE,
      revision,
      accounts,
      importExisting,
    ]);
  }

  /** Replace an authority session from materialized canonical Account rows. */
  async restoreExact(
    token: RscoreCheckpointToken,
    accounts: RscoreWireValue[],
  ): Promise<RscoreCheckpointToken> {
    const payload = ownWirePayload([token, accounts]);
    return this.#withRequestTurn(async () => {
      const response = (await this.#authorityRequestOwnedNow(
        RSCORE_OP.restoreExact,
        payload,
      )).result;
      try {
        if (!Array.isArray(response) || response.length !== 1) {
          throw new Error('RSCORE_CLIENT_EXACT_RESTORE_RESPONSE_ARITY');
        }
        return decodeRscoreCheckpointToken(response[0], 'RESTORED');
      } catch (cause) {
        throw this.#poisonAuthority(cause);
      }
    });
  }

  /**
   * Prepare one wave and return the candidate together with the token that
   * commits it. The opaque server capability is distinct from protocol request
   * sequencing and is invalid after abort, commit, session change or restart.
   */
  async prepareCandidate(jobs: RscoreWireValue[]): Promise<{
    candidate: unknown;
    token: Buffer;
  }> {
    const prepared = await this.#requestWithId(RSCORE_OP.executeWave, [jobs]);
    try {
      if (!Array.isArray(prepared.result) || prepared.result.length !== 7) {
        throw new Error('RSCORE_CLIENT_PREPARED_BATCH_ARITY');
      }
      return {
        candidate: prepared.result.slice(0, 6),
        token: Buffer.from(rscoreCheckpointBytes(
          prepared.result[6],
          32,
          'CANDIDATE_TOKEN',
        )),
      };
    } catch (cause) {
      throw this.#poisonAuthority(cause);
    }
  }

  async commit(candidateToken: Buffer): Promise<unknown> {
    return this.#request(RSCORE_OP.commitRuntime, [candidateToken]);
  }

  async abort(candidateToken: Buffer): Promise<unknown> {
    return this.#request(RSCORE_OP.abortRuntime, [candidateToken]);
  }

  /** Create or replace accounts between waves; replies [revision, accountsRoot]. */
  async upsertAccounts(accounts: RscoreWireValue[]): Promise<unknown> {
    return this.#request(RSCORE_OP.upsertAccounts, [accounts]);
  }

  /**
   * Replace replica shells only. Financial state stays exactly where the
   * engine's own execution left it, so this can never paper over a divergence
   * the way a reseed would.
   */
  async updateAccountShells(shells: RscoreWireValue[]): Promise<unknown> {
    return this.#request(RSCORE_OP.updateAccountShells, [shells]);
  }

  /** Drop accounts the mirror stopped following, so the trees stay comparable. */
  async removeAccounts(accountIds: RscoreWireValue[]): Promise<unknown> {
    return this.#request(RSCORE_OP.removeAccounts, [accountIds]);
  }

  async readCapacityBatch(rows: Array<[Uint8Array, number, number]>): Promise<unknown> {
    return this.#request(RSCORE_OP.readCapacityBatch, [rows as RscoreWireValue[]]);
  }

  /**
   * One account's committed leaf projection, field by field. A leaf that
   * disagrees says only that something differs; this says what.
   */
  async readAccountEnvelope(accountId: Uint8Array): Promise<unknown> {
    return this.#request(RSCORE_OP.readAccountEnvelope, [accountId]);
  }

  async readAccountSummaryPage(
    cursor: Uint8Array | null,
    limit: number,
    tokenIds: number[],
  ): Promise<unknown> {
    return this.#request(RSCORE_OP.readAccountSummaryPage, [cursor, limit, tokenIds]);
  }

  async shutdown(): Promise<void> {
    await this.#request(RSCORE_OP.shutdown, []);
    this.#child.stdin.end();
  }

  kill(): void {
    this.#child.kill('SIGKILL');
  }
}
