import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  createEmptyEnv,
  enqueueRuntimeInput,
  process as processRuntime,
  loadEnvFromDB,
  closeRuntimeDb,
} from '../runtime';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { generateLazyEntityId } from '../entity-factory';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

async function main() {
  const seed = 'persistence-jbatch-history-smoke-seed';
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

  const signerId = deriveSignerAddressSync(seed, '1');
  const signerKey = deriveSignerKeySync(seed, '1');
  registerSignerKey(signerId, signerKey);
  registerSignerKey(signerId.slice(-4).toLowerCase(), signerKey);

  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const otherEntityId = generateLazyEntityId(['0x0000000000000000000000000000000000000001'], 1n).toLowerCase();

  enqueueRuntimeInput(env, {
    runtimeTxs: [
      {
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [signerId],
            shares: { [signerId]: 1n },
            jurisdiction: {
              address: '0x' + '1'.repeat(40),
              name: 'default',
              entityProviderAddress: '0x' + '2'.repeat(40),
              depositoryAddress: '0x' + '3'.repeat(40),
              chainId: 31337,
            },
          },
        },
      },
    ],
    entityInputs: [],
  });
  await processRuntime(env, []);

  await processRuntime(env, [{
    entityId,
    signerId,
    entityTxs: [{
      type: 'j_event',
      data: {
        from: signerId,
        observedAt: env.timestamp + 1,
        blockNumber: 1,
        blockHash: '0x' + '4'.repeat(64),
        transactionHash: '0x' + '5'.repeat(64),
        event: {
          type: 'ReserveUpdated',
          data: {
            entity: entityId,
            tokenId: 1,
            newBalance: 1000n * 10n ** 18n,
          },
        },
      },
    }],
  }]);

  for (let nonce = 1; nonce <= 3; nonce++) {
    await processRuntime(env, [{
      entityId,
      signerId,
      entityTxs: [{
        type: 'reserve_to_reserve',
        data: {
          toEntityId: otherEntityId,
          tokenId: 1,
          amount: 1n * 10n ** 18n,
        },
      }],
    }]);

    await processRuntime(env, [{
      entityId,
      signerId,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    }]);

    await processRuntime(env, [{
      entityId,
      signerId,
      entityTxs: [{
        type: 'j_event',
        data: {
          from: signerId,
          observedAt: env.timestamp + 1,
          blockNumber: nonce + 1,
          blockHash: `0x${String(nonce).padStart(64, '0')}`,
          transactionHash: `0x${String(nonce + 100).padStart(64, '0')}`,
          events: [
            {
              type: 'ReserveUpdated',
              data: {
                entity: entityId,
                tokenId: 1,
                newBalance: (1000n - BigInt(nonce)) * 10n ** 18n,
              },
            },
            {
              type: 'HankoBatchProcessed',
              data: {
                entityId,
                hankoHash: `0x${String(nonce + 200).padStart(64, '0')}`,
                nonce,
                success: true,
              },
            },
          ],
        },
      }],
    }]);
  }

  const replica = Array.from(env.eReplicas.values()).find((candidate) => candidate.entityId === entityId);
  assert(replica, 'replica exists before reload');
  const batchHistoryBefore = replica.state.batchHistory || [];
  assert(batchHistoryBefore.length === 3, `expected 3 batchHistory entries before reload, got ${batchHistoryBefore.length}`);

  await closeRuntimeDb(env);

  const restored = await loadEnvFromDB(runtimeId, seed);
  assert(restored, 'restored env exists');
  const restoredReplica = Array.from(restored.eReplicas.values()).find((candidate) => candidate.entityId === entityId);
  assert(restoredReplica, 'replica exists after reload');
  const batchHistoryAfter = restoredReplica.state.batchHistory || [];
  assert(batchHistoryAfter.length === 3, `expected 3 batchHistory entries after reload, got ${batchHistoryAfter.length}`);
  assert(
    batchHistoryAfter.every((entry) => entry?.status === 'confirmed'),
    `expected confirmed batchHistory entries after reload, got ${JSON.stringify(batchHistoryAfter.map((entry) => entry?.status))}`,
  );

  console.log('✅ persistence-jbatch-history-smoke passed');
  console.log(JSON.stringify({
    runtimeId,
    heightBeforeReload: env.height,
    heightAfterReload: restored.height,
    batchHistoryBefore: batchHistoryBefore.length,
    batchHistoryAfter: batchHistoryAfter.length,
  }, null, 2));
}

main().catch((error) => {
  console.error('❌ persistence-jbatch-history-smoke failed:', error);
  process.exit(1);
});
