import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  closeInfraDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  process as processRuntime,
  loadEnvFromDB,
  closeRuntimeDb,
} from '../runtime.ts';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import {
  canonicalJurisdictionEventsHash,
  getJEventJurisdictionRef,
} from '../jurisdiction/event-observation';
import { buildJEventRangeDigest } from '../jurisdiction/history-consensus';
import { buildUnsignedJEventRange, recordValidatorJHistory } from '../jurisdiction/local-history';
import type { JurisdictionEvent, RuntimeTx } from '../types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

async function main() {
  const seed = 'persistence-jbatch-history-smoke-seed';
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const dbRoot = process.env['XLN_DB_PATH'] || 'db-tmp/runtime';
  const namespacePath = join(dbRoot, runtimeId);

  rmSync(namespacePath, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
  rmSync(`${namespacePath}-frames`, { recursive: true, force: true });
  rmSync(`${namespacePath}-events`, { recursive: true, force: true });
  rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
  mkdirSync(dbRoot, { recursive: true });

  const env = createEmptyEnv(seed);
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.runtimeConfig = { ...(env.runtimeConfig || {}), snapshotIntervalFrames: 1000 };
  env.quietRuntimeLogs = true;
  env.activeJurisdiction = 'default';

  const signerId = deriveSignerAddressSync(seed, '1');
  const signerKey = deriveSignerKeySync(seed, '1');
  registerSignerKey(env, signerId, signerKey);

  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const otherEntityId = generateLazyEntityId(['0x0000000000000000000000000000000000000001'], 1n).toLowerCase();
  const jurisdiction = {
    address: '0x' + '1'.repeat(40),
    name: 'default',
    entityProviderAddress: '0x' + '2'.repeat(40),
    depositoryAddress: '0x' + '3'.repeat(40),
    chainId: 31337,
  };
  const applySignedJEvent = async (
    events: JurisdictionEvent[],
    blockNumber: number,
    blockHash: string,
  ): Promise<void> => {
    if (events.length === 0) throw new Error('J_EVENT_EMPTY');
    const replica = Array.from(env.eReplicas.values()).find((candidate) => candidate.entityId === entityId);
    if (!replica) throw new Error('J_EVENT_REPLICA_MISSING');
    const jurisdictionRef = getJEventJurisdictionRef(jurisdiction);
    const eventsHash = canonicalJurisdictionEventsHash(events);
    const observeTx: Extract<RuntimeTx, { type: 'observeJRange' }> = {
      type: 'observeJRange',
      data: {
        entityId,
        signerId,
        jurisdictionRef,
        scannedThroughHeight: blockNumber,
        tipBlockHash: blockHash,
        blocks: [{ jurisdictionRef, jHeight: blockNumber, jBlockHash: blockHash, eventsHash, events }],
      },
    };
    const history = recordValidatorJHistory(replica.jHistory, observeTx.data, replica.state);
    const unsigned = buildUnsignedJEventRange(replica.state, history);
    if (!unsigned) throw new Error('J_EVENT_RANGE_EMPTY');
    const signature = signAccountFrame(env, signerId, buildJEventRangeDigest({ entityId, signerId, ...unsigned }));
    enqueueRuntimeInput(env, {
      runtimeTxs: [observeTx],
      entityInputs: [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'j_event',
          data: { from: signerId, observedAt: blockNumber, signature, ...unsigned },
        }],
      }],
    });
    await processRuntime(env, []);
  };
  env.jReplicas.set('default', {
    name: 'default',
    depositoryAddress: '0x' + '3'.repeat(40),
    entityProviderAddress: '0x' + '2'.repeat(40),
    chainId: 31337,
    jadapter: {
      submitTx: async () => ({
        success: true,
        txHash: `0x${'a'.repeat(64)}`,
        events: [],
      }),
      startWatching: () => {},
      isWatching: () => false,
      stopWatching: () => {},
      getBrowserVM: () => null,
      setBlockTimestamp: () => {},
      close: async () => {},
    },
    contracts: {
      depository: '0x' + '3'.repeat(40),
      entityProvider: '0x' + '2'.repeat(40),
    },
  } as never);

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
            jurisdiction,
          },
        },
      },
    ],
    entityInputs: [],
  });
  await processRuntime(env, []);

  await applySignedJEvent([{
          type: 'ReserveUpdated',
          data: {
            entity: entityId,
            tokenId: 1,
            newBalance: (1000n * 10n ** 18n).toString(),
          },
        }], 1, '0x' + '4'.repeat(64));

  for (let nonce = 1; nonce <= 3; nonce++) {
    await processRuntime(env, [{
      entityId,
      signerId,
      entityTxs: [{
        type: 'r2r',
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
    const broadcastReplica = Array.from(env.eReplicas.values()).find((candidate) => candidate.entityId === entityId);
    const sentBatch = broadcastReplica?.state.jBatchState?.sentBatch;
    assert(sentBatch, `sent batch exists for nonce ${nonce}`);

    const reserveUpdatedEvent = {
      type: 'ReserveUpdated' as const,
      data: {
        entity: entityId,
        tokenId: 1,
        newBalance: ((1000n - BigInt(nonce)) * 10n ** 18n).toString(),
      },
    };
    await applySignedJEvent([
            reserveUpdatedEvent,
            {
              type: 'HankoBatchProcessed',
              data: {
                entityId,
                batchHash: sentBatch.batchHash,
                nonce,
              },
            },
          ], nonce + 1, `0x${String(nonce).padStart(64, '0')}`);
  }

  const replica = Array.from(env.eReplicas.values()).find((candidate) => candidate.entityId === entityId);
  assert(replica, 'replica exists before reload');
  const batchHistoryBefore = replica.state.batchHistory || [];
  assert(batchHistoryBefore.length === 3, `expected 3 batchHistory entries before reload, got ${batchHistoryBefore.length}`);

  await closeRuntimeDb(env);
  await closeInfraDb(env);

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
  await closeRuntimeDb(restored);
  await closeInfraDb(restored);
}

main().catch((error) => {
  console.error('❌ persistence-jbatch-history-smoke failed:', error);
  process.exit(1);
});
