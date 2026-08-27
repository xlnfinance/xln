import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getRuntimeWalDb,
  loadEnvFromDB,
  processRuntime,
} from '../../../runtime.ts';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import { createTestJReplica } from '../../helpers/j-replica';
import { readStorageFrameRecord } from '../../../storage';
import { buildStorageLiveReplicaMetaCommitment } from '../../../storage/replica/replicas';
import type { RuntimeReplica } from '../../../runtime/types';

const cleanupRuntimeStorage = (dbRoot: string, runtimeId: string): void => {
  const namespacePath = join(dbRoot, runtimeId);
  rmSync(namespacePath, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
  rmSync(`${namespacePath}-wal`, { recursive: true, force: true });
  rmSync(`${namespacePath}-history-views`, { recursive: true, force: true });
  rmSync(`${namespacePath}-events`, { recursive: true, force: true });
  rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
};

const committedAccountCount = (env: RuntimeReplica, entityId: string): number => {
  const replica = [...env.state.eReplicas.values()].find(candidate =>
    candidate.entityId === entityId,
  );
  if (!replica) return 0;
  let count = 0;
  for (const account of replica.state.accounts.values()) {
    if (account.pendingFrame || account.pendingAccountInput) continue;
    if (account.currentHeight > 0) count += 1;
  }
  return count;
};

describe('live-head restore after advertised account opens', () => {
  test('replays three pinned hub accounts without replica-meta digest drift', async () => {
    const seed = `live-head-3hub ${process.pid} alpha beta gamma`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
    cleanupRuntimeStorage(dbRoot, runtimeId);
    mkdirSync(dbRoot, { recursive: true });

    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.quietRuntimeLogs = true;
    env.state.timestamp = 1_000;
    env.runtimeConfig = {
      ...(env.runtimeConfig || {}),
      storage: {
        ...env.runtimeConfig?.storage,
        snapshotPeriodFrames: 10_000,
        materializePeriodFrames: 10_000,
      },
    };

    const signers = [1, 2, 3, 4].map(index => {
      const signerId = deriveSignerAddressSync(seed, String(index));
      registerSignerKey(env, signerId, deriveSignerKeySync(seed, String(index)));
      return {
        signerId,
        entityId: generateLazyEntityId([signerId], 1n).toLowerCase(),
      };
    });
    const user = signers[0]!;
    const hubs = signers.slice(1);
    const jurisdiction = {
      name: 'live-head-3hub-test',
      address: 'browservm://live-head-3hub-test',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };
    env.activeJurisdiction = jurisdiction.name;
    env.state.jReplicas.set(jurisdiction.name, createTestJReplica({
      name: jurisdiction.name,
      chainId: jurisdiction.chainId,
      contracts: {
        depository: jurisdiction.depositoryAddress,
        entityProvider: jurisdiction.entityProviderAddress,
        account: '0x000000000000000000000000000000000000ac01',
        deltaTransformer: '0x000000000000000000000000000000000000de17',
      },
    }));

    enqueueRuntimeInput(env, {
      timestamp: env.state.timestamp,
      runtimeTxs: signers.map(({ entityId, signerId }) =>
        createTestEntityImportRuntimeTx(env, {
          entityId,
          signerId,
          data: {
            isProposer: true,
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerId],
              shares: { [signerId]: 1n },
              jurisdiction,
            },
          },
        }),
      ),
      entityInputs: [],
    });
    await processRuntime(env, []);

    enqueueRuntimeInput(env, {
      timestamp: env.state.timestamp,
      runtimeTxs: [],
      entityInputs: hubs.map(hub => ({
        entityId: user.entityId,
        signerId: user.signerId,
        entityTxs: [{
          type: 'openAccount',
          data: {
            targetEntityId: hub.entityId,
            creditAmount: 1000n,
            tokenId: 1,
            disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
          },
        }],
      })),
    });

    for (let i = 0; i < 24; i += 1) {
      await processRuntime(env, []);
      if (committedAccountCount(env, user.entityId) === 3) break;
    }
    expect(committedAccountCount(env, user.entityId)).toBe(3);
    expect(env.state.height).toBeGreaterThan(1);

    const persistFrame = await readStorageFrameRecord(getRuntimeWalDb(env), env.state.height);
    expect(persistFrame?.materializedState).toBe(false);
    const persistMeta = buildStorageLiveReplicaMetaCommitment(env);
    expect(persistMeta.digest).toBe(persistFrame?.replicaMetaDigest);

    const persistHeight = env.state.height;
    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const restored = await loadEnvFromDB(runtimeId, seed);
    try {
      expect(restored).toBeTruthy();
      expect(restored?.state.height).toBe(persistHeight);
      expect(committedAccountCount(restored!, user.entityId)).toBe(3);
      expect(buildStorageLiveReplicaMetaCommitment(restored!).digest).toBe(persistMeta.digest);
    } finally {
      if (restored) {
        await closeRuntimeDb(restored);
        await closeInfraDb(restored);
      }
    }
  });
});
