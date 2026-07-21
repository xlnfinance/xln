import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  getFrameDb,
  getRuntimeStorageDb,
  loadEnvFromDB,
} from '../runtime';
import { deriveSignerAddressSync } from '../account/crypto';
import {
  createAccountJClaimProof,
  verifyAccountJClaimProof,
} from '../account/j-claim-accumulator';
import { getAccountJClaimNodeStore } from '../account/j-claim-store';
import { generateLazyEntityId } from '../entity/factory';
import { canonicalJurisdictionEventsHash } from '../jurisdiction/event-observation';
import { dbRootPath } from '../machine/platform';
import { decodeBuffer, encodeBuffer } from '../storage/codec';
import { keyAccountJClaimNode, keyDiff } from '../storage/keys';
import { hydrateAccountJClaimRootNodesFromStorage } from '../storage/read';
import type { StorageDiffRecord } from '../storage/types';
import type { AccountJClaimNode, AccountJClaimRecord } from '../types/account-j-claims';

const fixture = join(import.meta.dir, 'fixtures/account-j-claim-storage-crash-child.ts');
const namespaces: Array<{ dbRoot: string; runtimeId: string }> = [];

const cleanupRuntimeStorage = (dbRoot: string, runtimeId: string): void => {
  const namespacePath = join(dbRoot, runtimeId);
  rmSync(namespacePath, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
  rmSync(`${namespacePath}-frames`, { recursive: true, force: true });
  rmSync(`${namespacePath}-events`, { recursive: true, force: true });
  rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
};

afterEach(() => {
  while (namespaces.length > 0) {
    const namespace = namespaces.pop()!;
    cleanupRuntimeStorage(namespace.dbRoot, namespace.runtimeId);
  }
});

describe('Account J-claim real storage crash recovery', () => {
  for (const boundary of [
    'before-authoritative-history-commit',
    'after-authoritative-history-commit',
    'after-current-cache-commit',
  ] as const) {
    test(`publishes Account root and immutable CAS nodes atomically across SIGKILL ${boundary}`, async () => {
      const dbRoot = dbRootPath;
      mkdirSync(dbRoot, { recursive: true });
      const seed = `account J CAS crash ${process.pid} ${boundary} deterministic seed`;
      const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
      const entityId = generateLazyEntityId([runtimeId], 1n).toLowerCase();
      const counterpartySigner = deriveSignerAddressSync(seed, '2').toLowerCase();
      const counterpartyId = generateLazyEntityId([counterpartySigner], 1n).toLowerCase();
      namespaces.push({ dbRoot, runtimeId });
      cleanupRuntimeStorage(dbRoot, runtimeId);

      const child = Bun.spawn({
        cmd: [process.execPath, fixture, seed, boundary],
        cwd: join(import.meta.dir, '..', '..'),
        env: { ...process.env, XLN_DB_PATH: dbRoot },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await child.exited;
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(exitCode, `${stdout}\n${stderr}`).toBe(137);
      expect(child.signalCode, `${stdout}\n${stderr}`).toBe('SIGKILL');

      const restored = await loadEnvFromDB(runtimeId, seed);
      if (!restored) throw new Error('ACCOUNT_J_CRASH_RESTORE_MISSING');
      try {
        const replica = Array.from(restored.eReplicas.values()).find((candidate) => candidate.entityId === entityId);
        const account = replica?.state.accounts.get(counterpartyId);
        if (!account) throw new Error('ACCOUNT_J_CRASH_RESTORED_ACCOUNT_MISSING');
        const side = account.leftEntity === entityId ? 'left' as const : 'right' as const;
        const state = side === 'left' ? account.leftPendingJClaims : account.rightPendingJClaims;
        const expectedCount = boundary === 'before-authoritative-history-commit' ? 0n : 1n;
        expect(state.count).toBe(expectedCount);
        if (expectedCount === 0n) return;

        const restoredNode = getAccountJClaimNodeStore(restored).get(state.root);
        if (!restoredNode || restoredNode.type !== 'leaf') {
          throw new Error('ACCOUNT_J_CRASH_RESTORED_LEAF_MISSING');
        }
        const record: AccountJClaimRecord = restoredNode.record;
        const expectedEventsHash = canonicalJurisdictionEventsHash([{
          type: 'AccountSettled',
          data: {
            leftEntity: account.leftEntity,
            rightEntity: account.rightEntity,
            tokenId: 1,
            leftReserve: '0',
            rightReserve: '0',
            collateral: '0',
            ondelta: '0',
            nonce: 1,
          },
        }]);
        expect(record).toMatchObject({
          side,
          jHeight: 7,
          jBlockHash: `0x${'41'.repeat(32)}`,
          eventsHash: expectedEventsHash,
        });
        const proof = createAccountJClaimProof(getAccountJClaimNodeStore(restored), state.root, record);
        expect(verifyAccountJClaimProof(state.root, record, proof)).toEqual({ status: 'member', record });

        const historyDb = getFrameDb(restored);
        const persistedNode = decodeBuffer<AccountJClaimNode>(await historyDb.get(keyAccountJClaimNode(state.root)));
        const diff = decodeBuffer<StorageDiffRecord>(await historyDb.get(keyDiff(restored.height)));
        const accountDoc = diff.puts.find((doc) => (
          doc.family === 'account' && doc.entityId === entityId && doc.counterpartyId === counterpartyId
        ));
        expect(accountDoc?.family === 'account' && (
          side === 'left'
            ? accountDoc.value.leftPendingJClaims
            : accountDoc.value.rightPendingJClaims
        )).toEqual(state);
        expect(persistedNode).toEqual(getAccountJClaimNodeStore(restored).get(state.root));

        if (boundary === 'after-current-cache-commit') {
          const currentDb = getRuntimeStorageDb(restored);
          const key = keyAccountJClaimNode(state.root);
          const original = await currentDb.get(key);
          const missingBatch = currentDb.batch();
          if (typeof missingBatch.del !== 'function') throw new Error('ACCOUNT_J_CRASH_DB_DELETE_UNSUPPORTED');
          missingBatch.del(key);
          await missingBatch.write();
          await expect(hydrateAccountJClaimRootNodesFromStorage(
            createEmptyEnv(`${seed}:missing`), currentDb, [state],
          )).rejects.toThrow(`ACCOUNT_J_CLAIM_NODE_MISSING:${state.root}`);

          const corruptNode: AccountJClaimNode = persistedNode.type === 'leaf'
            ? {
                ...persistedNode,
                record: { ...persistedNode.record, eventsHash: `0x${'ff'.repeat(32)}` },
              }
            : { ...persistedNode, bit: (persistedNode.bit + 1) % 256 };
          const corruptBatch = currentDb.batch();
          corruptBatch.put(key, encodeBuffer(corruptNode));
          await corruptBatch.write();
          await expect(hydrateAccountJClaimRootNodesFromStorage(
            createEmptyEnv(`${seed}:corrupt`), currentDb, [state],
          )).rejects.toThrow('ACCOUNT_J_CLAIM_NODE_CORRUPT');

          const restoreBatch = currentDb.batch();
          restoreBatch.put(key, original);
          await restoreBatch.write();
        }
      } finally {
        await closeRuntimeDb(restored);
        await closeInfraDb(restored);
      }
    }, 60_000);
  }
});
