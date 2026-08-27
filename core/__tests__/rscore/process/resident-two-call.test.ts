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
import {
  accountConsensusWire,
  accountEnvelopeWire,
  accountSeedWire,
  hexToWireBytes,
  swapMarketPolicyWire,
} from '../../../rscore/shadow-wire';
import { decodeWave } from '../../../rscore/wave-decode';
import { addr, makeAccount } from '../../helpers/cross-j';
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

describe.skipIf(!existsSync(BINARY))('rscore resident two-call process', () => {
  test('Hello rejects the stale process ABI and protocol fingerprint', async () => {
    expect(RSCORE_PROCESS_ABI_VERSION).toBe(37);
    expect(RSCORE_PROTOCOL_FINGERPRINT.toString('hex'))
      .toBe('0d0e71b61e8319a6a3514059b0167b56f0b03a22422937731184b4b3a9cfaceb');
    const staleAbi = new RawProcessSession(identity());
    try {
      expect(rawErrorCode(await staleAbi.request(RSCORE_OP.hello, [
        22,
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

  test('Account inbound reconciles from the parent forest root without a commit command', async () => {
    const raw = new RawProcessSession(identity());
    try {
      const seed = `0x${'6b'.repeat(32)}`;
      const owner = generateLazyEntityId([deriveSignerAddressSync(seed, '1')], 1n);
      rawOk(await raw.request(RSCORE_OP.hello, [
        RSCORE_PROCESS_ABI_VERSION,
        2,
        swapMarketPolicyWire(),
        [deriveSignerKeySync(seed, '1'), '1'],
      ]));
      const counterparty = `0x${'cd'.repeat(32)}`;
      const account = makeAccount(owner, counterparty);
      const loaded = exactTuple(rawOk(await raw.request(
        RSCORE_OP.bootstrapAccounts,
        [RSCORE_PROCESS_PROFILE, 0, [accountSeedWire(
          owner,
          counterparty,
          account.state,
          accountEnvelopeWire(account),
          accountConsensusWire(account),
          addr('77'),
        )], true],
      )), 2, 'root bootstrap');
      const expectedRoot = exactBytes(loaded[1], 32, 'root bootstrap root');
      const ownerBytes = hexToWireBytes(owner, 32, 'TEST_ROOT_OWNER');
      expect(rawErrorCode(await raw.request(RSCORE_OP.accountInbound, [
        ownerBytes,
        Buffer.alloc(32, 0x7a),
        [1_700_000_000_000, 100],
        [],
        false,
      ]))).toBe('RSCORE_BATCH_ENTITY_HEAD_ROOT');
      const inbound = decodeWave(rawOk(await raw.request(RSCORE_OP.accountInbound, [
        ownerBytes,
        expectedRoot,
        [1_700_000_000_000, 100],
        [],
        false,
      ])));
      expect(inbound.accountsRoot).toBe(`0x${expectedRoot.toString('hex')}`);
      const outbound = decodeWave(rawOk(await raw.request(RSCORE_OP.accountOutbound, [
        ownerBytes,
        1_700_000_000_000,
        100,
        [],
        [],
        [],
        [],
        [],
        false,
        false,
      ])));
      expect(outbound.accountsRoot).toBe(inbound.accountsRoot);
      expect(outbound.checkpoint).toBeNull();
      const due = decodeWave(rawOk(await raw.request(RSCORE_OP.accountOutbound, [
        ownerBytes,
        1_700_000_000_000,
        100,
        [],
        [],
        [],
        [],
        [],
        false,
        true,
      ])));
      expect(due.checkpoint).not.toBeNull();
      // Offline import is dirty against the empty Rust durability baseline.
      // The first due Runtime checkpoint must persist the imported Account;
      // otherwise a crash before the first mutation loses authority state.
      expect(due.checkpoint?.accounts).toHaveLength(1);
      expect(due.checkpoint?.removed).toEqual([]);
      const reconciled = decodeWave(rawOk(await raw.request(RSCORE_OP.accountInbound, [
        ownerBytes,
        expectedRoot,
        [1_700_000_000_001, 101],
        [],
        false,
      ])));
      expect(reconciled.accountsRoot).toBe(inbound.accountsRoot);
      rawOk(await raw.request(RSCORE_OP.shutdown, []));
    } finally {
      raw.kill();
    }
  });
});
