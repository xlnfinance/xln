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
  const seed = 'bilateral-replay-test alpha beta gamma delta epsilon zeta';
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
  const namespacePath = join(dbRoot, runtimeId);

  rmSync(namespacePath, { recursive: true, force: true });
  mkdirSync(dbRoot, { recursive: true });

  const env = createEmptyEnv(seed);
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.scenarioMode = true;
  env.timestamp = 1000;
  env.quietRuntimeLogs = true;

  const signer1 = deriveSignerAddressSync(seed, '1');
  registerSignerKey(signer1, deriveSignerKeySync(seed, '1'));
  registerSignerKey(signer1.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '1'));
  const signer2 = deriveSignerAddressSync(seed, '2');
  registerSignerKey(signer2, deriveSignerKeySync(seed, '2'));
  registerSignerKey(signer2.slice(-4).toLowerCase(), deriveSignerKeySync(seed, '2'));

  const entityA = '0x' + 'a'.repeat(64);
  const entityB = '0x' + 'b'.repeat(64);

  // Frame 1: Import replicas
  enqueueRuntimeInput(env, {
    runtimeTxs: [
      {
        type: 'importReplica', entityId: entityA, signerId: signer1,
        data: { isProposer: true, config: { mode: 'proposer-based', threshold: 1n, validators: [signer1], shares: { [signer1]: 1n } } },
      },
      {
        type: 'importReplica', entityId: entityB, signerId: signer2,
        data: { isProposer: true, config: { mode: 'proposer-based', threshold: 1n, validators: [signer2], shares: { [signer2]: 1n } } },
      },
    ],
    entityInputs: [],
  });
  await processRuntime(env, []);
  console.log(`Frame 1: height=${env.height}`);

  // Frame 2: openAccount A→B
  enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: [{
      entityId: entityA, signerId: signer1,
      entityTxs: [{ type: 'openAccount', data: { targetEntityId: entityB, creditAmount: 1000n, tokenId: 1 } }],
    }],
  });
  await processRuntime(env, []);
  console.log(`Frame 2 (openAccount): height=${env.height}`);

  // Run frames to let bilateral settle
  for (let i = 0; i < 8; i++) {
    enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{ entityId: entityA, signerId: signer1, entityTxs: [] }] });
    await processRuntime(env, []);
  }
  console.log(`After settling: height=${env.height}`);

  // Capture before-reload state
  const beforeHashes: Record<string, string> = {};
  for (const [key, replica] of env.eReplicas.entries()) {
    for (const [cpId, acc] of (replica.state.accounts || new Map()).entries()) {
      beforeHashes[`${key.slice(0,12)}→${cpId.slice(0,12)}`] = `h=${acc.currentHeight} hash=${(acc.currentFrame?.stateHash || 'none').slice(0, 24)}`;
    }
  }
  console.log('\n=== BEFORE RELOAD ===');
  for (const [k, v] of Object.entries(beforeHashes)) console.log(`  ${k}: ${v}`);

  // Reload
  const opened = await tryOpenDb(env);
  assert(opened, 'db opened');
  const db = getRuntimeDb(env);
  const latestH = Number((await db.get(Buffer.from(`${runtimeId}:latest_height`))).toString());
  const checkpointH = Number((await db.get(Buffer.from(`${runtimeId}:latest_checkpoint_height`))).toString());
  console.log(`\nDB: latest=${latestH} checkpoint=${checkpointH} (replay=${latestH - checkpointH} frames)`);
  await closeRuntimeDb(env);

  const restored = await loadEnvFromDB(runtimeId, seed);
  assert(restored, 'restored env from db');
  assert(restored.height === env.height, `height mismatch: ${restored.height} !== ${env.height}`);

  const afterHashes: Record<string, string> = {};
  for (const [key, replica] of restored.eReplicas.entries()) {
    for (const [cpId, acc] of (replica.state.accounts || new Map()).entries()) {
      afterHashes[`${key.slice(0,12)}→${cpId.slice(0,12)}`] = `h=${acc.currentHeight} hash=${(acc.currentFrame?.stateHash || 'none').slice(0, 24)}`;
    }
  }
  console.log('\n=== AFTER RELOAD ===');
  for (const [k, v] of Object.entries(afterHashes)) console.log(`  ${k}: ${v}`);

  let mismatches = 0;
  for (const key of Object.keys(beforeHashes)) {
    if (beforeHashes[key] !== afterHashes[key]) {
      console.log(`\n❌ MISMATCH: ${key}`);
      console.log(`   before: ${beforeHashes[key]}`);
      console.log(`   after:  ${afterHashes[key]}`);
      mismatches++;
    }
  }
  if (mismatches === 0) {
    console.log('\n✅ bilateral-replay: all stateHashes match after reload');
  } else {
    console.log(`\n❌ bilateral-replay FAILED: ${mismatches} mismatches`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ bilateral-replay FAILED:', err.message);
  process.exit(1);
});
