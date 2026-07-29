import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  loadEnvFromDB,
  processRuntime,
  readPersistedAccountFrameHistory,
} from '../runtime.ts';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import { createJAdapter } from '../jadapter';
import type { JReplica, JurisdictionConfig } from '../types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

function describeAccounts(env: Awaited<ReturnType<typeof createEmptyEnv>>) {
  return Array.from(env.eReplicas.entries()).flatMap(([replicaKey, replica]) =>
    Array.from(replica.state.accounts.entries()).map(([counterpartyId, account]) => ({
      replicaKey,
      counterpartyId,
      currentHeight: Number(account.currentHeight ?? 0),
      pendingHeight: Number(account.pendingFrame?.height ?? 0),
      currentHash: String(account.currentFrame?.stateHash ?? ''),
      pendingHash: String(account.pendingFrame?.stateHash ?? ''),
    })),
  );
}

async function main() {
  const seed = 'persistence-simultaneous-proposal-smoke';
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const dbRoot = process.env['XLN_DB_PATH'] || 'db-tmp/runtime';
  const namespacePath = join(dbRoot, runtimeId);

  rmSync(namespacePath, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
  rmSync(`${namespacePath}-wal`, { recursive: true, force: true });
  rmSync(`${namespacePath}-events`, { recursive: true, force: true });
  rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
  mkdirSync(dbRoot, { recursive: true });

  const env = createEmptyEnv(seed);
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.runtimeConfig = { ...(env.runtimeConfig || {}), snapshotIntervalFrames: 1000 };
  env.quietRuntimeLogs = true;
  env.scenarioMode = true;
  env.timestamp = 1000;

  // The collision proof is Account-only, but every Entity replica still binds
  // to an explicit jurisdiction domain. This deterministic real domain fixture
  // keeps the harness on production admission without starting an EVM or
  // weakening the mandatory jurisdiction invariant.
  const chainId = 31337;
  const adapter = await createJAdapter({ mode: 'browservm', chainId });
  const contracts = { ...adapter.addresses };
  await adapter.close();
  const jurisdiction: JurisdictionConfig = {
    name: 'collision-smoke',
    address: 'browservm://collision-smoke',
    chainId,
    depositoryAddress: contracts.depository,
    entityProviderAddress: contracts.entityProvider,
  };
  env.activeJurisdiction = jurisdiction.name;
  env.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    rpcs: [jurisdiction.address],
    chainId,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    position: { x: 0, y: 0, z: 0 },
    contracts,
  } as JReplica);

  const signerA = deriveSignerAddressSync(seed, '1');
  const signerB = deriveSignerAddressSync(seed, '2');
  const signerAKey = deriveSignerKeySync(seed, '1');
  const signerBKey = deriveSignerKeySync(seed, '2');

  registerSignerKey(env, signerA, signerAKey);
  registerSignerKey(env, signerB, signerBKey);

  const entityA = generateLazyEntityId([signerA], 1n).toLowerCase();
  const entityB = generateLazyEntityId([signerB], 1n).toLowerCase();

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

  // Build one bilateral account first, then force repeated same-height races by
  // submitting opposite direct payments in the same runtime frame.
  enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: [
      {
        entityId: entityA,
        signerId: signerA,
        entityTxs: [
          {
            type: 'openAccount',
            data: { targetEntityId: entityB, creditAmount: 1000n, tokenId: 1 },
          },
        ],
      },
    ],
  });
  await processRuntime(env, []);
  for (let i = 0; i < 10; i++) await processRuntime(env, []);

  for (let round = 0; round < 6; round++) {
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [
        {
          entityId: entityA,
          signerId: signerA,
          entityTxs: [
            {
              type: 'directPayment',
              data: {
                targetEntityId: entityB,
                tokenId: 1,
                amount: 1n,
                route: [entityA, entityB],
                description: `A->B #${round}`,
              },
            },
          ],
        },
        {
          entityId: entityB,
          signerId: signerB,
          entityTxs: [
            {
              type: 'directPayment',
              data: {
                targetEntityId: entityA,
                tokenId: 1,
                amount: 1n,
                route: [entityB, entityA],
                description: `B->A #${round}`,
              },
            },
          ],
        },
      ],
    });
    await processRuntime(env, []);
    for (let i = 0; i < 6; i++) await processRuntime(env, []);
  }

  const before = describeAccounts(env);
  await closeRuntimeDb(env);
  await closeInfraDb(env);

  const restored = await loadEnvFromDB(runtimeId, seed);
  assert(restored, 'restored env from db');
  const after = describeAccounts(restored);

  assert(restored.height === env.height, `runtime height preserved (${restored.height} === ${env.height})`);
  assert(after.length === before.length, `account count preserved (${after.length} === ${before.length})`);

  for (const baseline of before) {
    const restoredAccount = after.find(
      candidate => candidate.replicaKey === baseline.replicaKey && candidate.counterpartyId === baseline.counterpartyId,
    );
    assert(restoredAccount, `restored account exists for ${baseline.replicaKey} -> ${baseline.counterpartyId}`);
    assert(
      restoredAccount.currentHeight === baseline.currentHeight,
      `currentHeight preserved for ${baseline.replicaKey} -> ${baseline.counterpartyId} (${restoredAccount.currentHeight} === ${baseline.currentHeight})`,
    );
    assert(
      restoredAccount.pendingHeight === baseline.pendingHeight,
      `pendingHeight preserved for ${baseline.replicaKey} -> ${baseline.counterpartyId} (${restoredAccount.pendingHeight} === ${baseline.pendingHeight})`,
    );
    assert(
      restoredAccount.currentHash === baseline.currentHash,
      `currentHash preserved for ${baseline.replicaKey} -> ${baseline.counterpartyId}`,
    );
    assert(
      restoredAccount.pendingHash === baseline.pendingHash,
      `pendingHash preserved for ${baseline.replicaKey} -> ${baseline.counterpartyId}`,
    );
  }

  // Account consensus returns committed frames upward; only Runtime WAL/view
  // infrastructure persists them. Verify both local replicas materialized the
  // complete certified chain after reload without any Account-layer DB write.
  for (const account of after) {
    const [entityId] = account.replicaKey.split(':');
    assert(entityId, `entityId missing from replica key ${account.replicaKey}`);
    const history = await readPersistedAccountFrameHistory(
      restored,
      entityId,
      account.counterpartyId,
      100,
    );
    assert(
      history.at(-1)?.height === account.currentHeight,
      `persisted account history reaches H=${account.currentHeight} for ${account.replicaKey}`,
    );
  }

  console.log('✅ persistence-simultaneous-proposal-smoke passed');
  console.log(
    JSON.stringify(
      {
        runtimeId,
        heightBeforeReload: env.height,
        heightAfterReload: restored.height,
        accounts: after.map(account => ({
          replicaKey: account.replicaKey,
          counterpartyId: account.counterpartyId,
          currentHeight: account.currentHeight,
          pendingHeight: account.pendingHeight,
        })),
      },
      null,
      2,
    ),
  );
  await closeRuntimeDb(restored);
  await closeInfraDb(restored);
}

main().catch(error => {
  console.error('❌ persistence-simultaneous-proposal-smoke failed:', error);
  process.exit(1);
});
