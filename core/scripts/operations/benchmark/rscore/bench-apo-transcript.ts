#!/usr/bin/env bun

/** Pure Rust Account+Paybook+Orderbook replay over a once-verified H1 transcript. */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

import { safeParse, safeStringify } from '../../../../protocol/serialization';
import { packWireValue, unpackWireValue, type RscoreWireValue } from '../../../../rscore/client';
import { decodeEntityRound, type RscoreEntityRound } from '../../../../rscore/entity/round-wire';

const TRANSCRIPT_MAGIC = Buffer.from('XRSCTR01');
const ABI_MAGIC = 0x03;
const ENTITY_ROUND_OP = 28;
const HELLO_OP = 0;

type TranscriptPair = Readonly<{ request: Buffer; response: Buffer }>;
type ParsedEnvelope = Readonly<{ fields: RscoreWireValue[]; opTag: number; result: unknown }>;
type ApoBenchRow = Readonly<{
  workers: number;
  rounds: number;
  inboundAccountInputs: number;
  outboundAccountInputs: number;
  accountTxs: number;
  engineMs: number;
  boundaryMs: number;
  inboundPerEngineSecond: number;
  outboundPerEngineSecond: number;
  inboundPerBoundarySecond: number;
  outboundPerBoundarySecond: number;
  protocolRowsPerEngineSecond: number;
  protocolRowsPerBoundarySecond: number;
  accountsRoot: string;
  paybookRoot: string;
  orderbookRoot: string;
}>;

const argument = (name: string): string | null => {
  const index = process.argv.indexOf('--' + name);
  if (index < 0) return null;
  const value = String(process.argv[index + 1] ?? '').trim();
  if (!value) throw new Error('RSCORE_APO_ARGUMENT_MISSING:' + name);
  return value;
};

const requiredArgument = (name: string): string => {
  const value = argument(name);
  if (!value) throw new Error('RSCORE_APO_ARGUMENT_MISSING:' + name);
  return value;
};

const parseWorkers = (): number[] => {
  const raw = argument('workers') ?? '1,2,4,8,16';
  const values = raw.split(',').map(value => Number(value.trim()));
  if (
    values.length === 0 || new Set(values).size !== values.length
    || values.some(value => !Number.isSafeInteger(value) || value < 1 || value > 256)
  ) throw new Error('RSCORE_APO_WORKERS_INVALID:' + raw);
  return values;
};

const exactUnsigned = (value: unknown, code: string): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  throw new Error(code + ':' + String(value));
};

const parseTranscript = (path: string): readonly TranscriptPair[] => {
  const bytes = readFileSync(path);
  if (!bytes.subarray(0, TRANSCRIPT_MAGIC.length).equals(TRANSCRIPT_MAGIC)) {
    throw new Error('RSCORE_APO_TRANSCRIPT_MAGIC');
  }
  const records: Array<Readonly<{ direction: number; frame: Buffer }>> = [];
  let offset = TRANSCRIPT_MAGIC.length;
  while (offset < bytes.length) {
    if (offset + 5 > bytes.length) throw new Error('RSCORE_APO_TRANSCRIPT_HEADER_TRUNCATED');
    const direction = bytes[offset];
    const length = bytes.readUInt32BE(offset + 1);
    offset += 5;
    if ((direction !== 0 && direction !== 1) || length < 1 || offset + length > bytes.length) {
      throw new Error('RSCORE_APO_TRANSCRIPT_RECORD_INVALID:' + String(direction) + ':' + length);
    }
    records.push({ direction, frame: Buffer.from(bytes.subarray(offset, offset + length)) });
    offset += length;
  }
  if (records.length === 0) throw new Error('RSCORE_APO_TRANSCRIPT_EMPTY');
  if (records.length % 2 !== 0) throw new Error('RSCORE_APO_TRANSCRIPT_ODD:' + records.length);
  const pairs: TranscriptPair[] = [];
  for (let index = 0; index < records.length; index += 2) {
    const request = records[index];
    const response = records[index + 1];
    if (request?.direction !== 0 || response?.direction !== 1) {
      throw new Error('RSCORE_APO_TRANSCRIPT_ORDER:' + index);
    }
    pairs.push({ request: request.frame, response: response.frame });
  }
  return pairs;
};

const parseEnvelope = (frame: Buffer): ParsedEnvelope => {
  if (frame[0] !== ABI_MAGIC) throw new Error('RSCORE_APO_ABI_MAGIC:' + String(frame[0]));
  const decoded = unpackWireValue(frame.subarray(1));
  if (!Array.isArray(decoded) || decoded.length !== 14) {
    throw new Error('RSCORE_APO_ENVELOPE_ARITY');
  }
  const fields = decoded as RscoreWireValue[];
  const opTag = exactUnsigned(fields[9], 'RSCORE_APO_OP_TAG');
  const messageKind = exactUnsigned(fields[10], 'RSCORE_APO_MESSAGE_KIND');
  const body = fields[13];
  if (!Array.isArray(body)) throw new Error('RSCORE_APO_BODY_INVALID:' + opTag);
  const result = body.length === 1 ? body[0] : body;
  if (messageKind === 2) throw new Error('RSCORE_APO_CAPTURED_ERROR:' + safeStringify(result));
  return { fields, opTag, result };
};

const bodyDigest = (fields: readonly RscoreWireValue[], bodyBytes: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bodyBytes.length);
  const runtimeId = fields[6];
  const fingerprint = fields[4];
  if (!(runtimeId instanceof Uint8Array) || !(fingerprint instanceof Uint8Array)) {
    throw new Error('RSCORE_APO_HELLO_BINDING_INVALID');
  }
  return createHash('sha256')
    .update(String(fields[0]))
    .update(fingerprint)
    .update(runtimeId)
    .update(Buffer.from([exactUnsigned(fields[9], 'RSCORE_APO_DIGEST_OP')]))
    .update(Buffer.from([exactUnsigned(fields[10], 'RSCORE_APO_DIGEST_KIND')]))
    .update(length)
    .update(bodyBytes)
    .digest();
};

const requestWithPayload = (
  parsed: ParsedEnvelope,
  payload: readonly RscoreWireValue[],
): Buffer => {
  const bodyBytes = packWireValue([[...payload]]);
  const head = [...parsed.fields.slice(0, 13)] as RscoreWireValue[];
  head[11] = bodyBytes.length;
  head[12] = bodyDigest(head, bodyBytes);
  return Buffer.concat([
    Buffer.from([ABI_MAGIC, 0x9e]),
    ...head.map(value => packWireValue(value)),
    bodyBytes,
  ]);
};

const helloWithWorkers = (frame: Buffer, workers: number): Buffer => {
  const parsed = parseEnvelope(frame);
  if (parsed.opTag !== HELLO_OP) throw new Error('RSCORE_APO_FIRST_OP:' + parsed.opTag);
  const body = parsed.fields[13];
  if (!Array.isArray(body) || body.length !== 1 || !Array.isArray(body[0]) || body[0].length !== 4) {
    throw new Error('RSCORE_APO_HELLO_BODY_INVALID');
  }
  const payload = [...body[0]] as RscoreWireValue[];
  if (exactUnsigned(payload[1], 'RSCORE_APO_HELLO_WORKERS') === workers) return frame;
  payload[1] = workers;
  return requestWithPayload(parsed, payload);
};

const entityRoundWithoutPostAccounts = (frame: Buffer): Buffer => {
  const parsed = parseEnvelope(frame);
  if (parsed.opTag !== ENTITY_ROUND_OP) return frame;
  const body = parsed.fields[13];
  if (!Array.isArray(body) || body.length !== 1 || !Array.isArray(body[0]) || body[0].length !== 7) {
    throw new Error('RSCORE_APO_ENTITY_ROUND_BODY_INVALID');
  }
  const payload = [...body[0]] as RscoreWireValue[];
  payload[5] = false;
  return requestWithPayload(parsed, payload);
};

class ChildFrameReader {
  #buffer = Buffer.alloc(0);
  readonly #iterator: AsyncIterator<Buffer>;

  constructor(stream: NodeJS.ReadableStream) {
    this.#iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async read(): Promise<Buffer> {
    while (this.#buffer.length < 4 || this.#buffer.length < this.#buffer.readUInt32BE(0) + 4) {
      const next = await this.#iterator.next();
      if (next.done) throw new Error('RSCORE_APO_CHILD_EOF');
      const chunk = Buffer.from(next.value);
      this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    }
    const length = this.#buffer.readUInt32BE(0);
    if (length < 1 || length > 1_000 * 1024 * 1024) {
      throw new Error('RSCORE_APO_CHILD_FRAME_LENGTH:' + length);
    }
    const frame = Buffer.from(this.#buffer.subarray(4, length + 4));
    this.#buffer = this.#buffer.subarray(length + 4);
    return frame;
  }
}

const writeFrame = async (stream: NodeJS.WritableStream, frame: Buffer): Promise<void> => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(frame.length);
  if (!stream.write(Buffer.concat([length, frame]))) await once(stream, 'drain');
};

const comparableRound = (round: RscoreEntityRound): RscoreEntityRound => ({
  ...round,
  inbound: { ...round.inbound, postAccounts: [] },
  outbound: { ...round.outbound, postAccounts: [] },
  engineMicros: 0,
});

const firstDifference = (left: unknown, right: unknown, path = '$'): string | null => {
  if (Object.is(left, right)) return null;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    const preview = (value: unknown): string => safeStringify(value).slice(0, 160);
    return `${path}:${preview(left)}!=${preview(right)}`;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return `${path}:container`;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
  for (const key of keys) {
    if (!(key in leftRecord) || !(key in rightRecord)) return `${path}.${key}:presence`;
    const difference = firstDifference(leftRecord[key], rightRecord[key], `${path}.${key}`);
    if (difference !== null) return difference;
  }
  return null;
};

const assertResponseEquivalent = (
  expectedFrame: Buffer,
  actualFrame: Buffer,
): RscoreEntityRound | null => {
  const expected = parseEnvelope(expectedFrame);
  const actual = parseEnvelope(actualFrame);
  if (actual.opTag !== expected.opTag) {
    throw new Error('RSCORE_APO_RESPONSE_OP:' + expected.opTag + ':' + actual.opTag);
  }
  if (actual.opTag === HELLO_OP) return null;
  if (actual.opTag !== ENTITY_ROUND_OP) {
    if (safeStringify(actual.result) !== safeStringify(expected.result)) {
      throw new Error('RSCORE_APO_RESPONSE_MISMATCH:op=' + actual.opTag);
    }
    return null;
  }
  const expectedRound = decodeEntityRound(expected.result);
  const actualRound = decodeEntityRound(actual.result);
  if (safeStringify(comparableRound(actualRound)) !== safeStringify(comparableRound(expectedRound))) {
    const changed = (['inbound', 'outbound', 'outputs', 'commitments', 'ownedSections'] as const)
      .filter(field => safeStringify(actualRound[field]) !== safeStringify(expectedRound[field]));
    throw new Error(
      'RSCORE_APO_ROUND_MISMATCH:fields=' + changed.join(',')
      + ':expected=' + expectedRound.outbound.accountsRoot
      + ':actual=' + actualRound.outbound.accountsRoot
      + ':first=' + firstDifference(comparableRound(expectedRound), comparableRound(actualRound)),
    );
  }
  return actualRound;
};

const runTranscript = async (
  binary: string,
  pairs: readonly TranscriptPair[],
  workers: number,
): Promise<ApoBenchRow> => {
  const child = spawn(binary, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, XLN_RSCORE_CARRY_ENVELOPE: '0' },
  });
  child.stderr.pipe(process.stderr);
  const reader = new ChildFrameReader(child.stdout);
  let inboundAccountInputs = 0;
  let outboundAccountInputs = 0;
  let accountTxs = 0;
  let engineMicros = 0;
  let boundaryMs = 0;
  let rounds = 0;
  let roots = { accountsRoot: '', paybookRoot: '', orderbookRoot: '' };
  for (const [index, pair] of pairs.entries()) {
    const captured = parseEnvelope(pair.request);
    const request = index === 0
      ? helloWithWorkers(pair.request, workers)
      : entityRoundWithoutPostAccounts(pair.request);
    const startedAt = captured.opTag === ENTITY_ROUND_OP ? performance.now() : 0;
    await writeFrame(child.stdin, request);
    const response = await reader.read();
    if (captured.opTag === ENTITY_ROUND_OP) boundaryMs += performance.now() - startedAt;
    const round = assertResponseEquivalent(pair.response, response);
    if (round === null) continue;
    rounds += 1;
    engineMicros += round.engineMicros;
    inboundAccountInputs += round.inbound.applied.length;
    outboundAccountInputs += round.outbound.proposals.filter(proposal =>
      proposal.frame !== null || proposal.bundledAck !== null).length;
    accountTxs += round.outbound.proposals.reduce(
      (total, proposal) => total + (proposal.frame?.accountTxs.length ?? 0),
      0,
    );
    roots = {
      accountsRoot: round.outbound.accountsRoot,
      paybookRoot: round.commitments.paybookRoot,
      orderbookRoot: round.commitments.orderbookRoot,
    };
  }
  child.stdin.end();
  const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error('RSCORE_APO_CHILD_EXIT:' + String(code) + ':' + String(signal));
  const engineMs = engineMicros / 1_000;
  if (rounds < 1 || engineMs <= 0 || boundaryMs <= 0 || Object.values(roots).some(value => !value)) {
    throw new Error('RSCORE_APO_RESULT_EMPTY');
  }
  return {
    workers,
    rounds,
    inboundAccountInputs,
    outboundAccountInputs,
    accountTxs,
    engineMs,
    boundaryMs,
    inboundPerEngineSecond: inboundAccountInputs * 1_000 / engineMs,
    outboundPerEngineSecond: outboundAccountInputs * 1_000 / engineMs,
    inboundPerBoundarySecond: inboundAccountInputs * 1_000 / boundaryMs,
    outboundPerBoundarySecond: outboundAccountInputs * 1_000 / boundaryMs,
    protocolRowsPerEngineSecond: (inboundAccountInputs + outboundAccountInputs) * 1_000 / engineMs,
    protocolRowsPerBoundarySecond: (inboundAccountInputs + outboundAccountInputs) * 1_000 / boundaryMs,
    ...roots,
  };
};

const captureTranscript = async (
  recording: string,
  transcript: string,
  binary: string,
  runtimeSeedFile: string | null,
  entitySignerLabel: string | null,
): Promise<void> => {
  const proxy = fileURLToPath(new URL('./rscore-transcript-proxy.ts', import.meta.url));
  accessSync(proxy, constants.X_OK);
  const captureDirectory = mkdtempSync(join(tmpdir(), 'xln-apo-capture-'));
  const output = join(captureDirectory, 'report.json');
  const sessionPrefix = 'session-';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XLN_RSCORE_AUTHORITY: '1',
    XLN_RSCORE_AUTHORITY_CUTOVER: '1',
    XLN_RSCORE_AUTHORITY_REPLAY: '1',
    XLN_RSCORE_AUTHORITY_IMPORT: '1',
    XLN_RSCORE_AUTHORITY_RECORD: '1',
    XLN_RSCORE_ENTITY_AUTHORITY: '1',
    XLN_RSCORE_CUTOVER_TRUST_ENGINE: '0',
    XLN_RSCORE_AUTHORITY_WORKERS: '1',
    XLN_RSCORE_BINARY: proxy,
    XLN_RSCORE_CAPTURE_TARGET: binary,
    // Replay may instantiate more than one Runtime candidate. Each Rust
    // process gets an isolated transcript; after parity succeeds we retain
    // only the resident A+P+O session containing EntityRound requests.
    XLN_RSCORE_CAPTURE_PATH: join(captureDirectory, sessionPrefix + '%PID%'),
  };
  const child = spawn(process.execPath, [
    'core/scripts/operations/hlt/replay/replay-hub-recording.ts',
    '--recording', recording,
    '--output', output,
    '--mode', 'max',
    '--require-rust-account-authority',
    ...(runtimeSeedFile ? ['--runtime-seed-file', runtimeSeedFile] : []),
    ...(entitySignerLabel ? ['--entity-signer-label', entitySignerLabel] : []),
  ], { cwd: process.cwd(), env, stdio: 'inherit' });
  const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error('RSCORE_APO_CAPTURE_EXIT:' + String(code) + ':' + String(signal));
  const report = safeParse(readFileSync(output, 'utf8')) as Record<string, unknown>;
  const trials = report['trials'];
  const trial = Array.isArray(trials) ? trials[0] as Record<string, unknown> | undefined : undefined;
  if (trial?.['equivalent'] !== true || trial['frameVerified'] !== true) {
    throw new Error('RSCORE_APO_CAPTURE_PARITY_UNVERIFIED');
  }
  const candidates = readdirSync(captureDirectory)
    .filter(name => name.startsWith(sessionPrefix))
    .map(name => join(captureDirectory, name))
    .map(path => ({
      path,
      rounds: parseTranscript(path)
        .filter(pair => parseEnvelope(pair.request).opTag === ENTITY_ROUND_OP).length,
    }))
    .filter(candidate => candidate.rounds > 0)
    .sort((left, right) => right.rounds - left.rounds || left.path.localeCompare(right.path));
  const selected = candidates[0];
  if (selected === undefined) throw new Error('RSCORE_APO_CAPTURE_ENTITY_SESSION_MISSING');
  copyFileSync(selected.path, transcript, constants.COPYFILE_EXCL);
};

const recording = resolve(requiredArgument('recording'));
const binary = resolve(argument('binary') ?? 'rscore/target/release/xlnrs');
const transcript = resolve(argument('transcript') ?? recording + '.apo-transcript-v1');
const runtimeSeedFileArgument = argument('runtime-seed-file');
const runtimeSeedFile = runtimeSeedFileArgument ? resolve(runtimeSeedFileArgument) : null;
const entitySignerLabel = argument('entity-signer-label');
accessSync(recording, constants.R_OK);
accessSync(binary, constants.X_OK);
if (!existsSync(transcript)) {
  await captureTranscript(recording, transcript, binary, runtimeSeedFile, entitySignerLabel);
}
const pairs = parseTranscript(transcript);
const rows: ApoBenchRow[] = [];
for (const workers of parseWorkers()) rows.push(await runTranscript(binary, pairs, workers));
console.table(rows.map(row => ({
  workers: row.workers,
  rounds: row.rounds,
  inboundAccountInputs: row.inboundAccountInputs,
  outboundAccountInputs: row.outboundAccountInputs,
  inboundPerEngineSecond: row.inboundPerEngineSecond.toFixed(0),
  outboundPerEngineSecond: row.outboundPerEngineSecond.toFixed(0),
  inboundPerBoundarySecond: row.inboundPerBoundarySecond.toFixed(0),
  outboundPerBoundarySecond: row.outboundPerBoundarySecond.toFixed(0),
  protocolRowsPerEngineSecond: row.protocolRowsPerEngineSecond.toFixed(0),
  protocolRowsPerBoundarySecond: row.protocolRowsPerBoundarySecond.toFixed(0),
  engineMs: row.engineMs.toFixed(2),
  boundaryMs: row.boundaryMs.toFixed(2),
})));
console.log('RSCORE_APO_BENCH ' + safeStringify({ recording, transcript, rows }));
