import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  accountEnvelopeWire,
  accountConsensusWire,
  accountSeedWire,
  accountTxWire,
  hexToWireBytes,
  swapMarketPolicyDigest,
  swapMarketPolicyWire,
  waveAdmitOp,
  waveCreateOp,
} from '../../rscore/shadow-wire';
import { waveParityDigest } from '../../rscore/wave-decode';
import { deriveSignerAddressSync, deriveSignerKeySync } from '../../account/crypto';
import { generateLazyEntityId } from '../../entity/factory';
import { verifyHankoForHash } from '../../hanko/signing';
import {
  RSCORE_PROCESS_ABI_VERSION,
  RSCORE_PROTOCOL_FINGERPRINT,
  RscoreProcessClient,
  type RscoreCheckpointToken,
  type RscoreWireValue,
} from '../../rscore/client';
import {
  loadRscoreCheckpoint,
  prepareRscoreCheckpointStorage,
} from '../../storage/schema/rscore/checkpoint';
import type { RuntimeDbLike } from '../../storage/types';
import { computeFrameHash } from '../../account/consensus/frame/hash';
import { computeAccountStateRoot } from '../../account/commitment/state-root';
import { computeEntityAccountValueHash } from '../../entity/consensus/state-root';
import { handleDirectPayment } from '../../account/tx/handlers/balance/direct-payment';
import { handleAddDelta } from '../../account/tx/handlers/balance/add-delta';
import {
  accountTransitionView,
  beginAccountTransition,
  publishAccountTransition,
} from '../../account/state/candidate-overlay';
import { PersistentAccountStateMap } from '../../account/state/persistent-state-map';
import { forkAccountReplicaShell } from '../../account/state/account-replica-shell';
import { PersistentEntityAccountMap } from '../../entity/state/persistent-account-map';
import { addr, makeAccount } from '../helpers/cross-j';
import type { AccountReplica, AccountTx } from '../../types/account';

const BINARY = join(import.meta.dir, '../../../rscore/target/release/xln-rscore');
const POISONED_PROCESS = join(
  import.meta.dir,
  '../fixtures/process/rscore-poisoned-process.ts',
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

const proposeAndSeal = async (
  client: RscoreProcessClient,
  token: Uint8Array,
  ownerEntityId: string,
  accountIds: readonly string[],
) => {
  if (accountIds.length !== 0) {
    await client.proposeAccountWave(token, {
      entities: [{
        ownerEntityId: hexToWireBytes(ownerEntityId, 32, 'TEST_WAVE_OWNER'),
        accountIds: accountIds.map(accountId =>
          hexToWireBytes(accountId, 32, 'TEST_WAVE_ACCOUNT')),
      }],
    });
  }
  return client.sealAccountWave(token);
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

      const { result, token } = await client.prepareAccountWave({
        entities: [{
          ownerEntityId: hexToWireBytes(`0x${'11'.repeat(32)}`, 32, 'TEST_OWNER'),
          timestamp: 1_700_000_000_000,
          jHeight: 100,
          entityTimestamp: 1_700_000_000_000,
          finalizedJHeight: 100,
          propose: true,
          ops: [],
        }],
      });
      expect(token).toHaveLength(32);
      // No accounts, so nothing moved and nothing was proposed — but the wave
      // is still a candidate that must be committed or taken back.
      expect(result.revision).toBe(0);
      expect(result.applied).toEqual([]);
      expect(result.admissions).toEqual([]);

      await expect(
        client.prepareAccountWave({
          entities: [{
            ownerEntityId: hexToWireBytes(`0x${'11'.repeat(32)}`, 32, 'TEST_OWNER'),
            timestamp: 1_700_000_000_001,
            jHeight: 100,
            entityTimestamp: 1_700_000_000_001,
            finalizedJHeight: 100,
            propose: true,
            ops: [],
          }],
        }),
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
        client.prepareAccountWave({ entities: [] }),
        client.prepareAccountWave({ entities: [] }),
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
      const prepared = await client.prepareAccountWave({ entities: [] });

      await expect(client.applyAccountWave(prepared.token, {
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

      const request = {
        entities: [{
          ownerEntityId: hexToWireBytes(owner, 32, 'TEST_OWNER'),
          timestamp: 1_700_000_000_000,
          jHeight: 100,
          entityTimestamp: 1_700_000_000_000,
          finalizedJHeight: 100,
          propose: true,
          ops: [waveAdmitOp(0, counterparty, [wireTx])],
        }],
      };
      const first = await client.prepareAccountWave(request);
      const firstApply = first.result;
      expect(firstApply.admissions).toEqual([{
        operationIndex: 0,
        accountId: counterparty,
        verdict: { kind: 'admitted', count: 1 },
      }]);
      expect(firstApply.proposals).toEqual([]);
      const firstProposal = await client.proposeAccountWave(first.token, {
        entities: [{
          ownerEntityId: hexToWireBytes(owner, 32, 'TEST_OWNER'),
          accountIds: [hexToWireBytes(counterparty, 32, 'TEST_ACCOUNT')],
        }],
      });
      expect(firstProposal.admissions).toEqual([]);
      expect(firstProposal.proposals).toHaveLength(1);
      const wave = await client.sealAccountWave(first.token);
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
      const second = await client.prepareAccountWave(request);
      expect(second.token).toHaveLength(32);
      expect(second.token.equals(first.token)).toBe(false);
      await expect(client.abort(first.token))
        .rejects.toThrow('RSCORE_CLIENT_AUTHORITY_TOKEN_MISMATCH:ABORT');
      const again = await proposeAndSeal(client, second.token, owner, [counterparty]);
      expect(again.parityDigest).toBe(wave.parityDigest);

      const committed = (await client.commit(second.token)) as unknown[];
      expect(`0x${Buffer.from(committed[1] as Uint8Array).toString('hex')}`)
        .toBe(again.accountsRoot);

      await client.shutdown();
    } finally {
      client.kill();
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
      const request = {
        entities: [{
          ownerEntityId: hexToWireBytes(owner, 32, 'TEST_OWNER'),
          timestamp: 1_700_000_000_000,
          jHeight: 100,
          entityTimestamp: 1_700_000_000_000,
          finalizedJHeight: 100,
          propose: true,
          ops: [
            waveCreateOp(0, accountSeedWire(
              owner,
              counterparty,
              account.state,
              accountEnvelopeWire(account),
              null,
              addr('77'),
            )),
            waveAdmitOp(1, counterparty, [wireTx]),
          ],
        }],
      };

      const first = await client.prepareAccountWave(request);
      const firstApply = first.result;
      expect(firstApply.admissions).toEqual([{
        operationIndex: 1,
        accountId: counterparty,
        verdict: { kind: 'admitted', count: 1 },
      }]);
      expect(firstApply.touched).toHaveLength(1);
      account.mempool.push(tx);
      expect(requiredAt(firstApply.touched, 0, 'FIRST_APPLY_TOUCHED').entityAccountLeaf)
        .toBe(computeEntityAccountValueHash(account).toLowerCase());
      const firstSealed = await proposeAndSeal(client, first.token, owner, [counterparty]);
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
      const second = await client.prepareAccountWave(request);
      const secondSealed = await proposeAndSeal(client, second.token, owner, [counterparty]);
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
        const idle = await restarted.prepareAccountWave({ entities: [] });
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
      const prepared = await client.prepareAccountWave({
        entities: [{
          ownerEntityId: hexToWireBytes(owner, 32, 'TEST_OWNER'),
          timestamp: 1_700_000_000_000,
          jHeight: 100,
          entityTimestamp: 1_700_000_000_000,
          finalizedJHeight: 100,
          propose: true,
          ops: [waveAdmitOp(0, counterparty, [accountTxWire(tx)] as never)],
        }],
      });
      const wave = await proposeAndSeal(client, prepared.token, owner, [counterparty]);

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
