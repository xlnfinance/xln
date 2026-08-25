import { describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { deriveSignerAddressSync, deriveSignerKeySync } from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import {
  RSCORE_OP,
  RSCORE_PROCESS_ABI_VERSION,
  RSCORE_PROCESS_PROFILE,
  RSCORE_PROTOCOL_FINGERPRINT,
  packWireValue,
  unpackWireValue,
  type RscoreWireValue,
} from '../../../rscore/client';
import { hexToWireBytes, swapMarketPolicyWire, waveInputOp } from '../../../rscore/shadow-wire';
import { decodeWave } from '../../../rscore/wave-decode';
const BINARY = join(import.meta.dir, '../../../../rscore/target/release/xln-rscore');

if (!existsSync(BINARY) && process.env['XLN_RSCORE_REQUIRE_BINARY'] === '1') {
  throw new Error(`RSCORE_BINARY_MISSING:${BINARY}`);
}
const identity = () => ({
  engineGeneration: Buffer.alloc(8, 0xa0),
  runtimeId: Buffer.alloc(20, 0x10),
  sessionId: Buffer.alloc(16, 0x20),
});

const exactTuple = (value: unknown, arity: number, field: string): unknown[] => {
  if (!Array.isArray(value) || value.length !== arity) {
    throw new Error(`RSCORE_TEST_${field.toUpperCase().replaceAll(' ', '_')}_ARITY`);
  }
  return value;
};

const exactBytes = (value: unknown, size: number, field: string): Buffer => {
  if (!(value instanceof Uint8Array) || value.length !== size) {
    throw new Error(`RSCORE_TEST_${field.toUpperCase().replaceAll(' ', '_')}_BYTES`);
  }
  return Buffer.from(value);
};

const rawRequestFrame = (
  requestIdentity: ReturnType<typeof identity>,
  requestIdValue: bigint,
  opTag: number,
  payload: RscoreWireValue[],
  fingerprint: Buffer,
): Buffer => {
  const requestId = Buffer.alloc(8);
  requestId.writeBigUInt64BE(requestIdValue);
  const body: RscoreWireValue = [payload];
  const bodyBytes = packWireValue(body);
  const bodyLength = Buffer.alloc(4);
  bodyLength.writeUInt32BE(bodyBytes.length);
  const digest = createHash('sha256')
    .update('xln.rscore.account')
    .update(fingerprint)
    .update(requestIdentity.runtimeId)
    .update(Buffer.from([opTag, 0]))
    .update(bodyLength)
    .update(bodyBytes)
    .digest();
  const envelope = Buffer.concat([
    Buffer.from([0x03]),
    packWireValue([
      'xln.rscore.account',
      1,
      1,
      1,
      fingerprint,
      requestIdentity.engineGeneration,
      requestIdentity.runtimeId,
      requestIdentity.sessionId,
      requestId,
      opTag,
      0,
      bodyBytes.length,
      digest,
      body,
    ]),
  ]);
  const frameLength = Buffer.alloc(4);
  frameLength.writeUInt32BE(envelope.length);
  return Buffer.concat([frameLength, envelope]);
};

type RawProcessReply = Readonly<{
  messageKind: number;
  result: unknown;
}>;

class RawProcessSession {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #identity: ReturnType<typeof identity>;
  #requestId = 0n;
  #stderrTail = '';

  constructor(requestIdentity: ReturnType<typeof identity>) {
    this.#identity = requestIdentity;
    this.#child = spawn(BINARY, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child.stderr.on('data', (chunk: Buffer) => {
      this.#stderrTail = `${this.#stderrTail}${String(chunk)}`.slice(-4096);
    });
  }

  async request(
    opTag: number,
    payload: RscoreWireValue[],
    fingerprint: Buffer = RSCORE_PROTOCOL_FINGERPRINT,
  ): Promise<RawProcessReply> {
    const requestId = this.#requestId;
    const reply = this.#readReply();
    const frame = rawRequestFrame(this.#identity, requestId, opTag, payload, fingerprint);
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(frame, error => {
        if (error) reject(error);
        else resolve();
      });
    });
    const decoded = await reply;
    this.#requestId += 1n;
    return decoded;
  }

  kill(): void {
    if (this.#child.exitCode === null && !this.#child.killed) {
      this.#child.kill('SIGKILL');
    }
  }

  async #readReply(): Promise<RawProcessReply> {
    return new Promise((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      const cleanup = (): void => {
        this.#child.stdout.off('data', onData);
        this.#child.off('error', onError);
        this.#child.off('exit', onExit);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(new Error(
          `RSCORE_TEST_RAW_EXIT:${String(code)}:${String(signal)}:${this.#stderrTail}`,
        ));
      };
      const onData = (chunk: Buffer): void => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length < 4) return;
        const frameLength = bytes.readUInt32BE(0);
        if (bytes.length < frameLength + 4) return;
        cleanup();
        if (bytes.length !== frameLength + 4) {
          reject(new Error(`RSCORE_TEST_RAW_TRAILING_REPLY:${bytes.length}:${frameLength}`));
          return;
        }
        try {
          const frame = bytes.subarray(4);
          if (frame[0] !== 0x03) {
            throw new Error(`RSCORE_TEST_RAW_REPLY_MAGIC:${String(frame[0])}`);
          }
          const envelope = exactTuple(unpackWireValue(frame.subarray(1)), 14, 'raw reply');
          const messageKind = envelope[10];
          if (typeof messageKind !== 'number') {
            throw new Error('RSCORE_TEST_RAW_REPLY_KIND');
          }
          const body = exactTuple(envelope[13], 1, 'raw reply body');
          resolve({ messageKind, result: body[0] });
        } catch (cause) {
          reject(cause);
        }
      };
      this.#child.stdout.on('data', onData);
      this.#child.once('error', onError);
      this.#child.once('exit', onExit);
    });
  }
}

const rawErrorCode = (reply: RawProcessReply): string => {
  expect(reply.messageKind).toBe(2);
  const error = exactTuple(reply.result, 2, 'raw reply error');
  if (typeof error[0] !== 'string') throw new Error('RSCORE_TEST_RAW_ERROR_CODE');
  return error[0];
};

const rawOk = (reply: RawProcessReply): unknown => {
  expect(reply.messageKind).toBe(1);
  return reply.result;
};

describe.skipIf(!existsSync(BINARY))('rscore ABI15 process binding', () => {
  test('Hello rejects the stale process ABI and protocol fingerprint', async () => {
    expect(RSCORE_PROCESS_ABI_VERSION).toBe(15);
    expect(RSCORE_PROTOCOL_FINGERPRINT.toString('hex'))
      .toBe('0720c839d3874f4a70e358f5f7e2b7f78cf2a3cb2132906ae05cdd7365f8b3a7');
    const staleAbi = new RawProcessSession(identity());
    try {
      expect(rawErrorCode(await staleAbi.request(RSCORE_OP.hello, [
        14,
        2,
        swapMarketPolicyWire(),
        null,
      ]))).toBe('RSCORE_PROCESS_VERSION');
    } finally {
      staleAbi.kill();
    }

    const staleFingerprint = new RawProcessSession(identity());
    try {
      expect(rawErrorCode(await staleFingerprint.request(
        RSCORE_OP.hello,
        [RSCORE_PROCESS_ABI_VERSION, 2, swapMarketPolicyWire(), null],
        Buffer.from('5242319aca7ef76d390807b9d35c36a51d2489c5a1e0dfa9ffd7683b3b3ac93e', 'hex'),
      ))).toBe('RSCORE_PROCESS_PROTOCOL_FINGERPRINT');
    } finally {
      staleFingerprint.kill();
    }
  });

  test('a trailing peer row fails before candidate root or revision mutation', async () => {
    const raw = new RawProcessSession(identity());
    try {
      const seed = `0x${'7a'.repeat(32)}`;
      const owner = generateLazyEntityId([deriveSignerAddressSync(seed, '1')], 1n);
      rawOk(await raw.request(RSCORE_OP.hello, [
        RSCORE_PROCESS_ABI_VERSION,
        2,
        swapMarketPolicyWire(),
        [deriveSignerKeySync(seed, '1'), '1'],
      ]));
      const loaded = exactTuple(rawOk(await raw.request(
        RSCORE_OP.bootstrapAccounts,
        [RSCORE_PROCESS_PROFILE, 0, [], false],
      )), 2, 'raw bootstrap');
      const prepared = exactTuple(rawOk(await raw.request(
        RSCORE_OP.prepareAccountWave,
        [[]],
      )), 10, 'raw prepared');
      const baseline = decodeWave(prepared.slice(0, 9));
      expect(baseline.revision).toBe(loaded[0]);
      expect(baseline.accountsRoot)
        .toBe(`0x${exactBytes(loaded[1], 32, 'raw loaded root').toString('hex')}`);
      const token = exactBytes(prepared[9], 32, 'raw candidate token');
      const stageKey = Buffer.alloc(32, 0x93);
      const ownerBytes = hexToWireBytes(owner, 32, 'TEST_RAW_OWNER');
      rawOk(await raw.request(RSCORE_OP.beginEntity, [
        token,
        stageKey,
        0,
        [ownerBytes, 1_700_000_000_000, 100, 1_700_000_000_000, 100, false],
      ]));

      const trailingPeerRow: RscoreWireValue = waveInputOp([
        0,
        Buffer.alloc(32, 0x44),
        null,
        null,
      ]);
      expect(rawErrorCode(await raw.request(RSCORE_OP.applyAccountWave, [
        token,
        stageKey,
        [[ownerBytes, [trailingPeerRow]]],
      ]))).toBe('RSCORE_PROCESS_ARITY');

      const afterFailure = decodeWave(rawOk(await raw.request(
        RSCORE_OP.applyAccountWave,
        [token, stageKey, []],
      )));
      expect(afterFailure.revision).toBe(baseline.revision);
      expect(afterFailure.accountsRoot).toBe(baseline.accountsRoot);
      expect(afterFailure.applied).toEqual([]);
      expect(afterFailure.admissions).toEqual([]);
      const discarded = exactTuple(
        rawOk(await raw.request(RSCORE_OP.discardEntity, [token, stageKey, 0])),
        5,
        'raw discard',
      );
      expect(discarded[3]).toBe(baseline.revision);
      expect(`0x${exactBytes(discarded[4], 32, 'raw discarded root').toString('hex')}`)
        .toBe(baseline.accountsRoot);
      const aborted = exactTuple(
        rawOk(await raw.request(RSCORE_OP.abortRuntime, [token])),
        2,
        'raw abort',
      );
      expect(aborted[0]).toBe(baseline.revision);
      expect(`0x${exactBytes(aborted[1], 32, 'raw aborted root').toString('hex')}`)
        .toBe(baseline.accountsRoot);
      rawOk(await raw.request(RSCORE_OP.shutdown, []));
    } finally {
      raw.kill();
    }
  });
});
