import { describe, expect, spyOn, test } from 'bun:test';
import { ethers } from 'ethers';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { getSignerPrivateKey, registerSignerKey } from '../account/crypto';
import {
  buildNumberedRegistrationCompletionRuntimeTxs,
  buildNumberedRegistrationRequest,
  getNumberedRegistrationRecord,
  prepareNumberedRegistrationIntent,
  runNumberedRegistrationIntent,
  submitNumberedRegistrationIntent,
} from '../runtime/registration/numbered-registration-intent';
import { markLocalNumberedRegistrationTx } from '../runtime/registration/numbered-registration-auth';
import { createJAdapter } from '../jurisdiction/adapter';
import { closeInfraDb, closeRuntimeDb, createEmptyEnv, loadEnvFromDB } from '../runtime';
import { commitRuntimeInput, processJEvents, setScenarioStorageEnabled } from '../scenarios/helpers';
import {
  buildDurableRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../storage/wal/snapshot';
import type { RuntimeReplica } from '../runtime/types';
import type { JurisdictionConfig } from '../entity/types';
import type { JReplica } from '../types/jurisdiction-runtime';
import { attachLiveJAdapter } from '../runtime/live-jadapters';
import { getLiveJAdapter } from '../runtime/live-jadapters';
import { markLocalRuntimeAdapterCommandTx } from '../runtime/command-frontier-auth';
import { runtimeAdapterCommandLaneId } from '../runtime/command-frontier';
import { dbRootPath } from '../runtime/platform';

const attach = (
  env: RuntimeReplica,
  adapter: Awaited<ReturnType<typeof createJAdapter>>,
  jurisdiction: JurisdictionConfig,
): void => {
  const replica: JReplica = {
    name: jurisdiction.name,
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    chainId: adapter.chainId,
    position: { x: 0, y: 0, z: 0 },
    depositoryAddress: adapter.addresses.depository,
    entityProviderAddress: adapter.addresses.entityProvider,
    entityProviderDeploymentBlock: adapter.entityProviderDeploymentBlock,
    watcherConfirmationDepth: 0,
    contracts: { ...adapter.addresses },
  };
  env.state.jReplicas.set(jurisdiction.name, replica);
  attachLiveJAdapter(env, jurisdiction.name, adapter);
};

describe('durable numbered registration intent', () => {
  test('cold WAL replay validates a pending signed intent before live adapter rehydration', async () => {
    const seed = `numbered-registration:cold-wal-replay:${process.pid}`;
    const env = createEmptyEnv(seed);
    if (!env.runtimeId) throw new Error('REGISTRATION_INTENT_TEST_SETUP_INVALID');
    const namespace = join(dbRootPath, env.runtimeId);
    const cleanup = (): void => {
      for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-events', '-infra']) {
        rmSync(`${namespace}${suffix}`, { recursive: true, force: true });
      }
    };
    cleanup();
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31_338 });
    let adapterClosed = false;
    let restored: RuntimeReplica | null = null;
    try {
      setScenarioStorageEnabled(env, true);
      env.scenarioMode = true;
      env.quietRuntimeLogs = true;
      const jurisdiction: JurisdictionConfig = {
        name: 'RegistrationIntentColdReplay',
        address: 'browservm://registration-intent-cold-replay',
        chainId: adapter.chainId,
        depositoryAddress: adapter.addresses.depository,
        entityProviderAddress: adapter.addresses.entityProvider,
      };
      attach(env, adapter, jurisdiction);
      adapter.startWatching(env);
      const laneId = runtimeAdapterCommandLaneId('cold-replay-device', 'cold-replay-capability');
      await commitRuntimeInput(env, {
        runtimeTxs: [markLocalRuntimeAdapterCommandTx({
          type: 'recordRuntimeAdapterCommand',
          data: {
            laneId,
            sequence: 1,
            commandId: 'numbered-registration:cold-replay:marker',
            inputHash: ethers.id('numbered-registration:cold-replay:marker'),
            expiresAtMs: 9_999_999_999_999,
          },
        })],
        entityInputs: [],
      });
      const proposerPrivateKey = getSignerPrivateKey(env, '1');
      const proposer = new ethers.Wallet(ethers.hexlify(proposerPrivateKey)).address.toLowerCase();
      registerSignerKey(env, proposer, proposerPrivateKey);
      const request = buildNumberedRegistrationRequest(env, {
        intentId: ethers.id('numbered-registration:cold-replay:intent'),
        jurisdiction,
        payerSignerId: env.runtimeId,
        entities: [{ name: 'cold-replay', validators: [proposer], threshold: 1n, localSignerId: null }],
      });
      const pending = await prepareNumberedRegistrationIntent(env, adapter, request, async prepared => {
        await commitRuntimeInput(env, {
          runtimeTxs: [markLocalNumberedRegistrationTx({ type: 'recordNumberedRegistrationIntent', data: prepared })],
          entityInputs: [],
        });
        return 'accepted';
      });
      expect(env.state.height).toBe(2);
      await adapter.stopWatchingAndWait();
      await closeRuntimeDb(env);
      await closeInfraDb(env);
      await adapter.close();
      adapterClosed = true;

      restored = await loadEnvFromDB(env.runtimeId, seed);
      if (!restored) throw new Error('REGISTRATION_INTENT_COLD_REPLAY_MISSING');
      expect(restored.state.height).toBe(2);
      expect(getNumberedRegistrationRecord(restored, request.intentId)).toEqual(pending);
      // This fixture persists the committed JReplica, but deliberately does
      // not persist a BrowserVM snapshot. The cold loader must still replay
      // and validate the signed intent before any live adapter can exist.
      expect(getLiveJAdapter(restored, jurisdiction.name)).toBeUndefined();
    } finally {
      const restoredAdapter = restored ? getLiveJAdapter(restored, 'RegistrationIntentColdReplay') : undefined;
      await restoredAdapter?.close();
      if (restored) {
        await closeRuntimeDb(restored);
        await closeInfraDb(restored);
      }
      if (adapter.isWatching()) await adapter.stopWatchingAndWait();
      if (!adapterClosed) await adapter.close();
      cleanup();
    }
  }, 30_000);

  test('restores the exact signed tx after broadcast loss and imports only after receipt evidence', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31_338 });
    try {
      const seed = 'numbered-registration:intent-recovery';
      const env = createEmptyEnv(seed);
      setScenarioStorageEnabled(env, false);
      if (!env.runtimeId || !adapter.fundSignerWallet) throw new Error('REGISTRATION_INTENT_TEST_SETUP_INVALID');
      const jurisdiction: JurisdictionConfig = {
        name: 'RegistrationIntent',
        address: 'browservm://registration-intent',
        chainId: adapter.chainId,
        depositoryAddress: adapter.addresses.depository,
        entityProviderAddress: adapter.addresses.entityProvider,
      };
      attach(env, adapter, jurisdiction);
      env.scenarioMode = true;
      adapter.startWatching(env);
      await adapter.fundSignerWallet(env.runtimeId);
      const proposerPrivateKey = getSignerPrivateKey(env, '1');
      const proposer = new ethers.Wallet(ethers.hexlify(proposerPrivateKey)).address.toLowerCase();
      registerSignerKey(env, proposer, proposerPrivateKey);
      const request = buildNumberedRegistrationRequest(env, {
        intentId: ethers.id('registration-intent:one'),
        jurisdiction,
        payerSignerId: env.runtimeId,
        entities: [{ name: 'one', validators: [proposer], threshold: 1n, localSignerId: proposer }],
      });
      const beforeFailedCommit = buildDurableRuntimeMachineSnapshot(env);
      const commitFailure = {
        commit: async () => 'rejected' as const,
        drain: async (): Promise<void> => {
          throw new Error('REGISTRATION_INTENT_MUST_NOT_DRAIN');
        },
      };
      const prematureBroadcast = spyOn(adapter.provider, 'broadcastTransaction');
      const failedCommit = spyOn(commitFailure, 'commit');
      const prematureDrain = spyOn(commitFailure, 'drain');
      await expect(runNumberedRegistrationIntent(env, adapter, request, failedCommit, prematureDrain))
        .rejects.toThrow('DURABLE_TRANSACTION_ACCEPTANCE_REJECTED');
      expect(failedCommit.mock.calls[0]?.[0].map(tx => tx.type)).toEqual(['recordNumberedRegistrationIntent']);
      expect([failedCommit.mock.calls.length, prematureBroadcast.mock.calls.length, prematureDrain.mock.calls.length])
        .toEqual([1, 0, 0]);
      expect([getNumberedRegistrationRecord(env, request.intentId), env.state.eReplicas.size]).toEqual([undefined, 0]);
      expect(buildDurableRuntimeMachineSnapshot(env)).toEqual(beforeFailedCommit);
      expect(await adapter.entityProvider.nextNumber()).toBe(2n);
      prematureBroadcast.mockRestore();
      const pending = await prepareNumberedRegistrationIntent(env, adapter, request, async prepared => {
        await commitRuntimeInput(env, {
          runtimeTxs: [markLocalNumberedRegistrationTx({ type: 'recordNumberedRegistrationIntent', data: prepared })],
          entityInputs: [],
        });
        return 'accepted';
      });
      expect(pending.status).toBe('pending');
      const preBroadcast = buildDurableRuntimeMachineSnapshot(env);

      const sent = await adapter.provider.broadcastTransaction(pending.rawTransaction);
      await sent.wait();
      expect(await adapter.entityProvider.nextNumber()).toBe(3n);

      await adapter.stopWatchingAndWait();
      const restored = createEmptyEnv(seed);
      setScenarioStorageEnabled(restored, false);
      restored.scenarioMode = true;
      registerSignerKey(restored, proposer, proposerPrivateKey);
      restoreDurableRuntimeSnapshot(restored, preBroadcast);
      attach(restored, adapter, jurisdiction);
      adapter.startWatching(restored);
      const restoredPending = getNumberedRegistrationRecord(restored, request.intentId);
      if (!restoredPending || restoredPending.status !== 'pending') {
        throw new Error('REGISTRATION_INTENT_RESTORE_MISSING');
      }
      const submitted = await submitNumberedRegistrationIntent(adapter, restoredPending);
      expect(submitted.kind).toBe('receipt');
      expect(await adapter.entityProvider.nextNumber()).toBe(3n);

      await processJEvents(restored);
      if (submitted.kind !== 'receipt') throw new Error('REGISTRATION_INTENT_RECEIPT_MISSING');
      const completionTxs = buildNumberedRegistrationCompletionRuntimeTxs(
        restored,
        restoredPending,
        submitted,
      );
      await commitRuntimeInput(restored, { runtimeTxs: completionTxs, entityInputs: [] });
      const completed = getNumberedRegistrationRecord(restored, request.intentId);
      if (!completed || completed.status !== 'completed') {
        throw new Error('REGISTRATION_INTENT_COMPLETION_MISSING');
      }
      expect(restored.state.eReplicas.size).toBe(1);

      const effects = {
        commit: async (): Promise<void> => {
          throw new Error('COMPLETED_REGISTRATION_MUST_NOT_COMMIT');
        },
        drain: async (): Promise<void> => {
          throw new Error('COMPLETED_REGISTRATION_MUST_NOT_DRAIN');
        },
      };
      const broadcast = spyOn(adapter.provider, 'broadcastTransaction');
      const commit = spyOn(effects, 'commit');
      const drain = spyOn(effects, 'drain');
      const retried = await runNumberedRegistrationIntent(restored, adapter, request, commit, drain);
      const replica = [...restored.state.eReplicas.values()][0]!;
      expect(retried).toEqual([{
        config: replica.state.config,
        entityNumber: completed.results[0]!.entityNumber,
        entityId: completed.results[0]!.entityId,
      }]);
      expect([broadcast.mock.calls.length, commit.mock.calls.length, drain.mock.calls.length]).toEqual([0, 0, 0]);
      expect(await adapter.entityProvider.nextNumber()).toBe(3n);
      expect(restored.state.eReplicas.size).toBe(1);

      const changed = buildNumberedRegistrationRequest(restored, {
        intentId: request.intentId,
        jurisdiction,
        payerSignerId: request.payerSignerId,
        entities: [{ name: 'changed', validators: [proposer], threshold: 1n, localSignerId: proposer }],
      });
      await expect(runNumberedRegistrationIntent(restored, adapter, changed, commit, drain))
        .rejects.toThrow('NUMBERED_REGISTRATION_INTENT_PAYLOAD_CONFLICT');
      expect([broadcast.mock.calls.length, commit.mock.calls.length, drain.mock.calls.length]).toEqual([0, 0, 0]);
      expect(await adapter.entityProvider.nextNumber()).toBe(3n);
      expect(restored.state.eReplicas.size).toBe(1);
    } finally {
      await adapter.close();
    }
  }, 30_000);

  test('same intent rejects a different payload and a consumed payer nonce quarantines without registration', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31_338 });
    try {
      const env = createEmptyEnv('numbered-registration:intent-conflict');
      setScenarioStorageEnabled(env, false);
      if (!env.runtimeId || !adapter.fundSignerWallet) throw new Error('REGISTRATION_INTENT_TEST_SETUP_INVALID');
      const jurisdiction: JurisdictionConfig = {
        name: 'RegistrationIntent',
        address: 'browservm://registration-intent',
        chainId: adapter.chainId,
        depositoryAddress: adapter.addresses.depository,
        entityProviderAddress: adapter.addresses.entityProvider,
      };
      attach(env, adapter, jurisdiction);
      env.scenarioMode = true;
      adapter.startWatching(env);
      await adapter.fundSignerWallet(env.runtimeId);
      const proposer = new ethers.Wallet(ethers.hexlify(getSignerPrivateKey(env, '1'))).address.toLowerCase();
      const intentId = ethers.id('registration-intent:conflict');
      const request = buildNumberedRegistrationRequest(env, {
        intentId,
        jurisdiction,
        payerSignerId: env.runtimeId,
        entities: [{ name: 'one', validators: [proposer], threshold: 1n, localSignerId: null }],
      });
      const pending = await prepareNumberedRegistrationIntent(env, adapter, request, async prepared => {
        await commitRuntimeInput(env, {
          runtimeTxs: [markLocalNumberedRegistrationTx({ type: 'recordNumberedRegistrationIntent', data: prepared })],
          entityInputs: [],
        });
        return 'accepted';
      });

      const changed = buildNumberedRegistrationRequest(env, {
        intentId,
        jurisdiction,
        payerSignerId: env.runtimeId,
        entities: [{ name: 'changed', validators: [proposer], threshold: 1n, localSignerId: null }],
      });
      await expect(prepareNumberedRegistrationIntent(env, adapter, changed, async () => {
        throw new Error('CHANGED_INTENT_MUST_NOT_ACCEPT');
      }))
        .rejects.toThrow('NUMBERED_REGISTRATION_INTENT_PAYLOAD_CONFLICT');

      const payer = new ethers.Wallet(
        ethers.hexlify(getSignerPrivateKey(env, env.runtimeId)),
        adapter.provider,
      );
      await (await payer.sendTransaction({ to: payer.address, value: 0n })).wait();
      const conflict = await submitNumberedRegistrationIntent(adapter, pending);
      expect(conflict.kind).toBe('nonce-conflict');
      expect(await adapter.entityProvider.nextNumber()).toBe(2n);
      if (conflict.kind !== 'nonce-conflict') throw new Error('REGISTRATION_NONCE_CONFLICT_EXPECTED');
      await commitRuntimeInput(env, {
        runtimeTxs: [markLocalNumberedRegistrationTx({
          type: 'resolveNumberedRegistrationIntent',
          data: {
            kind: 'quarantined',
            intentId,
            requestHash: pending.requestHash,
            transactionHash: pending.transactionHash,
            reason: conflict.reason,
          },
        })],
        entityInputs: [],
      });
      expect(getNumberedRegistrationRecord(env, intentId)?.status).toBe('quarantined');
    } finally {
      await adapter.close();
    }
  }, 30_000);
});
