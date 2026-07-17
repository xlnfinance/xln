import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { getSignerPrivateKey } from '../account/crypto';
import {
  buildNumberedRegistrationCompletionRuntimeTxs,
  buildNumberedRegistrationRequest,
  getNumberedRegistrationRecord,
  prepareNumberedRegistrationIntent,
  submitNumberedRegistrationIntent,
} from '../entity/numbered-registration-intent';
import { createJAdapter } from '../jadapter';
import { createEmptyEnv } from '../runtime';
import { commitRuntimeInput, processJEvents, setScenarioStorageEnabled } from '../scenarios/helpers';
import {
  buildDurableRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../wal/snapshot';
import type { Env, JReplica, JurisdictionConfig } from '../types';

const attach = (
  env: Env,
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
    jadapter: adapter,
  };
  env.jAdapter = adapter;
  env.jReplicas.set(jurisdiction.name, replica);
};

describe('durable numbered registration intent', () => {
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
      const proposer = new ethers.Wallet(ethers.hexlify(getSignerPrivateKey(env, '1'))).address.toLowerCase();
      const request = buildNumberedRegistrationRequest(env, {
        intentId: ethers.id('registration-intent:one'),
        jurisdiction,
        payerSignerId: env.runtimeId,
        entities: [{ name: 'one', validators: [proposer], threshold: 1n }],
      });
      const pending = await prepareNumberedRegistrationIntent(env, adapter, request);
      expect(pending.status).toBe('pending');
      await commitRuntimeInput(env, {
        runtimeTxs: [{ type: 'recordNumberedRegistrationIntent', data: pending }],
        entityInputs: [],
      });
      const preBroadcast = buildDurableRuntimeMachineSnapshot(env);

      const sent = await adapter.provider.broadcastTransaction(pending.rawTransaction);
      await sent.wait();
      expect(await adapter.entityProvider.nextNumber()).toBe(3n);

      await adapter.stopWatchingAndWait();
      const restored = createEmptyEnv(seed);
      setScenarioStorageEnabled(restored, false);
      restored.scenarioMode = true;
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
      expect(getNumberedRegistrationRecord(restored, request.intentId)?.status).toBe('completed');
      expect(restored.eReplicas.size).toBe(1);
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
        entities: [{ name: 'one', validators: [proposer], threshold: 1n }],
      });
      const pending = await prepareNumberedRegistrationIntent(env, adapter, request);
      await commitRuntimeInput(env, {
        runtimeTxs: [{ type: 'recordNumberedRegistrationIntent', data: pending }],
        entityInputs: [],
      });

      const changed = buildNumberedRegistrationRequest(env, {
        intentId,
        jurisdiction,
        payerSignerId: env.runtimeId,
        entities: [{ name: 'changed', validators: [proposer], threshold: 1n }],
      });
      await expect(prepareNumberedRegistrationIntent(env, adapter, changed))
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
        runtimeTxs: [{
          type: 'resolveNumberedRegistrationIntent',
          data: {
            kind: 'quarantined',
            intentId,
            requestHash: pending.requestHash,
            transactionHash: pending.transactionHash,
            reason: conflict.reason,
          },
        }],
        entityInputs: [],
      });
      expect(getNumberedRegistrationRecord(env, intentId)?.status).toBe('quarantined');
    } finally {
      await adapter.close();
    }
  }, 30_000);
});
