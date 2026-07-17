import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getFrameDb,
  process as processRuntime,
  readPersistedFrameJournal,
  readPersistedRuntimeActivityJournal,
  readPersistedRuntimeActivityPage,
  saveEnvToDB,
} from '../runtime';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import { readFrameDbRuntimeActivity } from '../storage/frame-db';
import { keyFrameDbRuntimeActivity } from '../storage/keys';
import { buildDurableRuntimeMachineSnapshot } from '../wal/snapshot';
import { readFrameReceipts } from '../server/rpc-ws';

const recipientId = `0x${'bb'.repeat(32)}`;
const hubId = `0x${'cc'.repeat(32)}`;

test('activity remains queryable after its replay frame is pruned by a snapshot', async () => {
  const seed = `activity snapshot retention ${process.pid} deterministic seed`;
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const dbRoot = process.env.XLN_DB_PATH || 'db-tmp/runtime';
  const namespacePath = `${dbRoot}/${runtimeId}`;
  for (const path of [
    namespacePath,
    `${namespacePath}-storage-current`,
    `${namespacePath}-storage-previous`,
    `${namespacePath}-frames`,
    `${namespacePath}-infra`,
  ]) rmSync(path, { recursive: true, force: true });
  mkdirSync(dbRoot, { recursive: true });

  const env = createEmptyEnv(seed);
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = {
    ...(env.runtimeConfig || {}),
    storage: {
      ...(env.runtimeConfig?.storage || {}),
      snapshotPeriodFrames: 5,
      materializePeriodFrames: 1,
    },
  };

  const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(seed, '1'));
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const jurisdiction = {
    name: 'activity-snapshot-retention',
    chainId: 31_337,
    depositoryAddress: '0x000000000000000000000000000000000000dEaD',
    entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
  };
  env.activeJurisdiction = jurisdiction.name;
  env.jReplicas.set(jurisdiction.name, {
    ...jurisdiction,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
    },
  } as never);
  enqueueRuntimeInput(env, {
    runtimeTxs: [{
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
    }],
    entityInputs: [],
  });
  await processRuntime(env, []);

  try {
    for (let height = 2; height <= 5; height += 1) {
      env.height = height;
      env.timestamp = 1_700_000_000_000 + height;
      const runtimeInput = height === 3
        ? {
            runtimeTxs: [],
            entityInputs: [{
              entityId,
              signerId,
              entityTxs: [{
                type: 'directPayment' as const,
                data: {
                  targetEntityId: recipientId,
                  tokenId: 1,
                  amount: 7n,
                  route: [entityId, hubId, recipientId],
                },
              }],
            }],
          }
        : { runtimeTxs: [], entityInputs: [] };
      env.frameLogs = height === 3
        ? [{
            id: 1,
            timestamp: env.timestamp,
            level: 'info',
            category: 'system',
            message: 'HtlcReceived',
            entityId: recipientId,
            data: {
              entityId: recipientId,
              fromEntity: hubId,
              toEntity: recipientId,
              tokenId: 1,
              amount: '7',
              hashlock: `0x${'dd'.repeat(32)}`,
            },
          }]
        : [];
      await saveEnvToDB(env, runtimeInput, [], buildDurableRuntimeMachineSnapshot(env));
    }

    expect(await readPersistedFrameJournal(env, 3)).toBeNull();
    const compactActivity = await readFrameDbRuntimeActivity(getFrameDb(env), 3);
    expect(compactActivity?.runtimeInput.entityInputs).toEqual([{
      entityId,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: recipientId,
          tokenId: 1,
          amount: 7n,
          route: [entityId, hubId, recipientId],
        },
      }],
    }]);
    expect('runtimeTxs' in (compactActivity?.runtimeInput ?? {})).toBe(false);
    expect('signerId' in (compactActivity?.runtimeInput.entityInputs[0] ?? {})).toBe(false);
    const rawJournal = await readPersistedRuntimeActivityJournal(env, 3);
    expect(rawJournal?.runtimeInput?.runtimeTxs).toEqual([]);
    expect(rawJournal?.logs?.[0]?.message).toBe('HtlcReceived');

    const receiptPage = await readFrameReceipts(env, {
      fromHeight: 3,
      toHeight: 3,
      entityId: recipientId,
      eventNames: ['HtlcReceived'],
    });
    expect(receiptPage.receipts).toEqual([{
      height: 3,
      timestamp: rawJournal?.timestamp,
      logs: rawJournal?.logs,
    }]);
    const caughtUpPage = await readFrameReceipts(env, {
      fromHeight: 6,
      entityId: recipientId,
      eventNames: ['HtlcReceived'],
    });
    expect(caughtUpPage).toEqual({
      fromHeight: 6,
      toHeight: 5,
      returned: 0,
      receipts: [],
    });

    const page = await readPersistedRuntimeActivityPage(env, {
      entityId: recipientId,
      limit: 20,
      scanLimit: 20,
    });
    expect(page.events.find((event) => event.rawType === 'HtlcReceived')).toMatchObject({
      height: 3,
      type: 'payment',
      direction: 'in',
      amount: '7',
      counterpartyId: hubId,
    });
    expect(page.events.find((event) => event.rawType === 'directPayment')).toMatchObject({
      height: 3,
      type: 'payment',
      amount: '7',
    });

    await getFrameDb(env).put(keyFrameDbRuntimeActivity(3), Buffer.from([0xc1]));
    await expect(readPersistedRuntimeActivityJournal(env, 3))
      .rejects.toThrow('STORAGE_ACTIVITY_JOURNAL_READ_FAILED:height=3');
  } finally {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  }
});
