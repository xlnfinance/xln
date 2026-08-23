import { describe, expect, test } from 'bun:test';
import { sha256 } from '@noble/hashes/sha2.js';

import { applyAccountTxToMutableReplica } from '../../core/account/tx/apply';
import { computeAccountStateRoot } from '../../core/account/commitment/state-root';
import { createDefaultDelta } from '../../core/account/state/delta';
import { PersistentAccountStateMap } from '../../core/account/state/persistent-state-map';
import { packTransportValue } from '../../core/protocol/serialization/binary-codec';
import { hashHtlcSecret } from '../../core/protocol/htlc/utils';
import type { AccountOutput, AccountReplica, AccountTx, Delta, HtlcLock } from '../../core/types/account';
import { addr, entity, makeAccount } from '../../core/__tests__/helpers/cross-j';
import fixture from './account-balance-direct.fixture.json';

type WireValue = null | boolean | number | string | Uint8Array | WireValue[];
type ExecutionContext = Readonly<{
  committedTimestamp: number;
  enforcementTimestamp: number;
  enforcementJHeight: number;
  currentAccountHeight: number;
}>;
type Case = Readonly<{
  id: string;
  byLeft: boolean;
  tx: AccountTx;
  wire: WireValue[];
  context?: ExecutionContext;
}>;
type HtlcOutcome = Readonly<{ outcome: 'secret'; secret: string }> | Readonly<{ outcome: 'error'; reason?: string }>;

const SCHEMA = 'payment-v1';
const TYPESCRIPT_AUTHORITY = '1001909ab2f927d60b889a02cbd7113ddc09e79d';
const ROOT_FIELDS = ['deltasRadixRoot', 'locksRadixRoot', 'paymentProfileAccountStateRoot'] as const;
const LEFT = entity('aa');
const RIGHT = entity('bb');
const TARGET = entity('cc');
const WATCH_SEED = entity('99');
const DEPOSITORY = addr('88');
const PROTOCOL_FINGERPRINT = Buffer.from(
  sha256(new TextEncoder().encode('xln.rscore.account:v1:protocol=5:storage=10:hanko:payment-v1')),
);
const ENGINE_GENERATION = Buffer.from({ length: 8 }, (_, index) => 0xa0 + index);
const RUNTIME_ID = Buffer.from({ length: 20 }, (_, index) => 0x10 + index);
const SESSION_ID = Buffer.from({ length: 16 }, (_, index) => 0x20 + index);
const REQUEST_ID = Buffer.from({ length: 8 }, (_, index) => 0x30 + index);

const initialDelta = (): Delta => ({
  ...createDefaultDelta(1),
  collateral: 100_000n,
});

const payment = (
  id: string,
  amount: bigint,
  deliveryMode: 'direct' | 'trusted',
  route: string[],
  fromEntityId = RIGHT,
  toEntityId = LEFT,
): Case => {
  const description = `${id}-note`;
  const trustedGatewayEntityId = deliveryMode === 'trusted' ? LEFT : undefined;
  return {
    id,
    byLeft: false,
    tx: {
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount,
        route,
        description,
        fromEntityId,
        toEntityId,
        deliveryMode,
        ...(trustedGatewayEntityId ? { trustedGatewayEntityId } : {}),
      },
    },
    wire: [
      2,
      1,
      amount.toString(),
      route,
      description,
      fromEntityId,
      toEntityId,
      deliveryMode === 'direct' ? 0 : 1,
      trustedGatewayEntityId ?? null,
    ],
  };
};

const htlcContext = (timestamp: number, jHeight: number): ExecutionContext => ({
  committedTimestamp: timestamp,
  enforcementTimestamp: timestamp,
  enforcementJHeight: jHeight,
  currentAccountHeight: 0,
});

const htlcLock = (
  id: string,
  lockId: string,
  secret: string,
  timelock: bigint,
  revealBeforeHeight: number,
  context: ExecutionContext,
): Case => {
  const hashlock = hashHtlcSecret(secret);
  return {
    id,
    byLeft: true,
    context,
    tx: {
      type: 'htlc_lock',
      data: { lockId, hashlock, timelock, revealBeforeHeight, amount: 7n, tokenId: 1 },
    },
    wire: [3, lockId, hashlock, timelock.toString(), revealBeforeHeight, '7', 1],
  };
};

const htlcResolve = (
  id: string,
  lockId: string,
  byLeft: boolean,
  outcome: HtlcOutcome,
  context: ExecutionContext,
): Case => ({
  id,
  byLeft,
  context,
  tx: { type: 'htlc_resolve', data: { lockId, ...outcome } },
  wire: outcome.outcome === 'secret' ? [4, lockId, 0, outcome.secret] : [4, lockId, 1, outcome.reason ?? null],
});

const SECRET_OK = `0x${'44'.repeat(32)}`;
const SECRET_TIMEOUT = `0x${'55'.repeat(32)}`;
const LOCK_SECRET = `0x${'66'.repeat(32)}`;
const LOCK_TIMEOUT = `0x${'77'.repeat(32)}`;

const CASES: readonly Case[] = [
  { id: 'add-delta', byLeft: true, tx: { type: 'add_delta', data: { tokenId: 2 } }, wire: [0, 2] },
  {
    id: 'left-credit',
    byLeft: true,
    tx: { type: 'set_credit_limit', data: { tokenId: 2, amount: 70n } },
    wire: [1, 2, '70'],
  },
  {
    id: 'right-credit',
    byLeft: false,
    tx: { type: 'set_credit_limit', data: { tokenId: 2, amount: 80n } },
    wire: [1, 2, '80'],
  },
  payment('direct', 100n, 'direct', [LEFT]),
  payment('trusted', 7n, 'trusted', [LEFT, TARGET]),
  payment('forged-direction', 1n, 'direct', [RIGHT], LEFT, RIGHT),
  htlcLock('htlc-secret-lock', LOCK_SECRET, SECRET_OK, 60_000n, 10, htlcContext(1_000, 0)),
  htlcResolve(
    'htlc-secret-resolve',
    LOCK_SECRET,
    false,
    { outcome: 'secret', secret: SECRET_OK },
    htlcContext(1_000, 1),
  ),
  htlcLock('htlc-timeout-lock', LOCK_TIMEOUT, SECRET_TIMEOUT, 2_000n, 20, htlcContext(1_000, 1)),
  htlcResolve(
    'htlc-timeout-resolve',
    LOCK_TIMEOUT,
    true,
    { outcome: 'error', reason: 'timeout' },
    htlcContext(2_000, 1),
  ),
];

const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

const u32be = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
};

const bodyDigest = (body: Uint8Array, kind: number): Uint8Array =>
  Buffer.from(
    sha256(
      concatBytes(
        new TextEncoder().encode('xln.rscore.account'),
        PROTOCOL_FINGERPRINT,
        RUNTIME_ID,
        Uint8Array.of(5, kind),
        u32be(body.byteLength),
        body,
      ),
    ),
  );

const encodeEnvelope = (body: WireValue[], kind: 0 | 1): Uint8Array => {
  const bodyBytes = packTransportValue(body);
  const outer: WireValue[] = [
    'xln.rscore.account',
    1,
    5,
    10,
    PROTOCOL_FINGERPRINT,
    ENGINE_GENERATION,
    RUNTIME_ID,
    SESSION_ID,
    REQUEST_ID,
    5,
    kind,
    bodyBytes.byteLength,
    bodyDigest(bodyBytes, kind),
    body,
  ];
  return concatBytes(Uint8Array.of(3), packTransportValue(outer));
};

const deltaWire = (delta: Delta): WireValue[] => [
  delta.tokenId,
  delta.collateral.toString(),
  delta.ondelta.toString(),
  delta.offdelta.toString(),
  delta.leftCreditLimit.toString(),
  delta.rightCreditLimit.toString(),
  delta.leftAllowance.toString(),
  delta.rightAllowance.toString(),
  delta.leftHold.toString(),
  delta.rightHold.toString(),
];

const hexBytes = (hex: string): Uint8Array => {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(body)) throw new Error(`DIFFERENTIAL_HEX_INVALID:${hex}`);
  return Buffer.from(body, 'hex');
};

const contextWire = (context: ExecutionContext | undefined): WireValue =>
  context
    ? [
        context.committedTimestamp,
        context.enforcementTimestamp,
        context.enforcementJHeight,
        context.currentAccountHeight,
      ]
    : null;

const requestBody = (): WireValue[] => {
  const delta = initialDelta();
  return [
    SCHEMA,
    [LEFT, LEFT, RIGHT, 31_337, DEPOSITORY, WATCH_SEED, [10, 10], [deltaWire(delta)]],
    CASES.map(({ id, byLeft, wire, context }) => [id, byLeft ? 0 : 1, contextWire(context), wire]),
  ];
};

const accountFixture = (): AccountReplica => {
  const account = makeAccount(LEFT, RIGHT, { chainId: 31_337, depositoryAddress: DEPOSITORY });
  account.state.watchSeed = WATCH_SEED;
  account.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [[1, initialDelta()]]);
  return account;
};

const lockWire = (lock: HtlcLock): WireValue[] => [
  lock.lockId,
  lock.hashlock,
  lock.timelock.toString(),
  lock.revealBeforeHeight,
  lock.amount.toString(),
  lock.tokenId,
  lock.senderIsLeft,
  lock.createdHeight,
  lock.createdTimestamp,
  lock.envelopeHash ?? null,
];

const stateEvidence = (
  account: AccountReplica,
): [WireValue[], WireValue[], Uint8Array, Uint8Array, Uint8Array] => {
  const deltas = [...account.state.deltas.values()].sort((left, right) => left.tokenId - right.tokenId);
  const locks = [...account.state.locks.values()].sort((left, right) =>
    left.lockId < right.lockId ? -1 : left.lockId > right.lockId ? 1 : 0,
  );
  return [
    deltas.map(deltaWire),
    locks.map(lockWire),
    hexBytes(account.state.deltas.rootHash()),
    hexBytes(account.state.locks.rootHash()),
    hexBytes(computeAccountStateRoot(account.state)),
  ];
};

const outputWire = (output: AccountOutput): WireValue[] => {
  if (output.kind !== 'directPaymentForward') {
    throw new Error(`DIFFERENTIAL_OUTPUT_UNSUPPORTED:${output.kind}`);
  }
  return [
    output.kind,
    output.tokenId,
    output.amount.toString(),
    [...output.route],
    output.description ?? null,
    output.deliveryMode,
    output.trustedGatewayEntityId,
  ];
};

type ApplyResult = Awaited<ReturnType<typeof applyAccountTxToMutableReplica>>;

// TypeScript returns HTLC completion through ApplyResult, while Rust returns a
// typed AccountOutput. Normalize that outcome into one shared wire tuple; it
// is intentionally not presented as a native TypeScript AccountOutput.
const resultOutputs = (entry: Case, result: ApplyResult, priorLock: HtlcLock | undefined): WireValue[] => {
  const outputs = (result.candidateEffects ?? []).map(outputWire);
  if (!result.ok || result.outcome === 'applied') return outputs;
  if (result.outcome === 'htlc_secret' && entry.tx.type === 'htlc_resolve') {
    outputs.push([
      'htlcSecret',
      entry.tx.data.lockId,
      result.hashlock,
      result.secret,
      result.tokenId,
      result.amount.toString(),
    ]);
    return outputs;
  }
  if (result.outcome === 'htlc_error' && entry.tx.type === 'htlc_resolve' && priorLock) {
    const reason = entry.tx.data.outcome === 'error' ? (entry.tx.data.reason ?? null) : null;
    outputs.push([
      'htlcError',
      entry.tx.data.lockId,
      result.hashlock,
      priorLock.tokenId,
      priorLock.amount.toString(),
      reason,
    ]);
    return outputs;
  }
  throw new Error(`DIFFERENTIAL_RESULT_UNSUPPORTED:${result.outcome}:${entry.tx.type}`);
};

const executeTypescript = async (): Promise<WireValue[]> => {
  const account = accountFixture();
  const steps: WireValue[] = [];
  for (const entry of CASES) {
    const priorLock = entry.tx.type === 'htlc_resolve' ? account.state.locks.get(entry.tx.data.lockId) : undefined;
    if (entry.context && entry.context.currentAccountHeight !== account.currentHeight) {
      throw new Error('DIFFERENTIAL_ACCOUNT_HEIGHT_MISMATCH');
    }
    const result = await applyAccountTxToMutableReplica(
      account,
      entry.tx,
      entry.byLeft,
      entry.context?.committedTimestamp ?? 0,
      entry.context?.enforcementJHeight ?? 0,
      false,
      undefined,
      undefined,
      undefined,
      entry.context
        ? {
            timestamp: entry.context.enforcementTimestamp,
            jHeight: entry.context.enforcementJHeight,
          }
        : undefined,
    );
    const verdict: WireValue[] = result.ok
      ? ['applied']
      : ['rejected', result.rejection.kind, result.rejection.code, result.rejection.message];
    const [deltaRows, lockRows, deltasRadixRoot, locksRadixRoot, paymentProfileAccountStateRoot] = stateEvidence(account);
    steps.push([
      entry.id,
      verdict,
      [...result.events],
      resultOutputs(entry, result, priorLock),
      deltaRows,
      lockRows,
      [deltasRadixRoot, locksRadixRoot, paymentProfileAccountStateRoot],
    ]);
  }
  return [SCHEMA, steps];
};

const runRust = async (request: Uint8Array): Promise<Uint8Array> => {
  const repository = `${import.meta.dir}/../..`;
  const child = Bun.spawn({
    cmd: ['cargo', 'run', '--quiet', '--manifest-path', 'tools/rscore-differential/Cargo.toml'],
    cwd: repository,
    env: { ...Bun.env, CARGO_TARGET_DIR: `${repository}/rscore/target` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(request);
  child.stdin.end();
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`DIFFERENTIAL_RUST_FAILED:${status}:${stderr}`);
  if (stderr.trim() !== '') throw new Error(`DIFFERENTIAL_RUST_STDERR:${stderr}`);
  return new Uint8Array(stdout);
};

const digestHex = (bytes: Uint8Array): string => Buffer.from(sha256(bytes)).toString('hex');

describe('rscore exact-byte payment differential', () => {
  test('TypeScript and Rust consume one ABI corpus and emit identical evidence', async () => {
    const request = encodeEnvelope(requestBody(), 0);
    const expected = encodeEnvelope(await executeTypescript(), 1);
    const observed = {
      schema: SCHEMA,
      typescriptAuthority: TYPESCRIPT_AUTHORITY,
      cases: CASES.map(({ id }) => id),
      rootFields: ROOT_FIELDS,
      request: { bytes: request.byteLength, sha256: digestHex(request) },
      response: { bytes: expected.byteLength, sha256: digestHex(expected) },
    };
    if (fixture.request.sha256 === 'pending') console.error(JSON.stringify(observed));
    expect(observed).toEqual(fixture);
    const actual = await runRust(request);
    expect(actual).toEqual(expected);
  }, 30_000);
});
