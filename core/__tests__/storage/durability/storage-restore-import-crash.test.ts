import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import {
  closeInfraDb,
  closeRuntimeDb,
  getRuntimeWalDb,
  getRuntimeStorageDb,
  loadEnvFromDB,
} from '../../../runtime';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { LIMITS } from '../../../config/constants';
import { generateLazyEntityId } from '../../../entity/factory';
import { dbRootPath } from '../../../runtime/replica/platform';
import { readStorageHead, recoverStorageDbFromWal } from '../../../storage';
import type { StoragePersistenceBoundary } from '../../../storage/types';

const fixture = join(import.meta.dir, '..', '..', 'fixtures/storage/storage-restore-import-crash-child.ts');
const namespaces: string[] = [];
const boundaries = [
  ['after-restore-current-fence', 1],
  ['after-restore-current-clear-batch', 1],
  ['after-restore-current-body', 1],
  ['after-restore-authoritative-swap', 2],
  ['after-restore-current-head', 2],
  ['after-restore-current-head', 2],
] as const satisfies ReadonlyArray<readonly [StoragePersistenceBoundary, number]>;

const cleanup = (runtimeId: string): void => {
  const namespace = join(dbRootPath, runtimeId);
  for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-events', '-infra']) {
    rmSync(`${namespace}${suffix}`, { recursive: true, force: true });
  }
};

afterEach(() => {
  while (namespaces.length > 0) cleanup(namespaces.pop()!);
});

describe('restored checkpoint atomic publication', () => {
  for (const [boundary, expectedHeight] of boundaries) {
    test(`keeps a complete authoritative base after SIGKILL ${boundary}`, async () => {
      mkdirSync(dbRootPath, { recursive: true });
      const seed = `restore import crash ${process.pid} ${boundary} deterministic seed`;
      const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
      namespaces.push(runtimeId);
      cleanup(runtimeId);
      const child = Bun.spawn({
        cmd: [process.execPath, fixture, seed, boundary],
        cwd: join(import.meta.dir, '..', '..', '..', '..'),
        env: { ...process.env, XLN_DB_PATH: dbRootPath },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await child.exited;
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(exitCode, `${stdout}\n${stderr}`).toBe(137);
      expect(child.signalCode, `${stdout}\n${stderr}`).toBe('SIGKILL');

      const restored = await loadEnvFromDB(runtimeId, seed);
      if (!restored) throw new Error('restore import crash fixture lost the authoritative base');
      try {
        expect(restored.state.height).toBe(expectedHeight);
        expect(restored.state.timestamp).toBe(expectedHeight * 1_000);
        const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
        const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
        const replica = Array.from(restored.state.eReplicas.values()).find((candidate) => (
          candidate.entityId === entityId && candidate.signerId === signerId
        ));
        expect(replica?.lastConsensusProgressAt).toBe(expectedHeight * 1_000);
        const oversizedAccount = replica?.state.accounts.get(`0x${'ff'.repeat(32)}`);
        expect(oversizedAccount?.state.deltas.size).toBe(LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
        expect(oversizedAccount?.state.deltas.get(1)?.offdelta).toBe(1n);
        expect(oversizedAccount?.state.deltas.get(LIMITS.MAX_ACCOUNT_TOKEN_ROWS)?.offdelta)
          .toBe(BigInt(LIMITS.MAX_ACCOUNT_TOKEN_ROWS));
        const historyHead = await readStorageHead(getRuntimeWalDb(restored));
        expect(historyHead?.latestHeight).toBe(expectedHeight);
        await recoverStorageDbFromWal({
          db: getRuntimeStorageDb(restored),
          walDb: getRuntimeWalDb(restored),
          config: {
            enabled: true,
            snapshotPeriodFrames: historyHead!.snapshotPeriodFrames,
            retainSnapshots: historyHead!.retainSnapshots,
            epochMaxBytes: historyHead!.epochMaxBytes,
            materializePeriodFrames: 64,
            canonicalHashPeriodFrames: 1,
            accountMerkleRadix: historyHead!.accountMerkleRadix,
          },
        });
        expect(await readStorageHead(getRuntimeStorageDb(restored))).toEqual(historyHead);
      } finally {
        await closeRuntimeDb(restored);
        await closeInfraDb(restored);
      }
    }, 30_000);
  }
});
