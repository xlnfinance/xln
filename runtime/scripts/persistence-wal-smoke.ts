import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  createEmptyEnv,
  enqueueRuntimeInput,
  process as processRuntime,
  loadEnvFromDB,
  getRuntimeDb,
  tryOpenDb,
  closeRuntimeDb,
} from '../runtime';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

async function main() {
  const seed = 'persist-cli-seed alpha beta gamma delta epsilon zeta';
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
  const namespacePath = join(dbRoot, runtimeId);

  rmSync(namespacePath, { recursive: true, force: true });
  mkdirSync(dbRoot, { recursive: true });

  const env = createEmptyEnv(seed);
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.runtimeConfig = { ...(env.runtimeConfig || {}), snapshotIntervalFrames: 1000 };
  env.quietRuntimeLogs = true;

  const signer1 = deriveSignerAddressSync(seed, '1');
  registerSignerKey(signer1, deriveSignerKeySync(seed, '1'));
  registerSignerKey(signer1.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '1'));
  const signer2 = deriveSignerAddressSync(seed, '2');
  registerSignerKey(signer2, deriveSignerKeySync(seed, '2'));

  const entityA = '0x' + 'a'.repeat(64);
  const entityB = '0x' + 'b'.repeat(64);

  enqueueRuntimeInput(env, {
    runtimeTxs: [
      {
        type: 'importReplica',
        entityId: entityA,
        signerId: signer1,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [signer1],
            shares: { [signer1]: 1n },
          },
        },
      },
      {
        type: 'importReplica',
        entityId: entityB,
        signerId: signer2,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [signer2],
            shares: { [signer2]: 1n },
          },
        },
      },
    ],
    entityInputs: [],
  });
  await processRuntime(env, []);

  // Generate WAL frames on top of a checkpoint using no-op entity inputs.
  // This isolates snapshot+WAL replay correctness from account-consensus signing paths.
  for (let i = 0; i < 12; i++) {
    await processRuntime(env, [
      {
        entityId: entityA,
        signerId: signer1,
        entityTxs: [],
      },
    ]);
  }

  assert(env.eReplicas.size === 2, `expected 2 replicas before reload, got ${env.eReplicas.size}`);
  assert(env.height > 2, `runtime advanced beyond checkpoint frame (height=${env.height})`);

  const opened = await tryOpenDb(env);
  assert(opened, 'db opened');
  const db = getRuntimeDb(env);
  const latestHeight = Number((await db.get(Buffer.from(`${runtimeId}:latest_height`))).toString());
  const checkpointHeight = Number((await db.get(Buffer.from(`${runtimeId}:latest_checkpoint_height`))).toString());
  assert(checkpointHeight < latestHeight, `WAL replay path active (checkpoint=${checkpointHeight}, latest=${latestHeight})`);

  // Simulate real restart boundary: close current DB handle before loading anew.
  await closeRuntimeDb(env);

  const restored = await loadEnvFromDB(runtimeId, seed);
  assert(restored, 'restored env from db');
  assert(restored.eReplicas.size === 2, `expected 2 replicas after reload, got ${restored.eReplicas.size}`);
  const replicaA = [...restored.eReplicas.keys()].find((k) => String(k).startsWith(`${entityA}:`));
  const replicaB = [...restored.eReplicas.keys()].find((k) => String(k).startsWith(`${entityB}:`));
  assert(!!replicaA, 'replica A present after reload');
  assert(!!replicaB, 'replica B present after reload');
  assert(restored.height === env.height, `runtime height preserved (${restored.height} == ${env.height})`);

  console.log('✅ persistence-wal-smoke passed');
  console.log(JSON.stringify({
    runtimeId,
    latestHeight,
    checkpointHeight,
    envHeight: env.height,
    restoredHeight: restored.height,
    replicasBefore: env.eReplicas.size,
    replicasAfter: restored.eReplicas.size,
  }, null, 2));
}

main().catch((err) => {
  console.error('❌ persistence-wal-smoke failed:', err);
  process.exit(1);
});
