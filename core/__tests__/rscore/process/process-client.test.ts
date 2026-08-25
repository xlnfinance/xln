import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  accountEnvelopeWire,
  accountPeerFrameWire,
  accountConsensusWire,
  accountSeedWire,
  accountTxWire,
  hexToWireBytes,
  swapMarketPolicyDigest,
  swapMarketPolicyWire,
  waveAdmitOp,
  waveCreateOp,
  waveInputOp,
} from '../../../rscore/shadow-wire';
import { waveParityDigest } from '../../../rscore/wave-decode';
import { deriveSignerAddressSync, deriveSignerKeySync } from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import { verifyHankoForHash } from '../../../hanko/signing';
import { buildSingleSignerHanko } from '../../../hanko/batch';
import { safeStringify } from '../../../protocol/serialization';
import {
  RSCORE_PROCESS_ABI_VERSION,
  RSCORE_PROTOCOL_FINGERPRINT,
  RscoreProcessClient,
  type RscoreCheckpointToken,
  type RscoreWireValue,
} from '../../../rscore/client';
import {
  loadRscoreCheckpoint,
  prepareRscoreCheckpointStorage,
} from '../../../storage/schema/rscore/checkpoint';
import type { RscoreDisputeDraft } from '../../../rscore/checkpoint/checkpoint-restore-consensus';
import type { RuntimeDbLike } from '../../../storage/types';
import { computeFrameHash } from '../../../account/consensus/frame/hash';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { handleDirectPayment } from '../../../account/tx/handlers/balance/direct-payment';
import { handleAddDelta } from '../../../account/tx/handlers/balance/add-delta';
import {
  accountTransitionView,
  beginAccountTransition,
  publishAccountTransition,
} from '../../../account/state/candidate-overlay';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { forkAccountReplicaShell } from '../../../account/state/account-replica-shell';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { addr, makeAccount } from '../../helpers/cross-j';
import type { AccountFrame, AccountReplica, AccountTx } from '../../../types/account';

const BINARY = join(import.meta.dir, '../../../../rscore/target/release/xln-rscore');
const POISONED_PROCESS = join(
  import.meta.dir,
  '../../fixtures/process/rscore-poisoned-process.ts',
);

const requiredAt = <T>(values: readonly T[], index: number, field: string): T => {
  const value = values[index];
  if (value === undefined) throw new Error(`RSCORE_TEST_MISSING_${field}:${index}`);
  return value;
};

const memoryDb = (): RuntimeDbLike => {
  const rows = new Map<string, { key: Buffer; value: Buffer }>();
  return {
    get: async key => {
      const row = rows.get(key.toString('hex'));
      if (row) return Buffer.from(row.value);
      const error = new Error('NotFound') as Error & { code?: string };
      error.code = 'LEVEL_NOT_FOUND';
      throw error;
    },
    batch: () => ({
      put: (key, value) => { rows.set(key.toString('hex'), { key: Buffer.from(key), value: Buffer.from(value) }); },
      del: key => { rows.delete(key.toString('hex')); },
      write: async () => {},
    }),
    keys: async function* (options = {}) {
      const keys = [...rows.values()].map(row => row.key).sort(Buffer.compare);
      if (options.reverse) keys.reverse();
      for (const key of keys) {
        if (options.gte && Buffer.compare(key, options.gte) < 0) continue;
        if (options.lt && Buffer.compare(key, options.lt) >= 0) continue;
        yield Buffer.from(key);
      }
    },
  };
};

const exactRestoreFixture = (
  owner: string,
  counterparty: string,
  account: AccountReplica,
  signerId = '1',
): Readonly<{ token: RscoreCheckpointToken; accounts: RscoreWireValue[] }> => {
  const transformer = addr('77');
  const seed = accountSeedWire(
    owner,
    counterparty,
    account.state,
    accountEnvelopeWire(account),
    accountConsensusWire(account),
    transformer,
  );
  const accountId = seed[0] as Uint8Array;
  const ownerBytes = seed[1] as Uint8Array;
  const signerLength = Buffer.alloc(4);
  signerLength.writeUInt32BE(Buffer.byteLength(signerId));
  const signerDigest = createHash('sha256')
    .update('xln.rscore.signer-config.v1')
    .update(accountId)
    .update(ownerBytes)
    .update(signerLength)
    .update(signerId)
    .digest();
  const forest = PersistentEntityAccountMap.fromEntries(
    [[counterparty, forkAccountReplicaShell(account)]],
    owner,
    computeEntityAccountValueHash,
  );
  const root = Buffer.from(forest.rootHash().slice(2), 'hex');
  const leaf = Buffer.from(computeEntityAccountValueHash(account).slice(2), 'hex');
  const clocks = seed[10] as RscoreWireValue[];
  const carried = seed[11] as RscoreWireValue[];
  const header: RscoreWireValue[] = [
    ownerBytes,
    signerId,
    [
      requiredAt(seed, 4, 'SEED_CHAIN_ID'),
      requiredAt(seed, 5, 'SEED_DEPOSITORY'),
      requiredAt(seed, 2, 'SEED_LEFT'),
      requiredAt(seed, 3, 'SEED_RIGHT'),
      requiredAt(seed, 6, 'SEED_WATCH'),
    ],
    requiredAt(seed, 7, 'SEED_DISPUTE'),
    requiredAt(clocks, 0, 'CLOCK_J_NONCE'),
    requiredAt(clocks, 1, 'CLOCK_FINALIZED_HEIGHT'),
    [
      requiredAt(carried, 0, 'CARRIED_PULLS'),
      requiredAt(carried, 2, 'CARRIED_SUBCONTRACTS'),
      requiredAt(carried, 3, 'CARRIED_REQUESTED_REBALANCE'),
      requiredAt(carried, 4, 'CARRIED_LEFT_J_CLAIMS'),
      requiredAt(carried, 6, 'CARRIED_REQUESTED_REBALANCE_FEE'),
      requiredAt(carried, 7, 'CARRIED_RIGHT_J_CLAIMS'),
    ],
    requiredAt(seed, 12, 'SEED_ENVELOPE'),
    requiredAt(seed, 14, 'SEED_DELTA_TRANSFORMER'),
  ];
  return {
    token: [0, 0, root, signerDigest, 1],
    accounts: [[
      accountId,
      leaf,
      header,
      requiredAt(seed, 8, 'SEED_DELTAS'),
      requiredAt(seed, 9, 'SEED_LOCKS'),
      [],
      requiredAt(carried, 1, 'CARRIED_SWAP_OFFERS'),
      requiredAt(carried, 5, 'CARRIED_REBALANCE_POLICIES'),
      requiredAt(seed, 13, 'SEED_CONSENSUS'),
    ]],
  };
};

const identity = () => ({
  engineGeneration: Buffer.alloc(8, 0xa0),
  runtimeId: Buffer.alloc(20, 0x10),
  sessionId: Buffer.alloc(16, 0x20),
});

const exactHankoBytes = (hanko: string): Buffer => {
  const clean = hanko.startsWith('0x') ? hanko.slice(2) : hanko;
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`RSCORE_TEST_HANKO_INVALID:${clean.length}`);
  }
  return Buffer.from(clean, 'hex');
};

const peerDisputeWire = (
  dispute: RscoreDisputeDraft,
  signer: Readonly<{ entityId: string; privateKey: Uint8Array }>,
): RscoreWireValue => [
  exactHankoBytes(buildSingleSignerHanko(
    signer.entityId,
    dispute.hash,
    signer.privateKey,
  )),
  hexToWireBytes(dispute.hash, 32, 'TEST_PEER_DISPUTE_HASH'),
  hexToWireBytes(dispute.proofBodyHash, 32, 'TEST_PEER_PROOF_BODY_HASH'),
  dispute.nonce,
  dispute.proposerIsLeft,
];

const peerProposalWire = (
  frame: AccountFrame & Readonly<{ hanko: string }>,
  dispute: RscoreDisputeDraft | undefined,
  signer: Readonly<{ entityId: string; privateKey: Uint8Array }>,
): RscoreWireValue => [
  accountPeerFrameWire(frame),
  exactHankoBytes(frame.hanko),
  dispute === undefined ? null : peerDisputeWire(dispute, signer),
];

const exactPeerInputOp = (
  operationIndex: number,
  accountId: string,
  fromEntityId: string,
  toEntityId: string,
  account: AccountReplica,
  kind: RscoreWireValue,
): RscoreWireValue => waveInputOp([
  operationIndex,
  hexToWireBytes(accountId, 32, 'TEST_PEER_ACCOUNT'),
  [
    hexToWireBytes(fromEntityId, 32, 'TEST_PEER_FROM'),
    hexToWireBytes(toEntityId, 32, 'TEST_PEER_TO'),
    [
      account.state.domain.chainId,
      hexToWireBytes(
        account.state.domain.depositoryAddress,
        20,
        'TEST_PEER_DEPOSITORY',
      ),
    ],
    [
      account.state.disputeConfig.leftResponseSeconds,
      account.state.disputeConfig.rightResponseSeconds,
    ],
    hexToWireBytes(account.state.watchSeed, 32, 'TEST_PEER_WATCH_SEED'),
    kind,
  ],
]);

const stageAndSeal = async (
  client: RscoreProcessClient,
  token: Uint8Array,
  ownerEntityId: string,
  ops: readonly RscoreWireValue[],
  accountIds: readonly string[],
) => {
  const stageKey = createHash('sha256')
    .update('xln.rscore.test.entity-stage')
    .update(token)
    .update(ownerEntityId)
    .digest();
  await client.beginEntityStage(token, stageKey, 0, {
    ownerEntityId: hexToWireBytes(ownerEntityId, 32, 'TEST_WAVE_OWNER'),
    timestamp: 1_700_000_000_000,
    jHeight: 100,
    entityTimestamp: 1_700_000_000_000,
    finalizedJHeight: 100,
    propose: true,
  });
  const applied = ops.length === 0
    ? null
    : await client.applyAccountWave(token, stageKey, {
        entities: [{
          ownerEntityId: hexToWireBytes(ownerEntityId, 32, 'TEST_WAVE_OWNER'),
          ops,
        }],
      });
  const proposed = accountIds.length === 0
    ? null
    : await client.proposeAccountWave(token, stageKey, {
        entities: [{
          ownerEntityId: hexToWireBytes(ownerEntityId, 32, 'TEST_WAVE_OWNER'),
          accountIds: accountIds.map(accountId =>
            hexToWireBytes(accountId, 32, 'TEST_WAVE_ACCOUNT')),
        }],
      });
  await client.finalizeEntityStage(token, stageKey, 0);
  return {
    applied,
    proposed,
    sealed: await client.sealAccountWave(token),
  };
};

// Live TS→Rust IPC over the real binary: hello → restore(empty) → summary →
// prepare/commit → shutdown. Requires `cargo build --release -p
// xln-rscore-process` (deploy/dev builds it; skip when absent so pure-TS
// environments stay green).
// A release gate sets XLN_RSCORE_REQUIRE_BINARY=1: an absent binary is then a
// failure, never a silent skip.
if (!existsSync(BINARY) && process.env['XLN_RSCORE_REQUIRE_BINARY'] === '1') {
  throw new Error(`RSCORE_BINARY_MISSING:${BINARY}`);
}

test('a malformed reply poisons every concurrent request before another is sent', async () => {
  const client = new RscoreProcessClient(POISONED_PROCESS, identity());
  try {
    const first = client.readCapacityBatch([]);
    const second = client.readCapacityBatch([]);
    const settled = await Promise.allSettled([first, second]);

    expect(settled[0]).toMatchObject({ status: 'rejected' });
    expect(settled[1]).toMatchObject({ status: 'rejected' });
    if (settled[0]?.status === 'rejected') {
      expect(String(settled[0].reason)).toContain('RSCORE_CLIENT_MAGIC_INVALID');
    }
    if (settled[1]?.status === 'rejected') {
      expect(String(settled[1].reason))
        .toMatch(/RSCORE_CLIENT_(?:MAGIC_INVALID|UNEXPECTED_FRAME)/);
    }
  } finally {
    client.kill();
  }
});

test('an invalid reply header poisons the session', async () => {
  for (const [marker, error] of [
    [0x55, 'RSCORE_CLIENT_ABI_VERSION:true'],
    [0x56, 'RSCORE_CLIENT_MESSAGE_KIND:3'],
  ] as const) {
    const client = new RscoreProcessClient(POISONED_PROCESS, identity());
    try {
      await expect(client.readAccountEnvelope(Buffer.alloc(32, marker)))
        .rejects.toThrow(error);
      await expect(client.readAccountEnvelope(Buffer.alloc(32)))
        .rejects.toThrow(error);
    } finally {
      client.kill();
    }
  }
});

test('an unsolicited frame poisons even the valid response before it can return', async () => {
  const client = new RscoreProcessClient(POISONED_PROCESS, identity());
  try {
    const first = client.readAccountEnvelope(Buffer.alloc(32));
    const second = client.readAccountEnvelope(Buffer.alloc(32));
    const settled = await Promise.allSettled([first, second]);

    expect(settled[0]).toMatchObject({ status: 'rejected' });
    expect(settled[1]).toMatchObject({ status: 'rejected' });
    for (const result of settled) {
      if (result.status === 'rejected') {
        expect(String(result.reason)).toContain('RSCORE_CLIENT_UNEXPECTED_FRAME');
      }
    }
  } finally {
    client.kill();
  }
});

test('a fragmented unsolicited frame poisons the valid response before it can return', async () => {
  const client = new RscoreProcessClient(POISONED_PROCESS, identity());
  try {
    await expect(client.readAccountEnvelope(Buffer.alloc(32, 0x44)))
      .rejects.toThrow('RSCORE_CLIENT_UNEXPECTED_FRAME');
  } finally {
    client.kill();
  }
});

test('a queued request owns call-time nested arrays and bytes', async () => {
  const client = new RscoreProcessClient(POISONED_PROCESS, identity());
  try {
    const first = client.readAccountSummaryPage(Buffer.alloc(32, 1), 8, [1]);
    const cursor = Buffer.alloc(32, 7);
    const tokenIds = [7];
    const second = client.readAccountSummaryPage(cursor, 8, tokenIds);

    cursor[0] = 99;
    tokenIds[0] = 99;

    expect(await first).toEqual(['observed', 1, 1]);
    expect(await second).toEqual(['observed', 7, 7]);
  } finally {
    client.kill();
  }
});


describe.skipIf(!existsSync(BINARY))('rscore process client', () => {
  test('a rejected authority Hello cannot downgrade the child to a mirror', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      await expect(client.hello(2, swapMarketPolicyWire(), {
        privateKey: Buffer.alloc(32, 0xff),
        signerId: '1',
      })).rejects.toThrow('RSCORE_PROCESS_ERROR');

      await expect(client.hello(2, swapMarketPolicyWire()))
        .rejects.toThrow('RSCORE_PROCESS_ERROR');
    } finally {
      client.kill();
    }
  });

  test('speaks the framed ABI end to end', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const hello = (await client.hello(4, swapMarketPolicyWire())) as unknown[];
      expect(hello[0]).toBe(RSCORE_PROCESS_ABI_VERSION);
      expect(hello[2]).toBe(4);

      const loaded = (await client.bootstrapAccounts(7, [])) as unknown[];
      expect(loaded[0]).toBe(7);
      // Empty accounts tree commits to the all-zero root.
      expect(new Uint8Array(loaded[1] as Uint8Array)).toEqual(new Uint8Array(32));

      const page = (await client.readAccountSummaryPage(null, 8, [1])) as unknown[];
      expect(page[0]).toBe(7); // revision
      expect(page[1]).toEqual([]); // no accounts
      const totals = page[3] as unknown[];
      expect(totals[0]).toBe(0);

      // Empty waves are refused loudly — no silent no-op commits.
      await expect(client.prepareCandidate([])).rejects.toThrow('RSCORE_BATCH_EMPTY');

      await client.shutdown();
    } finally {
      client.kill();
    }
  });

  test('an authoritative session runs a wave and commits it', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const seed = `0x${'7a'.repeat(32)}`;
      const hello = (await client.hello(2, swapMarketPolicyWire(), {
        privateKey: deriveSignerKeySync(seed, '1'),
        signerId: '1',
      })) as unknown[];
      expect(hello[0]).toBe(RSCORE_PROCESS_ABI_VERSION);

      const loaded = (await client.bootstrapAccounts(0, [])) as unknown[];
      expect(loaded[0]).toBe(0);

      const { result, token } = await client.prepareAccountWave({ entities: [], postAccounts: true });
      expect(token).toHaveLength(32);
      // No accounts, so nothing moved and nothing was proposed — but the wave
      // is still a candidate that must be committed or taken back.
      expect(result.revision).toBe(0);
      expect(result.applied).toEqual([]);
      expect(result.admissions).toEqual([]);

      await expect(
        client.prepareAccountWave({ entities: [], postAccounts: true }),
      ).rejects.toThrow('RSCORE_CLIENT_AUTHORITY_CANDIDATE_PENDING');

      await expect(client.commit(token))
        .rejects.toThrow('RSCORE_CLIENT_AUTHORITY_NOT_SEALED:COMMIT');
      await client.sealAccountWave(token);
      const committed = (await client.commit(token)) as unknown[];
      expect(committed[0]).toBe(0);

      await client.shutdown();
    } finally {
      client.kill();
    }
  });

  test('entity stages bind every mutation and advance only accepted inputs', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const seed = `0x${'7a'.repeat(32)}`;
      await client.hello(2, swapMarketPolicyWire(), {
        privateKey: deriveSignerKeySync(seed, '1'),
        signerId: '1',
      });
      await client.bootstrapAccounts(0, []);

      const prepared = await client.prepareAccountWave({ entities: [], postAccounts: true });
      const ownerEntityId = Buffer.alloc(32, 0x11);
      const context = {
        ownerEntityId,
        timestamp: 1_700_000_000_000,
        jHeight: 100,
        entityTimestamp: 1_700_000_000_000,
        finalizedJHeight: 100,
        propose: true,
      } as const;
      const rolledBackKey = Buffer.alloc(32, 0x41);
      const acceptedKey = Buffer.alloc(32, 0x42);
      const wrongKey = Buffer.alloc(32, 0x43);

      const opened = await client.beginEntityStage(
        prepared.token,
        rolledBackKey,
        0,
        context,
      );
      expect(opened).toEqual({
        stageKey: rolledBackKey,
        status: 'open',
        acceptedStageOrdinal: 0,
        revision: 0,
        accountsRoot: Buffer.alloc(32),
      });

      await expect(client.applyAccountWave(prepared.token, wrongKey, { entities: [] }))
        .rejects.toThrow('RSCORE_CLIENT_ENTITY_STAGE_KEY_MISMATCH:APPLY');
      await expect(client.proposeAccountWave(prepared.token, wrongKey, { entities: [] }))
        .rejects.toThrow('RSCORE_CLIENT_ENTITY_STAGE_KEY_MISMATCH:PROPOSE');
      await expect(client.sealAccountWave(prepared.token))
        .rejects.toThrow('RSCORE_CLIENT_ENTITY_STAGE_ACTIVE:SEAL');
      await expect(client.getCheckpointChanges(prepared.token))
        .rejects.toThrow('RSCORE_CLIENT_ENTITY_STAGE_ACTIVE:CHECKPOINT');
      await expect(client.commit(prepared.token))
        .rejects.toThrow('RSCORE_CLIENT_ENTITY_STAGE_ACTIVE:COMMIT');

      const applied = await client.applyAccountWave(
        prepared.token,
        rolledBackKey,
        { entities: [] },
      );
      expect(applied.revision).toBe(0);
      const rolledBack = await client.discardEntityStage(
        prepared.token,
        rolledBackKey,
        0,
      );
      expect(rolledBack.status).toBe('rolled_back');
      expect(rolledBack.acceptedStageOrdinal).toBe(0);

      await expect(client.beginEntityStage(prepared.token, acceptedKey, 1, context))
        .rejects.toThrow('RSCORE_CLIENT_ENTITY_STAGE_ORDINAL_MISMATCH:BEGIN_ENTITY:1:0');
      await client.beginEntityStage(prepared.token, acceptedKey, 0, context);
      const proposed = await client.proposeAccountWave(
        prepared.token,
        acceptedKey,
        { entities: [] },
      );
      expect(proposed.revision).toBe(0);
      const accepted = await client.finalizeEntityStage(
        prepared.token,
        acceptedKey,
        0,
      );
      expect(accepted.status).toBe('accepted');
      expect(accepted.acceptedStageOrdinal).toBe(1);

      await expect(client.beginEntityStage(prepared.token, wrongKey, 0, context))
        .rejects.toThrow('RSCORE_CLIENT_ENTITY_STAGE_ORDINAL_MISMATCH:BEGIN_ENTITY:0:1');
      await client.sealAccountWave(prepared.token);
      await client.commit(prepared.token);

      // Abort is the one candidate terminal operation allowed with an open
      // Entity stage: process ambiguity poisons, but a successful reply clears
      // the complete candidate and its savepoint together.
      const abortable = await client.prepareAccountWave({ entities: [], postAccounts: true });
      await client.beginEntityStage(abortable.token, wrongKey, 0, context);
      await client.abort(abortable.token);
      const afterAbort = await client.prepareAccountWave({ entities: [], postAccounts: true });
      await client.sealAccountWave(afterAbort.token);
      await client.abort(afterAbort.token);

      await client.shutdown();
    } finally {
      client.kill();
    }
  });

  test('concurrent authority lifecycle calls reserve one serialized candidate', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const seed = `0x${'7a'.repeat(32)}`;
      await client.hello(2, swapMarketPolicyWire(), {
        privateKey: deriveSignerKeySync(seed, '1'),
        signerId: '1',
      });
      await client.bootstrapAccounts(0, []);

      const prepares = await Promise.allSettled([
        client.prepareAccountWave({ entities: [], postAccounts: true }),
        client.prepareAccountWave({ entities: [], postAccounts: true }),
      ]);
      if (prepares[0]?.status !== 'fulfilled') throw prepares[0]?.reason;
      expect(prepares[1]?.status).toBe('rejected');
      if (prepares[1]?.status === 'rejected') {
        expect(String(prepares[1].reason)).toContain('RSCORE_CLIENT_AUTHORITY_CANDIDATE_PENDING');
      }
      const token = prepares[0].value.token;

      const seals = await Promise.allSettled([
        client.sealAccountWave(token),
        client.sealAccountWave(token),
      ]);
      expect(seals[0]?.status).toBe('fulfilled');
      expect(seals[1]?.status).toBe('rejected');
      if (seals[1]?.status === 'rejected') {
        expect(String(seals[1].reason)).toContain('RSCORE_CLIENT_AUTHORITY_ALREADY_SEALED:SEAL');
      }

      const commits = await Promise.allSettled([
        client.commit(token),
        client.commit(token),
      ]);
      expect(commits[0]?.status).toBe('fulfilled');
      expect(commits[1]?.status).toBe('rejected');
      if (commits[1]?.status === 'rejected') {
        expect(String(commits[1].reason)).toContain('RSCORE_CLIENT_AUTHORITY_CANDIDATE_MISSING:COMMIT');
      }

      // Every loser was rejected locally: the process remains usable.
      await client.shutdown();
    } finally {
      client.kill();
    }
  });

  test('a pre-write authority encoding failure leaves the candidate abortable', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const seed = `0x${'7a'.repeat(32)}`;
      await client.hello(2, swapMarketPolicyWire(), {
        privateKey: deriveSignerKeySync(seed, '1'),
        signerId: '1',
      });
      await client.bootstrapAccounts(0, []);
      const prepared = await client.prepareAccountWave({ entities: [], postAccounts: true });
      const stageKey = Buffer.alloc(32, 0x31);
      await client.beginEntityStage(prepared.token, stageKey, 0, {
        ownerEntityId: Buffer.alloc(32, 0x11),
        timestamp: 1,
        jHeight: 1,
        entityTimestamp: 1,
        finalizedJHeight: 1,
        propose: false,
      });

      await expect(client.applyAccountWave(prepared.token, stageKey, {
        entities: [{
          ownerEntityId: Buffer.alloc(32, 0x11),
          ops: [Number.MAX_SAFE_INTEGER + 1],
        }],
      })).rejects.toThrow('RSCORE_CLIENT_INTEGER_UNSAFE');

      await client.abort(prepared.token);
      await client.shutdown();
    } finally {
      client.kill();
    }
  });

  // The whole authoritative path over the real binary: the engine derives its
  // own signer, is handed one funded account, admits a direct_payment, and
  // signs a frame. TypeScript then verifies that frame with its own code —
  // deriving the same identity independently, decoding every field, checking
  // the signature, rebuilding the hash, reaching the same account state root
  // and the same leaf, and recomputing the wave's parity digest.
  test('an authoritative session signs a payment frame TypeScript verifies', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const seed = `0x${'7a'.repeat(32)}`;
      const market = swapMarketPolicyWire();
      const hello = (await client.hello(2, market, {
        privateKey: deriveSignerKeySync(seed, '1'),
        signerId: '1',
      })) as unknown[];
      expect(hello[0]).toBe(RSCORE_PROCESS_ABI_VERSION);
      expect(`0x${Buffer.from(hello[3] as Uint8Array).toString('hex')}`)
        .toBe(swapMarketPolicyDigest(market));

      // TypeScript derives the identity itself and holds the engine to it.
      // Taking the entity from the engine's own answer would prove only that
      // the engine agrees with itself.
      const expectedAddress = deriveSignerAddressSync(seed, '1');
      const expectedOwner = generateLazyEntityId([expectedAddress], 1n);
      expect(`0x${Buffer.from(hello[4] as Uint8Array).toString('hex')}`.toLowerCase())
        .toBe(expectedAddress.toLowerCase());
      expect(`0x${Buffer.from(hello[5] as Uint8Array).toString('hex')}`.toLowerCase())
        .toBe(expectedOwner.toLowerCase());
      const owner = expectedOwner.toLowerCase();

      const counterparty = `0x${'cc'.repeat(32)}`;
      const account = makeAccount(owner, counterparty);
      account.proofHeader.nextProofNonce = 1;
      const restored = exactRestoreFixture(owner, counterparty, account);
      expect(await client.restoreExact(restored.token, restored.accounts)).toEqual(restored.token);

      const tx: AccountTx = {
        type: 'direct_payment',
        data: {
          tokenId: 1,
          amount: 25n,
          route: [counterparty],
          fromEntityId: owner,
          toEntityId: counterparty,
          deliveryMode: 'direct',
        },
      };
      const wireTx = accountTxWire(tx);
      expect(wireTx).not.toBeNull();

      const stagedOps = [waveAdmitOp(0, counterparty, [wireTx])];
      const first = await client.prepareAccountWave({ entities: [], postAccounts: true });
      const {
        applied: firstApply,
        proposed: firstProposal,
        sealed: wave,
      } = await stageAndSeal(client, first.token, owner, stagedOps, [counterparty]);
      if (firstApply === null || firstProposal === null) {
        throw new Error('RSCORE_TEST_EXPECTED_STAGED_PAYMENT');
      }
      expect(firstApply.admissions).toEqual([{
        operationIndex: 0,
        accountId: counterparty,
        verdict: { kind: 'admitted', count: 1 },
      }]);
      expect(firstApply.proposals).toEqual([]);
      expect(firstProposal.admissions).toEqual([]);
      expect(firstProposal.proposals).toHaveLength(1);
      expect(wave.proposals).toHaveLength(1);
      expect(wave.proposals[0]!.accountId).toBe(counterparty);
      expect(wave.proposals[0]!.dropped).toEqual([]);
      expect(wave.touched).toHaveLength(1);

      // The digest is recomputed from the decoded model: it matches only if
      // every field decoded into something that encodes back identically.
      expect(waveParityDigest(wave)).toBe(wave.parityDigest);

      const frame = wave.proposals[0]!.frame;
      if (frame === null) throw new Error('expected a signed frame');
      expect(frame.height).toBe(1);
      expect(frame.prevFrameHash).toBe('genesis');
      // The transaction came back as the transaction that was sent, decoded
      // from the engine's own bytes rather than substituted from this test.
      expect(frame.accountTxs).toEqual([tx]);

      // The signature is checked against the frame it signs and the entity
      // that must have produced it.
      const verified = await verifyHankoForHash(
        frame.hanko as `0x${string}`,
        frame.stateHash,
        owner,
      );
      expect(verified.valid).toBe(true);

      // TypeScript rebuilds the signed hash from the frame it decoded.
      expect(await computeFrameHash(frame)).toBe(frame.stateHash);

      // And the state that frame commits is the state TypeScript reaches by
      // applying the same transaction to the same account, down to the leaf
      // the Entity tree would put in its accounts map.
      const transition = beginAccountTransition(account);
      const applied = handleDirectPayment(
        accountTransitionView(transition),
        tx as Extract<AccountTx, { type: 'direct_payment' }>,
        frame.byLeft,
      );
      expect(applied.ok).toBe(true);
      publishAccountTransition(account, transition, 'rscore-authority-test');
      expect(computeAccountStateRoot(account.state).toLowerCase())
        .toBe(frame.accountStateRoot);
      // The leaf itself is compared against a live replica in the runtime
      // driver, where the shell is the Entity's own, not one this test
      // assembled by hand.
      expect(wave.touched[0]!.accountId).toBe(counterparty);

      // A runtime that could not make its own record durable takes the wave
      // back, and the same request reaches the same candidate again.
      await client.abort(first.token);
      const second = await client.prepareAccountWave({ entities: [], postAccounts: true });
      expect(second.token).toHaveLength(32);
      expect(second.token.equals(first.token)).toBe(false);
      await expect(client.abort(first.token))
        .rejects.toThrow('RSCORE_CLIENT_AUTHORITY_TOKEN_MISMATCH:ABORT');
      const again = (await stageAndSeal(
        client,
        second.token,
        owner,
        stagedOps,
        [counterparty],
      )).sealed;
      expect(again.parityDigest).toBe(wave.parityDigest);

      const committed = (await client.commit(second.token)) as unknown[];
      expect(`0x${Buffer.from(committed[1] as Uint8Array).toString('hex')}`)
        .toBe(again.accountsRoot);

      await client.shutdown();
    } finally {
      client.kill();
    }
  });

  test('exact Frame, Ack and atomic ACK-first FrameAck cross the real process ABI', async () => {
    const payerClient = new RscoreProcessClient(BINARY, identity());
    const payeeClient = new RscoreProcessClient(BINARY, {
      ...identity(),
      sessionId: Buffer.alloc(16, 0x21),
    });
    try {
      const seed = `0x${'7a'.repeat(32)}`;
      const market = swapMarketPolicyWire();
      const payerKey = deriveSignerKeySync(seed, '1');
      const payeeKey = deriveSignerKeySync(seed, '2');
      const payerHello = exactTuple(await payerClient.hello(2, market, {
        privateKey: payerKey,
        signerId: '1',
      }), 6, 'payer hello');
      const payeeHello = exactTuple(await payeeClient.hello(2, market, {
        privateKey: payeeKey,
        signerId: '2',
      }), 6, 'payee hello');
      const payer = `0x${exactBytes(payerHello[5], 32, 'payer owner').toString('hex')}`
        .toLowerCase();
      const payee = `0x${exactBytes(payeeHello[5], 32, 'payee owner').toString('hex')}`
        .toLowerCase();
      const payerAccount = makeAccount(payer, payee);
      const payeeAccount = makeAccount(payee, payer);
      payerAccount.proofHeader.nextProofNonce = 1;
      payeeAccount.proofHeader.nextProofNonce = 1;
      const payerRestore = exactRestoreFixture(payer, payee, payerAccount, '1');
      const payeeRestore = exactRestoreFixture(payee, payer, payeeAccount, '2');
      expect(await payerClient.restoreExact(payerRestore.token, payerRestore.accounts))
        .toEqual(payerRestore.token);
      expect(await payeeClient.restoreExact(payeeRestore.token, payeeRestore.accounts))
        .toEqual(payeeRestore.token);

      const firstTx: AccountTx = {
        type: 'direct_payment',
        data: {
          tokenId: 1,
          amount: 25n,
          route: [payee],
          fromEntityId: payer,
          toEntityId: payee,
          deliveryMode: 'direct',
        },
      };
      const firstTxWire = accountTxWire(firstTx);
      if (firstTxWire === null) throw new Error('RSCORE_TEST_FIRST_TX_WIRE');
      const firstPrepared = await payerClient.prepareAccountWave({ entities: [], postAccounts: true });
      const firstSealed = (await stageAndSeal(
        payerClient,
        firstPrepared.token,
        payer,
        [waveAdmitOp(0, payee, [firstTxWire])],
        [payee],
      )).sealed;
      const firstFrame = firstSealed.proposals[0]?.frame;
      if (firstFrame === null || firstFrame === undefined) {
        throw new Error('RSCORE_TEST_FIRST_FRAME');
      }
      const firstProposalDispute = firstSealed.postAccounts
        .find(row => row.accountId === payee)
        ?.consensus.pending?.proposalDispute;
      if (firstProposalDispute === undefined) {
        throw new Error('RSCORE_TEST_FIRST_PROPOSAL_DISPUTE');
      }
      await payerClient.commit(firstPrepared.token);

      const frameOp = exactPeerInputOp(
        0,
        payer,
        payer,
        payee,
        payeeAccount,
        [0, peerProposalWire(firstFrame, firstProposalDispute, {
          entityId: payer,
          privateKey: payerKey,
        })],
      );
      const framePrepared = await payeeClient.prepareAccountWave({ entities: [], postAccounts: true });
      const frameStage = await stageAndSeal(
        payeeClient,
        framePrepared.token,
        payee,
        [frameOp],
        [],
      );
      if (frameStage.applied === null) throw new Error('RSCORE_TEST_FRAME_RESULT');
      expect(frameStage.applied.applied).toHaveLength(1);
      const frameVerdict = frameStage.applied.applied[0]?.verdict;
      if (frameVerdict?.kind !== 'frameCommitted') {
        throw new Error(`RSCORE_TEST_FRAME_VERDICT:${safeStringify(frameVerdict)}`);
      }
      expect(frameVerdict.height).toBe(1);
      expect(waveParityDigest(frameStage.applied)).toBe(frameStage.applied.parityDigest);
      const firstAckDispute = frameStage.applied.postAccounts
        .find(row => row.accountId === payer)
        ?.consensus.lastOutboundAck?.dispute;
      if (firstAckDispute === undefined) {
        throw new Error('RSCORE_TEST_FIRST_ACK_DISPUTE');
      }
      await payeeClient.commit(framePrepared.token);

      const reverseTx: AccountTx = {
        type: 'direct_payment',
        data: {
          tokenId: 1,
          amount: 7n,
          route: [payer],
          fromEntityId: payee,
          toEntityId: payer,
          deliveryMode: 'direct',
        },
      };
      const reverseTxWire = accountTxWire(reverseTx);
      if (reverseTxWire === null) throw new Error('RSCORE_TEST_REVERSE_TX_WIRE');
      const successorPrepared = await payeeClient.prepareAccountWave({ entities: [], postAccounts: true });
      const successorSealed = (await stageAndSeal(
        payeeClient,
        successorPrepared.token,
        payee,
        [waveAdmitOp(0, payer, [reverseTxWire])],
        [payer],
      )).sealed;
      const successorFrame = successorSealed.proposals[0]?.frame;
      if (successorFrame === null || successorFrame === undefined) {
        throw new Error('RSCORE_TEST_SUCCESSOR_FRAME');
      }
      const successorProposalDispute = successorSealed.postAccounts
        .find(row => row.accountId === payer)
        ?.consensus.pending?.proposalDispute;
      if (successorProposalDispute === undefined) {
        throw new Error('RSCORE_TEST_SUCCESSOR_PROPOSAL_DISPUTE');
      }
      expect(successorFrame.height).toBe(2);
      await payeeClient.commit(successorPrepared.token);

      const firstAckWire: RscoreWireValue = [
        frameVerdict.height,
        hexToWireBytes(frameVerdict.stateHash, 32, 'TEST_PEER_ACK_HASH'),
        exactHankoBytes(frameVerdict.ackHanko),
        peerDisputeWire(firstAckDispute, { entityId: payee, privateKey: payeeKey }),
      ];
      const validFrameAckOp = exactPeerInputOp(
        0,
        payee,
        payee,
        payer,
        payerAccount,
        [2, firstAckWire, peerProposalWire(successorFrame, successorProposalDispute, {
          entityId: payee,
          privateKey: payeeKey,
        })],
      );
      const malformedFrame = {
        ...successorFrame,
        stateHash: `0x${'fe'.repeat(32)}`,
      };
      const malformedFrameAckOp = exactPeerInputOp(
        0,
        payee,
        payee,
        payer,
        payerAccount,
        [2, firstAckWire, peerProposalWire(malformedFrame, successorProposalDispute, {
          entityId: payee,
          privateKey: payeeKey,
        })],
      );

      const firstComposite = await payerClient.prepareAccountWave({ entities: [], postAccounts: true });
      const malformedStageKey = Buffer.alloc(32, 0x91);
      const compositeContext = {
        ownerEntityId: hexToWireBytes(payer, 32, 'TEST_COMPOSITE_OWNER'),
        timestamp: 1_700_000_000_001,
        jHeight: 100,
        entityTimestamp: 1_700_000_000_001,
        finalizedJHeight: 100,
        propose: false,
      } as const;
      await payerClient.beginEntityStage(
        firstComposite.token,
        malformedStageKey,
        0,
        compositeContext,
      );
      const malformed = await payerClient.applyAccountWave(
        firstComposite.token,
        malformedStageKey,
        { entities: [{
          ownerEntityId: compositeContext.ownerEntityId,
          ops: [malformedFrameAckOp],
        }] },
      );
      expect(malformed.applied).toHaveLength(1);
      expect(malformed.revision).toBe(firstComposite.result.revision);
      expect(malformed.accountsRoot).toBe(firstComposite.result.accountsRoot);
      expect(malformed.applied[0]?.verdict).toMatchObject({
        kind: 'frameAckRejected',
        phase: 'frame',
      });
      expect(waveParityDigest(malformed)).toBe(malformed.parityDigest);
      const discarded = await payerClient.discardEntityStage(
        firstComposite.token,
        malformedStageKey,
        0,
      );
      expect(discarded.revision).toBe(firstComposite.result.revision);
      expect(`0x${discarded.accountsRoot.toString('hex')}`)
        .toBe(firstComposite.result.accountsRoot);

      const validStageKey = Buffer.alloc(32, 0x92);
      await payerClient.beginEntityStage(
        firstComposite.token,
        validStageKey,
        0,
        compositeContext,
      );
      const firstValid = await payerClient.applyAccountWave(
        firstComposite.token,
        validStageKey,
        { entities: [{
          ownerEntityId: compositeContext.ownerEntityId,
          ops: [validFrameAckOp],
        }] },
      );
      expect(firstValid.applied).toHaveLength(1);
      const firstCompositeVerdict = firstValid.applied[0]?.verdict;
      if (firstCompositeVerdict?.kind !== 'frameAckApplied') {
        throw new Error(
          `RSCORE_TEST_FRAME_ACK_VERDICT:${firstCompositeVerdict?.kind ?? 'missing'}`,
        );
      }
      expect(firstCompositeVerdict.ackVerdict.kind).toBe('ackCommitted');
      expect(firstCompositeVerdict.frameVerdict.kind).toBe('frameCommitted');
      expect(firstCompositeVerdict.ackVerdict.height).toBe(1);
      expect(firstCompositeVerdict.frameVerdict.height).toBe(2);
      expect(waveParityDigest(firstValid)).toBe(firstValid.parityDigest);
      await payerClient.finalizeEntityStage(firstComposite.token, validStageKey, 0);
      const firstCompositeSealed = await payerClient.sealAccountWave(firstComposite.token);
      const aborted = exactTuple(
        await payerClient.abort(firstComposite.token),
        2,
        'composite abort',
      );
      expect(aborted[0]).toBe(firstComposite.result.revision);
      expect(`0x${exactBytes(aborted[1], 32, 'composite aborted root').toString('hex')}`)
        .toBe(firstComposite.result.accountsRoot);

      const retryComposite = await payerClient.prepareAccountWave({ entities: [], postAccounts: true });
      expect(retryComposite.result.revision).toBe(firstComposite.result.revision);
      expect(retryComposite.result.accountsRoot).toBe(firstComposite.result.accountsRoot);
      await payerClient.beginEntityStage(
        retryComposite.token,
        validStageKey,
        0,
        compositeContext,
      );
      const retryValid = await payerClient.applyAccountWave(
        retryComposite.token,
        validStageKey,
        { entities: [{
          ownerEntityId: compositeContext.ownerEntityId,
          ops: [validFrameAckOp],
        }] },
      );
      expect(retryValid.applied).toHaveLength(1);
      const retryVerdict = retryValid.applied[0]?.verdict;
      if (retryVerdict?.kind !== 'frameAckApplied') {
        throw new Error(`RSCORE_TEST_RETRY_FRAME_ACK:${retryVerdict?.kind ?? 'missing'}`);
      }
      expect(retryVerdict.ackVerdict.kind).toBe('ackCommitted');
      expect(retryVerdict.frameVerdict.kind).toBe('frameCommitted');
      await payerClient.finalizeEntityStage(retryComposite.token, validStageKey, 0);
      const retrySealed = await payerClient.sealAccountWave(retryComposite.token);
      expect(retrySealed.parityDigest).toBe(firstCompositeSealed.parityDigest);
      expect(retrySealed.accountsRoot).toBe(firstCompositeSealed.accountsRoot);
      await payerClient.commit(retryComposite.token);

      if (retryVerdict.frameVerdict.kind !== 'frameCommitted') {
        throw new Error('RSCORE_TEST_RETRY_FRAME_NOT_COMMITTED');
      }
      const successorAckDispute = retryValid.postAccounts
        .find(row => row.accountId === payee)
        ?.consensus.lastOutboundAck?.dispute;
      if (successorAckDispute === undefined) {
        throw new Error('RSCORE_TEST_SUCCESSOR_ACK_DISPUTE');
      }
      const successorAckWire: RscoreWireValue = [
        retryVerdict.frameVerdict.height,
        hexToWireBytes(
          retryVerdict.frameVerdict.stateHash,
          32,
          'TEST_SUCCESSOR_ACK_HASH',
        ),
        exactHankoBytes(retryVerdict.frameVerdict.ackHanko),
        peerDisputeWire(successorAckDispute, { entityId: payer, privateKey: payerKey }),
      ];
      const ackOp = exactPeerInputOp(
        0,
        payer,
        payer,
        payee,
        payeeAccount,
        [1, successorAckWire],
      );
      const ackPrepared = await payeeClient.prepareAccountWave({ entities: [], postAccounts: true });
      const ackStage = await stageAndSeal(
        payeeClient,
        ackPrepared.token,
        payee,
        [ackOp],
        [],
      );
      if (ackStage.applied === null) throw new Error('RSCORE_TEST_ACK_RESULT');
      expect(ackStage.applied.applied).toHaveLength(1);
      expect(ackStage.applied.applied[0]?.verdict).toMatchObject({
        kind: 'ackCommitted',
        height: 2,
      });
      expect(waveParityDigest(ackStage.applied)).toBe(ackStage.applied.parityDigest);
      await payeeClient.commit(ackPrepared.token);

      await payerClient.shutdown();
      await payeeClient.shutdown();
    } finally {
      payerClient.kill();
      payeeClient.kill();
    }
  });

  test('creates genesis inside the candidate and restores it exactly', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const seed = `0x${'7a'.repeat(32)}`;
      const market = swapMarketPolicyWire();
      const hello = (await client.hello(2, market, {
        privateKey: deriveSignerKeySync(seed, '1'),
        signerId: '1',
      })) as unknown[];
      const owner = `0x${Buffer.from(hello[5] as Uint8Array).toString('hex')}`.toLowerCase();
      const counterparty = `0x${'cd'.repeat(32)}`;
      const account = makeAccount(owner, counterparty);
      account.state.deltas = PersistentAccountStateMap.empty('deltas');
      // Production OpenAccount starts proof numbering at one; nonce zero is
      // not a usable dispute proof and is never the canonical Entity leaf.
      account.proofHeader.nextProofNonce = 1;

      await client.bootstrapAccounts(0, []);
      const tx: AccountTx = { type: 'add_delta', data: { tokenId: 1 } };
      const wireTx = accountTxWire(tx);
      if (wireTx === null) throw new Error('expected add_delta wire transaction');
      const stagedOps = [
        waveCreateOp(0, accountSeedWire(
          owner,
          counterparty,
          account.state,
          accountEnvelopeWire(account),
          null,
          addr('77'),
        )),
        waveAdmitOp(1, counterparty, [wireTx]),
      ];

      const first = await client.prepareAccountWave({ entities: [], postAccounts: true });
      const {
        applied: firstApply,
        sealed: firstSealed,
      } = await stageAndSeal(client, first.token, owner, stagedOps, [counterparty]);
      if (firstApply === null) throw new Error('RSCORE_TEST_EXPECTED_STAGED_CREATE');
      expect(firstApply.admissions).toEqual([{
        operationIndex: 1,
        accountId: counterparty,
        verdict: { kind: 'admitted', count: 1 },
      }]);
      expect(firstApply.touched).toHaveLength(1);
      account.mempool.push(tx);
      expect(requiredAt(firstApply.touched, 0, 'FIRST_APPLY_TOUCHED').entityAccountLeaf)
        .toBe(computeEntityAccountValueHash(account).toLowerCase());
      const firstFrame = firstSealed.proposals[0]?.frame;
      if (firstFrame === null || firstFrame === undefined) {
        throw new Error('expected created account height-one frame');
      }
      expect(firstFrame.height).toBe(1);
      expect(firstFrame.prevFrameHash).toBe('genesis');
      expect(firstFrame.accountTxs).toEqual([tx]);
      expect(await computeFrameHash(firstFrame)).toBe(firstFrame.stateHash);
      expect((await verifyHankoForHash(firstFrame.hanko as `0x${string}`, firstFrame.stateHash, owner)).valid)
        .toBe(true);

      const transition = beginAccountTransition(account);
      const applied = handleAddDelta(
        accountTransitionView(transition).state,
        tx as Extract<AccountTx, { type: 'add_delta' }>,
      );
      expect(applied.ok).toBe(true);
      publishAccountTransition(account, transition, 'rscore-create-test');
      expect(computeAccountStateRoot(account.state).toLowerCase())
        .toBe(firstFrame.accountStateRoot);

      await client.abort(first.token);

      // Repeating Create itself proves abort removed both the Account and its
      // signer binding: either survivor makes the second Prepare fail loudly.
      const second = await client.prepareAccountWave({ entities: [], postAccounts: true });
      const secondSealed = (await stageAndSeal(
        client,
        second.token,
        owner,
        stagedOps,
        [counterparty],
      )).sealed;
      expect(secondSealed.parityDigest).toBe(firstSealed.parityDigest);
      expect(secondSealed.accountsRoot).toBe(firstSealed.accountsRoot);

      const checkpoint = await client.getCheckpointChanges(second.token);
      expect(checkpoint.accounts).toHaveLength(1);
      const db = memoryDb();
      const storage = await prepareRscoreCheckpointStorage(db, [{
        ownerEntityId: owner,
        protocolFingerprint: `0x${RSCORE_PROTOCOL_FINGERPRINT.toString('hex')}`,
        checkpoint,
      }]);
      const batch = db.batch();
      for (const key of storage.dels) batch.del(key);
      for (const row of storage.puts) batch.put(row.key, row.value);
      await batch.write({ sync: true });
      await client.commit(second.token);
      await client.commitCheckpoint(checkpoint.commitToken);

      const persisted = await loadRscoreCheckpoint(db, owner);
      if (persisted === null) throw new Error('expected created account checkpoint');
      const restarted = new RscoreProcessClient(BINARY, identity());
      try {
        await restarted.hello(2, market, {
          privateKey: deriveSignerKeySync(seed, '1'),
          signerId: '1',
        });
        expect(await restarted.restoreExact(
          persisted.restoreToken,
          persisted.accounts,
        )).toEqual(checkpoint.restoreToken);
        const idle = await restarted.prepareAccountWave({ entities: [], postAccounts: true });
        await restarted.sealAccountWave(idle.token);
        const afterRestore = await restarted.getCheckpointChanges(idle.token);
        expect(afterRestore.restoreToken[4]).toBe(1);
        expect(afterRestore.accounts).toEqual([]);
        expect(afterRestore.removed).toEqual([]);
        await restarted.abort(idle.token);
        await restarted.shutdown();
      } finally {
        restarted.kill();
      }

      await client.shutdown();
    } finally {
      client.kill();
    }
  });

  // A request the client never wrote must not consume a request id: the
  // session pins them to an exact sequence, so a spent-but-unsent id would
  // make every later request fail that check and take the engine down.
  test('a request that was never written leaves the sequence intact', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      await client.hello(2, swapMarketPolicyWire());
      await client.bootstrapAccounts(3, []);

      await expect(
        client.readAccountSummaryPage(undefined as never, 8, [1]),
      ).rejects.toThrow('RSCORE_CLIENT_VALUE_UNSUPPORTED');

      const page = (await client.readAccountSummaryPage(null, 8, [1])) as unknown[];
      expect(page[0]).toBe(3);

      await client.shutdown();
    } finally {
      client.kill();
    }
  });

  // A window where every transaction is rejected produces no frame, but it
  // still moved the account. The wave must say so, or a driver would compare
  // a tree the engine changed against one it did not.
  test('a window that proposes nothing still reports what it dropped', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const seed = `0x${'7a'.repeat(32)}`;
      const hello = (await client.hello(2, swapMarketPolicyWire(), {
        privateKey: deriveSignerKeySync(seed, '1'),
        signerId: '1',
      })) as unknown[];
      const owner = `0x${Buffer.from(hello[5] as Uint8Array).toString('hex')}`.toLowerCase();
      const counterparty = `0x${'ce'.repeat(32)}`;
      const account = makeAccount(owner, counterparty);
      account.proofHeader.nextProofNonce = 1;
      const restored = exactRestoreFixture(owner, counterparty, account);
      expect(await client.restoreExact(restored.token, restored.accounts)).toEqual(restored.token);

      // Far beyond anything the account can cover, and not a rejection that is
      // retried, so the transaction leaves the mempool for good.
      const tx: AccountTx = {
        type: 'direct_payment',
        data: {
          tokenId: 1,
          amount: 10n ** 40n,
          route: [counterparty],
          fromEntityId: owner,
          toEntityId: counterparty,
          deliveryMode: 'direct',
        },
      };
      const prepared = await client.prepareAccountWave({ entities: [], postAccounts: true });
      const wave = (await stageAndSeal(
        client,
        prepared.token,
        owner,
        [waveAdmitOp(0, counterparty, [accountTxWire(tx)] as never)],
        [counterparty],
      )).sealed;

      expect(wave.proposals).toHaveLength(1);
      expect(wave.proposals[0]!.frame).toBeNull();
      expect(wave.proposals[0]!.dropped).toHaveLength(1);
      const dropped = wave.proposals[0]!.dropped[0]!;
      expect(dropped.index).toBe(0);
      expect(dropped.disposition).toBe('removed');
      expect(dropped.code.length).toBeGreaterThan(0);
      expect(wave.touched).toHaveLength(1);
      expect(waveParityDigest(wave)).toBe(wave.parityDigest);

      await client.commit(prepared.token);
      await client.shutdown();
    } finally {
      client.kill();
    }
  });
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
