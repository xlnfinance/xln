import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getRuntimeDb,
  loadEnvFromDB,
  process as processRuntime,
  tryOpenDb,
  verifyRuntimeChain,
} from '../runtime.ts';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { generateLazyEntityId } from '../entity-factory';
import type { Env } from '../types';

function hasPendingBilateralState(env: Env): boolean {
  for (const replica of env.eReplicas.values()) {
    for (const account of replica.state?.accounts?.values() || []) {
      if (account.pendingFrame || account.pendingAccountInput) {
        return true;
      }
    }
  }
  return false;
}

describe('checkpoint persistence with pending bilateral state', () => {
  test('persists and restores checkpoint while an account pendingFrame exists', async () => {
    const seed = `checkpoint-pending ${Date.now()} alpha beta gamma`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
    const namespacePath = join(dbRoot, runtimeId);

    rmSync(namespacePath, { recursive: true, force: true });
    mkdirSync(dbRoot, { recursive: true });

    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.runtimeConfig = { ...(env.runtimeConfig || {}), snapshotIntervalFrames: 1 };
    env.quietRuntimeLogs = true;

    const signerA = deriveSignerAddressSync(seed, '1');
    const signerB = deriveSignerAddressSync(seed, '2');
    registerSignerKey(signerA, deriveSignerKeySync(seed, '1'));
    registerSignerKey(signerA.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '1'));
    registerSignerKey(signerB, deriveSignerKeySync(seed, '2'));
    registerSignerKey(signerB.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '2'));

    const entityA = generateLazyEntityId([signerA], 1n).toLowerCase();
    const entityB = generateLazyEntityId([signerB], 1n).toLowerCase();
    const jurisdiction = {
      name: 'checkpoint-pending-test',
      depositoryAddress: '0x000000000000000000000000000000000000dEaD',
      entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
      chainId: 31337,
    };
    env.activeJurisdiction = jurisdiction.name;
    env.jReplicas.set(jurisdiction.name, {
      name: jurisdiction.name,
      depositoryAddress: jurisdiction.depositoryAddress,
      entityProviderAddress: jurisdiction.entityProviderAddress,
      chainId: jurisdiction.chainId,
      contracts: {
        depository: jurisdiction.depositoryAddress,
        entityProvider: jurisdiction.entityProviderAddress,
      },
    } as never);

    enqueueRuntimeInput(env, {
      runtimeTxs: [
        {
          type: 'importReplica',
          entityId: entityA,
          signerId: signerA,
          data: {
            isProposer: true,
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerA],
              shares: { [signerA]: 1n },
              jurisdiction,
            },
          },
        },
        {
          type: 'importReplica',
          entityId: entityB,
          signerId: signerB,
          data: {
            isProposer: true,
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerB],
              shares: { [signerB]: 1n },
              jurisdiction,
            },
          },
        },
      ],
      entityInputs: [],
    });
    await processRuntime(env, []);

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [
        {
          entityId: entityA,
          signerId: signerA,
          entityTxs: [
            {
              type: 'openAccount',
              data: {
                targetEntityId: entityB,
                creditAmount: 1000n,
                tokenId: 1,
              },
            },
          ],
        },
      ],
    });

    let pendingObserved = false;
    for (let i = 0; i < 6; i += 1) {
      await processRuntime(env, []);
      if (hasPendingBilateralState(env)) {
        pendingObserved = true;
        break;
      }
    }

    expect(pendingObserved).toBe(true);
    expect(hasPendingBilateralState(env)).toBe(true);

    const opened = await tryOpenDb(env);
    expect(opened).toBe(true);
    const db = getRuntimeDb(env);
    const checkpointHeight = Number((await db.get(Buffer.from(`${runtimeId}:latest_checkpoint_height`))).toString());
    expect(checkpointHeight).toBe(env.height);

    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const restored = await loadEnvFromDB(runtimeId, seed, { fromSnapshotHeight: checkpointHeight });
    expect(restored).toBeTruthy();
    expect(restored?.height).toBe(checkpointHeight);
    expect(hasPendingBilateralState(restored!)).toBe(true);

    await closeRuntimeDb(restored!);
    await closeInfraDb(restored!);

    const verify = await verifyRuntimeChain(runtimeId, seed, { fromSnapshotHeight: checkpointHeight });
    expect(verify.ok).toBe(true);
    expect(verify.expectedStateHash).toBe(verify.actualStateHash);
  });
});
