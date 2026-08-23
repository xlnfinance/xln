import { describe, expect, test } from 'bun:test';
import { sha256 } from '@noble/hashes/sha2.js';

import { encodeAccountStateValue } from '../../core/account/commitment/account-state-value';
import { applyAccountTxToMutableReplica } from '../../core/account/tx/apply';
import { createDefaultDelta } from '../../core/account/state/delta';
import { PersistentAccountStateMap } from '../../core/account/state/persistent-state-map';
import { packTransportValue } from '../../core/protocol/serialization/binary-codec';
import type { AccountOutput, AccountReplica, AccountTx, Delta } from '../../core/types/account';
import { addr, entity, makeAccount } from '../../core/__tests__/helpers/cross-j';
import fixture from './account-balance-direct.fixture.json';

type WireValue = null | boolean | number | string | Uint8Array | WireValue[];
type Case = Readonly<{ id: string; byLeft: boolean; tx: AccountTx; wire: WireValue[] }>;

const SCHEMA = 'balance-direct-v1';
const TYPESCRIPT_AUTHORITY = '1001909ab2f927d60b889a02cbd7113ddc09e79d';
const ROOT_FIELDS = ['modeledDeltaStateRoot', 'deltasRadixRoot'] as const;
const LEFT = entity('aa');
const RIGHT = entity('bb');
const TARGET = entity('cc');
const WATCH_SEED = entity('99');
const DEPOSITORY = addr('88');
const PROTOCOL_FINGERPRINT = Buffer.from(
  sha256(new TextEncoder().encode('xln.rscore.account:v1:protocol=5:storage=10:hanko:balance-direct-v1')),
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

const requestBody = (): WireValue[] => {
  const delta = initialDelta();
  return [
    SCHEMA,
    [LEFT, LEFT, RIGHT, 31_337, DEPOSITORY, WATCH_SEED, [deltaWire(delta)]],
    CASES.map(({ id, byLeft, wire }) => [id, byLeft ? 0 : 1, wire]),
  ];
};

const accountFixture = (): AccountReplica => {
  const account = makeAccount(LEFT, RIGHT, { chainId: 31_337, depositoryAddress: DEPOSITORY });
  account.state.watchSeed = WATCH_SEED;
  account.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [[1, initialDelta()]]);
  return account;
};

const stateEvidence = (account: AccountReplica): [WireValue[], Uint8Array, Uint8Array] => {
  const deltas = [...account.state.deltas.values()].sort((left, right) => left.tokenId - right.tokenId);
  const rows = deltas.map(deltaWire);
  const committed = deltas.map(delta => ({
    tokenId: delta.tokenId,
    collateral: delta.collateral,
    ondelta: delta.ondelta,
    offdelta: delta.offdelta,
    leftCreditLimit: delta.leftCreditLimit,
    rightCreditLimit: delta.rightCreditLimit,
    leftAllowance: delta.leftAllowance,
    rightAllowance: delta.rightAllowance,
    leftHold: delta.leftHold,
    rightHold: delta.rightHold,
  }));
  return [rows, Buffer.from(sha256(encodeAccountStateValue(committed))), hexBytes(account.state.deltas.rootHash())];
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

const executeTypescript = async (): Promise<WireValue[]> => {
  const account = accountFixture();
  const steps: WireValue[] = [];
  for (const entry of CASES) {
    const result = await applyAccountTxToMutableReplica(account, entry.tx, entry.byLeft);
    const verdict: WireValue[] = result.ok
      ? ['applied']
      : ['rejected', result.rejection.kind, result.rejection.code, result.rejection.message];
    const [rows, modeledDeltaStateRoot, deltasRadixRoot] = stateEvidence(account);
    steps.push([
      entry.id,
      verdict,
      [...result.events],
      (result.candidateEffects ?? []).map(outputWire),
      rows,
      [modeledDeltaStateRoot, deltasRadixRoot],
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

describe('rscore exact-byte balance/direct differential', () => {
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
