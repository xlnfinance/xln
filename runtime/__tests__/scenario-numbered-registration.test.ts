import { describe, expect, test } from 'bun:test';

import { createJAdapter } from '../jadapter';
import { createEmptyEnv } from '../runtime';
import {
  executeScenario,
  resolveScenarioNumberedRegistrationContext,
} from '../scenarios/executor';
import { setScenarioStorageEnabled } from '../scenarios/helpers';
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

describe('scenario numbered-registration boundary', () => {
  test('executes a real numbered import through the attached adapter and funded runtime payer', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31_338 });
    try {
      const env = createEmptyEnv('scenario-registration:execute-import');
      setScenarioStorageEnabled(env, false);
      if (!env.runtimeId || !adapter.fundSignerWallet) {
        throw new Error('SCENARIO_REGISTRATION_TEST_SETUP_INVALID');
      }
      const jurisdiction: JurisdictionConfig = {
        name: 'ScenarioRegistration',
        address: 'browservm://scenario-registration',
        chainId: adapter.chainId,
        depositoryAddress: adapter.addresses.depository,
        entityProviderAddress: adapter.addresses.entityProvider,
      };
      attach(env, adapter, jurisdiction);
      adapter.startWatching(env);
      env.activeJurisdiction = jurisdiction.name;
      env.scenarioMode = true;
      await adapter.fundSignerWallet(env.runtimeId);

      const result = await executeScenario(env, {
        seed: 'scenario-registration:execute-import',
        events: [{
          timestamp: 1,
          actions: [{ type: 'import', params: ['1', '2'] }],
        }],
        repeatBlocks: [],
        includes: [],
      }, { maxTimestamp: 1, tickInterval: 0 });

      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
      expect(await adapter.entityProvider.nextNumber()).toBe(4n);
      expect(env.eReplicas.size).toBe(2);
    } finally {
      await adapter.close();
    }
  }, 30_000);

  test('requires the owning runtime identity to have a trusted adapter and native gas', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31_338 });
    try {
      const jurisdiction: JurisdictionConfig = {
        name: 'ScenarioRegistration',
        address: 'browservm://scenario-registration',
        chainId: adapter.chainId,
        depositoryAddress: adapter.addresses.depository,
        entityProviderAddress: adapter.addresses.entityProvider,
      };
      const ready = createEmptyEnv('scenario-registration:ready');
      if (!ready.runtimeId || !adapter.fundSignerWallet) {
        throw new Error('SCENARIO_REGISTRATION_TEST_SETUP_INVALID');
      }
      attach(ready, adapter, jurisdiction);
      adapter.startWatching(ready);
      await adapter.fundSignerWallet(ready.runtimeId);
      const context = await resolveScenarioNumberedRegistrationContext(ready, jurisdiction);
      expect(context.jadapter).toBe(adapter);
      expect(context.payerSignerId).toBe(ready.runtimeId);

      const missingAdapter = createEmptyEnv('scenario-registration:missing-adapter');
      await expect(resolveScenarioNumberedRegistrationContext(missingAdapter, jurisdiction))
        .rejects.toThrow('NUMBERED_REGISTRATION_TRUSTED_ADAPTER_MISSING');

      const unfunded = createEmptyEnv('scenario-registration:unfunded');
      await adapter.stopWatchingAndWait();
      attach(unfunded, adapter, jurisdiction);
      adapter.startWatching(unfunded);
      await expect(resolveScenarioNumberedRegistrationContext(unfunded, jurisdiction))
        .rejects.toThrow(`SCENARIO_NUMBERED_REGISTRATION_PAYER_UNFUNDED:${unfunded.runtimeId}`);
    } finally {
      await adapter.close();
    }
  }, 30_000);
});
