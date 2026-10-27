import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { deriveDelta } from '../../../account/utils';
import { generateLazyEntityId } from '../../../entity/factory';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import {
  closeInfraDb, closeRuntimeDb, createEmptyEnv, enqueueRuntimeInput, getRuntimeWalDb,
  loadEnvFromDB, processRuntime, readPersistedFrameJournal,
} from '../../../runtime';
import type { RuntimeReplica } from '../../../runtime/types';
import { createCheckpointBarrierRuntimeTx } from '../../../runtime/checkpoint/barrier';
import { readStorageFrameRecord } from '../../../storage';
import { computeCanonicalStateHashFromEnv } from '../../../storage/canonical-hash';
import { safeStringify } from '../../../protocol/serialization';
import { createTestJReplica } from '../../helpers/j-replica';

test('verified financial WAL replay leaves no historic storage marks in the next no-account frame', async () => {
  // The live-head-account-restore fixture: real imported owners, bilateral Account
  // consensus, persistent WAL and the production checkpoint+journal recovery path.
  const seed = `recovery-overlay-marks-${process.pid}-${Date.now()}`;
  const env = createEmptyEnv(seed);
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.quietRuntimeLogs = true;
  env.state.timestamp = 1_000;
  env.runtimeConfig = { ...env.runtimeConfig, storage: {
    ...env.runtimeConfig?.storage, snapshotPeriodFrames: 10_000, materializePeriodFrames: 10_000,
  } };
  const owners = [1, 2].map(index => {
    const signerId = deriveSignerAddressSync(seed, String(index)).toLowerCase();
    registerSignerKey(env, signerId, deriveSignerKeySync(seed, String(index)));
    return { signerId, entityId: generateLazyEntityId([signerId], 1n).toLowerCase() };
  });
  const [user, hub] = owners;
  if (!user || !hub) throw new Error('RECOVERY_OVERLAY_OWNERS_MISSING');
  const jurisdiction = {
    name: 'recovery-overlay-marks', address: 'browservm://recovery-overlay-marks', chainId: 31337,
    depositoryAddress: '0x000000000000000000000000000000000000dEaD',
    // Explicit test floor: fixtures sign short dispute windows.
    accountDisputeFloorSeconds: 10,
    entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
  };
  env.activeJurisdiction = jurisdiction.name;
  env.state.jReplicas.set(jurisdiction.name, createTestJReplica({
    name: jurisdiction.name, chainId: jurisdiction.chainId,
    contracts: { depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress,
      account: '0x000000000000000000000000000000000000ac01',
      deltaTransformer: '0x000000000000000000000000000000000000de17' },
  }));
  let recovered: RuntimeReplica | null = null;
  const account = (runtime: RuntimeReplica) => {
    const owner = [...runtime.state.eReplicas.values()].find(replica => replica.entityId === user.entityId);
    const result = owner?.state.accounts.get(hub.entityId);
    if (!result) throw new Error('RECOVERY_OVERLAY_ACCOUNT_MISSING');
    return result;
  };
  const balance = (runtime: RuntimeReplica): bigint => {
    const state = account(runtime).state;
    const delta = state.deltas.get(1);
    if (!delta) throw new Error('RECOVERY_OVERLAY_TOKEN_MISSING');
    const derived = deriveDelta(delta, state.leftEntity.toLowerCase() === user.entityId);
    expect(derived.inOwnCredit).toBe(0n);
    return derived.outCollateral + derived.outPeerCredit;
  };
  const drain = async () => {
    for (let step = 0; step < 24; step += 1) await processRuntime(env, []);
    for (const owner of env.state.eReplicas.values()) for (const bilateral of owner.state.accounts.values()) {
      expect(bilateral.pendingFrame).toBeUndefined();
      expect(bilateral.mempool).toHaveLength(0);
    }
    expect(env.runtimeMempool.entityInputs).toHaveLength(0);
  };
  try {
    enqueueRuntimeInput(env, {
      runtimeTxs: owners.map(({ entityId, signerId }) => createTestEntityImportRuntimeTx(env, {
        entityId, signerId, data: { isProposer: true, config: {
          mode: 'proposer-based', threshold: 1n, validators: [signerId], shares: { [signerId]: 1n }, jurisdiction,
        } },
      })), entityInputs: [],
    });
    await processRuntime(env, []);
    enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{ ...user, entityTxs: [{
      type: 'openAccount', data: { targetEntityId: hub.entityId, creditAmount: 1000n, tokenId: 1,
        disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 } },
    }] }] });
    await drain();
    expect(balance(env)).toBe(0n);
    await processRuntime(env, [{ ...hub, entityTxs: [{ type: 'directPayment', data: {
      targetEntityId: user.entityId, tokenId: 1, amount: 10n, route: [hub.entityId, user.entityId],
      deliveryMode: 'direct', description: 'persisted recovery overlay payment',
    } }] }]);
    await drain();
    expect(balance(env)).toBe(10n);
    const persistedHeight = env.state.height;
    const financialFrame = await readStorageFrameRecord(getRuntimeWalDb(env), persistedHeight);
    expect(financialFrame?.materializedState).toBe(false);
    expect(financialFrame?.touchedAccounts.length).toBeGreaterThan(0);
    expect(env.infrastructure?.currentStorageOverlayMarks?.size).toBe(0);
    const expectedHash = computeCanonicalStateHashFromEnv(env);
    const accountRoot = account(env).currentFrame.accountStateRoot;
    await closeRuntimeDb(env);
    await closeInfraDb(env);

    recovered = await loadEnvFromDB(runtimeId, seed);
    if (!recovered) throw new Error('RECOVERY_OVERLAY_RESTORE_MISSING');
    expect(recovered.state.height).toBe(persistedHeight);
    expect(computeCanonicalStateHashFromEnv(recovered)).toBe(expectedHash);
    expect(balance(recovered)).toBe(10n);
    expect(account(recovered).currentFrame.accountStateRoot).toBe(accountRoot);
    const replayMeta = Reflect.get(recovered, '__replayMeta');
    expect(replayMeta.replayedFrameCount).toBeGreaterThan(0);
    const retainedMarks = [...(recovered.infrastructure?.currentStorageOverlayMarks?.values() ?? [])];
    const pendingMaterialization = [...(recovered.overlay?.values() ?? [])];
    expect(pendingMaterialization.some(record => record.family === 'account')).toBe(true);

    enqueueRuntimeInput(recovered, { runtimeTxs: [createCheckpointBarrierRuntimeTx()], entityInputs: [] });
    await processRuntime(recovered, []);
    const next = await readStorageFrameRecord(getRuntimeWalDb(recovered), recovered.state.height);
    const journal = await readPersistedFrameJournal(recovered, recovered.state.height);
    expect(journal?.runtimeInput.entityInputs).toEqual([]);
    expect(balance(recovered)).toBe(10n);
    expect(account(recovered).currentFrame.accountStateRoot).toBe(accountRoot);
    console.log(`RECOVERY_OVERLAY_EVIDENCE ${safeStringify({ persistedHeight, replayMeta, retainedMarks, pendingMaterialization,
      nextHeight: next?.height, nextAccounts: next?.touchedAccounts, nextBooks: next?.touchedBookEntities })}`);
    expect(retainedMarks).toEqual([]);
    expect(next?.touchedAccounts).toEqual([]);
    expect(next?.touchedBookEntities).toEqual([]);
  } finally {
    if (recovered) { await closeRuntimeDb(recovered); await closeInfraDb(recovered); }
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    const prefix = join(process.env['XLN_DB_PATH'] || 'db-tmp/runtime', runtimeId);
    for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-history-views', '-events', '-infra'])
      rmSync(`${prefix}${suffix}`, { recursive: true, force: true });
  }
}, 30_000);
