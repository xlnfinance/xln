import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import {
  closeInfraDb,
  closeRuntimeDb,
  getFrameDb,
  getRuntimeStorageDb,
  loadEnvFromDB,
} from '../runtime';
import { deriveSignerAddressSync } from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import { dbRootPath } from '../machine/platform';
import { readStorageHead, recoverStorageDbFromHistory } from '../storage';
import type { StoragePersistenceBoundary } from '../storage/types';
import {
  createConsumptionProof,
  getConsumptionKey,
  verifyConsumptionProof,
} from '../entity/consumption-accumulator';
import { getConsumptionNodeStore } from '../entity/consumption-store';

const fixture = join(import.meta.dir, 'fixtures/storage-restore-import-crash-child.ts');
const namespaces: string[] = [];
const boundaries = [
  ['after-restore-current-fence', 1],
  ['after-restore-current-clear-batch', 1],
  ['after-restore-current-body', 1],
  ['after-restore-authoritative-swap', 2],
  ['after-restore-current-head', 2],
] as const satisfies ReadonlyArray<readonly [StoragePersistenceBoundary, number]>;

const cleanup = (runtimeId: string): void => {
  const namespace = join(dbRootPath, runtimeId);
  for (const suffix of ['', '-storage-current', '-storage-previous', '-frames', '-events', '-infra']) {
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
        cwd: join(import.meta.dir, '..', '..'),
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
        expect(restored.height).toBe(expectedHeight);
        expect(restored.timestamp).toBe(expectedHeight * 1_000);
        const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
        const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
        const replica = Array.from(restored.eReplicas.values()).find((candidate) => (
          candidate.entityId === entityId && candidate.signerId === signerId
        ));
        expect(replica?.lastConsensusProgressAt).toBe(expectedHeight * 1_000);
        expect(replica?.state.consumptionAccumulator?.count).toBe(1n);
        const firstIdentity = {
          targetEntityId: entityId,
          sourceEntityId: `0x${'22'.repeat(32)}`,
          lane: 'generic' as const,
        };
        const accumulator = replica?.state.consumptionAccumulator;
        if (!accumulator) throw new Error('restore import consumption accumulator missing');
        const proof = createConsumptionProof(
          getConsumptionNodeStore(restored),
          accumulator.root,
          getConsumptionKey(firstIdentity),
        );
        expect(verifyConsumptionProof(accumulator.root, getConsumptionKey(firstIdentity), proof)).toEqual({
          status: 'member',
          value: expect.objectContaining({
            lastContiguousSeq: BigInt(expectedHeight),
            count: BigInt(expectedHeight),
          }),
        });
        const historyHead = await readStorageHead(getFrameDb(restored));
        expect(historyHead?.latestHeight).toBe(expectedHeight);
        await recoverStorageDbFromHistory({
          db: getRuntimeStorageDb(restored),
          historyDb: getFrameDb(restored),
          config: {
            enabled: true,
            snapshotPeriodFrames: historyHead!.snapshotPeriodFrames,
            retainSnapshots: historyHead!.retainSnapshots,
            epochMaxBytes: historyHead!.epochMaxBytes,
            frameDbMaxBytes: 1_073_741_824,
            frameDbRetainFrames: 100_000,
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
