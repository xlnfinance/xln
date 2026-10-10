import { describe, expect, test } from 'bun:test';

import { handleHtlcLock } from '../../account/tx/handlers/htlc/lock';
import {
  accountTransitionView,
  beginAccountTransition,
  commitAccountTransition,
} from '../../account/state/candidate-overlay';
import { createDefaultDelta } from '../../account/state/delta';
import { INT512_MAX, INT512_MIN, UINT256_MAX } from '../../protocol/boundary/integer-ranges';
import { buildAccountProofBody } from '../../protocol/dispute/proof-builder';
import { hashHtlcSecret } from '../../protocol/htlc/utils';
import { encodeBuffer } from '../../storage/codec/codec';
import { createSnapshot, readSnapshotDocs } from '../../storage/database/lifecycle';
import { KEY_HEAD, STORAGE_SCHEMA_VERSION, keyLiveAccount } from '../../storage/keys';
import { hydrateAccountDocFromStorage } from '../../storage/read/projections';
import { prepareAccountStorageLayout, readAccountStorageLayout } from '../../storage/schema/account-layout';
import {
  assertStorageAccountDocBinding,
  validateStorageAccountDocValue,
} from '../../storage/schema/authoritative-schema';
import type { AccountReplica, PullCommitment } from '../../types/account';
import { MemoryRuntimeDb } from '../fixtures/storage/memory-runtime-db';
import { entity, makeAccount, putTestAccountDelta, putTestAccountPull } from '../helpers/cross-j';

const left = entity('11');
const right = entity('22');
const DELTA_TRANSFORMER = '0x00000000000000000000000000000000000000f1';
const clock = { committedTimestamp: 1_000, enforcementTimestamp: 1_000, enforcementJHeight: 0 };

const lockTx = (secret: string) => {
  const hashlock = hashHtlcSecret(secret);
  return {
    type: 'htlc_lock' as const,
    data: { lockId: hashlock, hashlock, timelock: 60_000n, revealBeforeHeight: 10, amount: UINT256_MAX, tokenId: 1 },
  };
};

const pull = (pullId: string, amount: bigint, byte: string): PullCommitment => ({
  pullId,
  tokenId: 2,
  amount,
  claimedRatio: 0,
  claimedAmount: 0n,
  fullHash: entity(`${byte}1`),
  partialRoot: entity(`${byte}2`),
  crossJurisdiction: { orderId: `order-${pullId}`, routeHash: entity('77'), leg: 'source' },
  createdHeight: 1,
  createdTimestamp: 1_000,
});

/**
 * Every value below is one the live engine commits and the chain encodes:
 * htlc_lock admits the full uint256 SignedAmount magnitude for either sender,
 * a pull carries a SignedAmount, and ondelta/offdelta are Solidity Int512.
 * Storage used to cap them at int256, so the next restart failed to read the
 * committed Account (STORAGE_ACCOUNT_DOC_INVALID_STATE_LOCK_AMOUNT / _DELTA_*).
 */
const liveBoundaryAccount = async (): Promise<AccountReplica> => {
  const account = makeAccount(left, right);
  putTestAccountDelta(account, { ...createDefaultDelta(1), leftCreditLimit: UINT256_MAX, rightCreditLimit: UINT256_MAX });
  const transition = beginAccountTransition(account);
  const draft = accountTransitionView(transition);
  expect((await handleHtlcLock(draft, lockTx(entity('41')), true, clock)).ok).toBe(true);
  expect((await handleHtlcLock(draft, lockTx(entity('42')), false, clock)).ok).toBe(true);
  const committed = commitAccountTransition(transition, 'storage-live-bounds').account;
  putTestAccountDelta(committed, { ...createDefaultDelta(2), ondelta: INT512_MIN, offdelta: INT512_MAX });
  putTestAccountPull(committed, 'pull-left', pull('pull-left', UINT256_MAX, 'a'));
  putTestAccountPull(committed, 'pull-right', pull('pull-right', -UINT256_MAX, 'b'));
  return committed;
};

const writeAccount = async (db: MemoryRuntimeDb, account: AccountReplica): Promise<void> => {
  const layout = await prepareAccountStorageLayout(db, left, right, keyLiveAccount(left, right), account);
  const batch = db.batch();
  for (const row of layout.puts) batch.put(row.key, row.value);
  await batch.write();
};

const writeSnapshotHead = async (db: MemoryRuntimeDb): Promise<void> => {
  const batch = db.batch();
  batch.put(KEY_HEAD, encodeBuffer({
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: 1,
    latestMaterializedHeight: 1,
    latestSnapshotHeight: 0,
    snapshotPeriodFrames: 100,
    retainSnapshots: 10,
    epochMaxBytes: Number.MAX_SAFE_INTEGER,
    accountMerkleRadix: 16,
    epochReplayBytes: 0,
    retainedWalBytes: 0,
  }));
  await batch.write();
};

describe('storage accepts exactly the Account money domain the live engine commits', () => {
  test('uint256 locks and pulls plus Int512 deltas round-trip through write, read and restore', async () => {
    const account = await liveBoundaryAccount();
    const db = new MemoryRuntimeDb();
    await writeAccount(db, account);

    const stored = await readAccountStorageLayout(db, left, right, keyLiveAccount(left, right));
    expect(stored?.doc).toEqual(account);
    // Restart: the live-state reader re-validates and hydrates the same doc.
    const restored = hydrateAccountDocFromStorage(
      assertStorageAccountDocBinding(validateStorageAccountDocValue(stored!.doc), left, right, 'restart'),
    );
    expect([...restored.state.locks.values()].map(lock => [lock.senderIsLeft, lock.amount])).toEqual(
      expect.arrayContaining([[true, UINT256_MAX], [false, UINT256_MAX]]),
    );
    expect(restored.state.deltas.get(2)).toMatchObject({ ondelta: INT512_MIN, offdelta: INT512_MAX });
    expect(restored.state.pulls?.get('pull-right')?.amount).toBe(-UINT256_MAX);
    // The restored state still encodes as the on-chain dispute ProofBody.
    const proofBody = buildAccountProofBody(restored, DELTA_TRANSFORMER);
    expect(proofBody.proofBodyHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(proofBody.proofBodyHash).toBe(buildAccountProofBody(account, DELTA_TRANSFORMER).proofBodyHash);
    expect(proofBody.runtimeProofBody.offdeltas).toContain(INT512_MAX);

    const snapshot = new MemoryRuntimeDb();
    await writeSnapshotHead(snapshot);
    await createSnapshot(db, snapshot, 1, 1_000);
    const docs = await readSnapshotDocs(snapshot, 1);
    expect(docs.find(doc => doc.family === 'account')?.value).toEqual(account);
  });

  test('one unit past the live domain is still refused as corruption', async () => {
    const outside: Array<[string, (account: AccountReplica) => void]> = [
      ['lock above uint256', account => {
        const [lockId, lock] = [...account.state.locks.entries()][0]!;
        account.state.locks = new Map([[lockId, { ...lock, amount: UINT256_MAX + 1n }]]) as never;
      }],
      ['pull below -uint256', account => putTestAccountPull(account, 'pull-right', pull('pull-right', -UINT256_MAX - 1n, 'b'))],
      ['offdelta above int512', account =>
        putTestAccountDelta(account, { ...createDefaultDelta(2), offdelta: INT512_MAX + 1n })],
      ['ondelta below int512', account =>
        putTestAccountDelta(account, { ...createDefaultDelta(2), ondelta: INT512_MIN - 1n })],
    ];
    for (const [name, mutate] of outside) {
      const account = await liveBoundaryAccount();
      mutate(account);
      expect(() => validateStorageAccountDocValue(account), name).toThrow();
    }
  });
});
