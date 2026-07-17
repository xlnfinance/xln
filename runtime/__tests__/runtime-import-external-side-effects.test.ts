import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { computeAddress, hexlify } from 'ethers';

import { getSignerPrivateKey } from '../account/crypto';
import { getRegisteredBrowserVMJurisdiction } from '../jadapter';
import { dbRootPath } from '../machine/platform';
import { bootScenario } from '../scenarios/boot';
import { setScenarioStorageEnabled } from '../scenarios/helpers';
import {
  buildJurisdictionImportRequestHash,
  normalizeJurisdictionImportRequest,
} from '../machine/jurisdiction-import';
import {
  createEmptyEnv,
  closeInfraDb,
  closeRuntimeDb,
  enqueueRuntimeInput,
  generateLazyEntityId,
  loadEnvFromDB,
  process as processRuntime,
} from '../runtime';

const TEST_RUN_ID = `${globalThis.process.pid}-${Date.now()}`;
const cleanupNamespaces: string[] = [];

const cleanupRuntimeStorage = (namespace: string): void => {
  const base = join(dbRootPath, namespace);
  for (const suffix of ['', '-storage-current', '-storage-previous', '-frames', '-events', '-infra']) {
    rmSync(`${base}${suffix}`, { recursive: true, force: true });
  }
};

afterEach(() => {
  while (cleanupNamespaces.length > 0) cleanupRuntimeStorage(cleanupNamespaces.pop()!);
});

const signerAddress = (
  env: ReturnType<typeof createEmptyEnv>,
  signerSlot: string,
): string => computeAddress(hexlify(getSignerPrivateKey(env, signerSlot))).toLowerCase();

describe('runtime import external-side-effect atomicity', () => {
  test('rejects RPC policies that the importer does not actually execute', () => {
    const contracts = {
      depository: `0x${'11'.repeat(20)}`,
      entityProvider: `0x${'22'.repeat(20)}`,
      account: `0x${'33'.repeat(20)}`,
      deltaTransformer: `0x${'44'.repeat(20)}`,
    };
    expect(() => normalizeJurisdictionImportRequest({
      name: 'Unsupported failover',
      chainId: 31337,
      ticker: 'ETH',
      rpcs: ['http://127.0.0.1:8545'],
      entityProviderDeploymentBlock: 1,
      rpcPolicy: 'failover',
      contracts,
    })).toThrow('IMPORT_J_RPC_POLICY_UNSUPPORTED:failover');
    expect(() => normalizeJurisdictionImportRequest({
      name: 'Unimplemented multi RPC',
      chainId: 31337,
      ticker: 'ETH',
      rpcs: ['http://127.0.0.1:8545', 'http://127.0.0.1:9545'],
      entityProviderDeploymentBlock: 1,
      contracts,
    })).toThrow('IMPORT_J_MULTIPLE_RPCS_UNSUPPORTED:2');
  });

  test('requires trusted EntityProvider deployment metadata for RPC imports', () => {
    const request = {
      name: 'Missing deployment block',
      chainId: 31337,
      ticker: 'ETH',
      rpcs: ['http://127.0.0.1:8545'],
      contracts: {
        depository: `0x${'11'.repeat(20)}`,
        entityProvider: `0x${'22'.repeat(20)}`,
        account: `0x${'33'.repeat(20)}`,
        deltaTransformer: `0x${'44'.repeat(20)}`,
      },
    };
    expect(() => normalizeJurisdictionImportRequest(request))
      .toThrow('IMPORT_J_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_REQUIRED');
    expect(buildJurisdictionImportRequestHash({
      ...request,
      entityProviderDeploymentBlock: 1,
    })).not.toBe(buildJurisdictionImportRequestHash({
      ...request,
      entityProviderDeploymentBlock: 2,
    }));
  });

  test('failed BrowserVM importJ frame leaves the process-global jurisdiction registry unchanged', async () => {
    const env = createEmptyEnv('runtime-import-j-external-side-effects');
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.timestamp = 1_000;
    const browserVMBefore = env.browserVM;
    const registryBefore = getRegisteredBrowserVMJurisdiction();
    const unknownSignerId = `0x${'cd'.repeat(20)}`;
    const unknownEntityId = generateLazyEntityId([unknownSignerId], 1n).toLowerCase();

    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importJ',
        data: {
          name: 'Uncommitted BrowserVM',
          chainId: 31337,
          ticker: 'SIM',
          rpcs: [],
        },
      }],
      entityInputs: [{
        entityId: unknownEntityId,
        signerId: unknownSignerId,
        entityTxs: [],
      }],
    });

    await expect(processRuntime(env)).rejects.toThrow('RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET');

    expect(env.jReplicas.size).toBe(0);
    expect(env.browserVM).toBe(browserVMBefore);
    expect(getRegisteredBrowserVMJurisdiction()).toBe(registryBefore);
  }, 30_000);

  test('BrowserVM import publishes one live adapter only after durable result commit', async () => {
    const env = createEmptyEnv(`runtime-import-j-two-phase-success-${TEST_RUN_ID}`);
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.timestamp = 1_000;
    const registryBefore = getRegisteredBrowserVMJurisdiction();

    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importJ',
        data: {
          name: 'Durable BrowserVM',
          chainId: 31337,
          ticker: 'SIM',
          rpcs: [],
        },
      }],
      entityInputs: [],
    });

    await processRuntime(env);
    expect(env.height).toBe(1);
    expect(env.jReplicas.size).toBe(0);
    expect(env.runtimeState?.pendingJurisdictionImports?.size).toBe(1);
    expect(env.runtimeMempool?.runtimeTxs.map(tx => tx.type)).toEqual(['completeImportJ']);
    expect(getRegisteredBrowserVMJurisdiction()).toBe(registryBefore);

    await processRuntime(env);
    const replica = env.jReplicas.get('Durable BrowserVM');
    const adapter = replica?.jadapter;
    if (!replica || !adapter) throw new Error('DURABLE_BROWSERVM_IMPORT_MISSING');
    try {
      expect(env.height).toBe(2);
      expect(env.runtimeState?.pendingJurisdictionImports).toBeUndefined();
      expect(env.runtimeMempool?.runtimeTxs).toHaveLength(0);
      expect(adapter.getBrowserVM()).toBe(env.browserVM);
      expect(adapter.isWatching()).toBe(true);
      expect(getRegisteredBrowserVMJurisdiction()?.depositoryAddress.toLowerCase())
        .toBe(adapter.addresses.depository.toLowerCase());
      expect(replica.contracts?.deltaTransformer?.toLowerCase())
        .toBe(adapter.addresses.deltaTransformer.toLowerCase());
    } finally {
      await adapter.close();
    }
  }, 30_000);

  test('external completeImportJ result is rejected before payload validation', async () => {
    const env = createEmptyEnv('runtime-import-j-forged-result');
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.timestamp = 1_000;
    enqueueRuntimeInput(env, {
      runtimeTxs: [{ type: 'completeImportJ', data: {} as never }],
      entityInputs: [],
    });
    await expect(processRuntime(env)).rejects.toThrow('J_IMPORT_RESULT_EXTERNAL_INGRESS_REJECTED');
    expect(env.height).toBe(0);
    expect(env.jReplicas.size).toBe(0);
  });

  test('RPC import without an already provisioned stack fails before durable intent', async () => {
    const env = createEmptyEnv('runtime-import-j-rpc-requires-contracts');
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.timestamp = 1_000;
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importJ',
        data: {
          name: 'Unprovisioned RPC',
          chainId: 31337,
          ticker: 'ETH',
          rpcs: ['http://127.0.0.1:8545'],
        },
      }],
      entityInputs: [],
    });

    await expect(processRuntime(env)).rejects.toThrow('IMPORT_J_RPC_CONTRACTS_REQUIRED');
    expect(env.height).toBe(0);
    expect(env.runtimeState?.pendingJurisdictionImports).toBeUndefined();
    expect(env.jReplicas.size).toBe(0);
  });

  test('pending BrowserVM import resumes after restore and rehydrates exactly one VM', async () => {
    const seed = `runtime-import-j-restore-${TEST_RUN_ID}`;
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.timestamp = 1_000;
    setScenarioStorageEnabled(env, true);
    if (!env.runtimeId) throw new Error('RUNTIME_ID_MISSING');
    cleanupNamespaces.push(env.runtimeId);
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importJ',
        data: { name: 'Restored BrowserVM', chainId: 31337, ticker: 'SIM', rpcs: [] },
      }],
      entityInputs: [],
    });
    await processRuntime(env);
    expect(env.height).toBe(1);
    expect(env.runtimeState?.pendingJurisdictionImports?.size).toBe(1);
    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const restoredIntent = await loadEnvFromDB(env.runtimeId, seed);
    if (!restoredIntent) throw new Error('RESTORED_IMPORT_INTENT_MISSING');
    expect(restoredIntent.height).toBe(1);
    expect(restoredIntent.jReplicas.size).toBe(0);
    expect(restoredIntent.runtimeState?.pendingJurisdictionImports?.size).toBe(1);
    await processRuntime(restoredIntent);
    const committedReplica = restoredIntent.jReplicas.get('Restored BrowserVM');
    if (!committedReplica?.jadapter) throw new Error('RESTORED_IMPORT_RESULT_MISSING');
    expect(restoredIntent.height).toBe(2);
    expect(committedReplica.jadapter.getBrowserVM()).toBe(restoredIntent.browserVM);
    await committedReplica.jadapter.close();
    await closeRuntimeDb(restoredIntent);
    await closeInfraDb(restoredIntent);

    const restoredResult = await loadEnvFromDB(env.runtimeId, seed);
    if (!restoredResult) throw new Error('RESTORED_IMPORT_RESULT_ENV_MISSING');
    try {
      const replica = restoredResult.jReplicas.get('Restored BrowserVM');
      if (!replica?.jadapter) throw new Error('RESTORED_IMPORT_ADAPTER_MISSING');
      expect(restoredResult.height).toBe(2);
      expect(restoredResult.runtimeState?.pendingJurisdictionImports).toBeUndefined();
      expect(replica.jadapter.getBrowserVM()).toBe(restoredResult.browserVM);
      await replica.jadapter.close();
    } finally {
      await closeRuntimeDb(restoredResult);
      await closeInfraDb(restoredResult);
    }
  }, 30_000);

  test('failed importReplica frame does not register a wallet in a committed BrowserVM adapter', async () => {
    const { env, jadapter, jurisdiction } = await bootScenario({
      name: 'runtime-import-replica-wallet-side-effects',
      seed: 'runtime-import-replica-wallet-side-effects',
      signerIds: ['1'],
      storageEnabled: false,
      mode: 'browservm',
    });
    env.quietRuntimeLogs = true;

    try {
      const browserVM = jadapter.getBrowserVM();
      if (!browserVM) throw new Error('BROWSERVM_PROVIDER_MISSING');
      const importedSignerId = signerAddress(env, '1');
      const importedEntityId = generateLazyEntityId([importedSignerId], 1n).toLowerCase();
      const unknownSignerId = `0x${'ef'.repeat(20)}`;
      const unknownEntityId = generateLazyEntityId([unknownSignerId], 1n).toLowerCase();
      expect(() => browserVM.getEntityWallet(importedEntityId)).toThrow(
        'BrowserVM missing wallet for entity',
      );

      enqueueRuntimeInput(env, {
        runtimeTxs: [{
          type: 'importReplica',
          entityId: importedEntityId,
          signerId: importedSignerId,
          data: {
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [importedSignerId],
              shares: { [importedSignerId]: 1n },
              jurisdiction,
            },
            isProposer: false,
            profileName: 'Uncommitted Wallet Import',
          },
        }],
        entityInputs: [{
          entityId: unknownEntityId,
          signerId: unknownSignerId,
          entityTxs: [],
        }],
      });

      await expect(processRuntime(env)).rejects.toThrow('RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET');

      expect(env.eReplicas.has(`${importedEntityId}:${importedSignerId}`)).toBe(false);
      expect(() => browserVM.getEntityWallet(importedEntityId)).toThrow(
        'BrowserVM missing wallet for entity',
      );
    } finally {
      await jadapter.close();
    }
  }, 30_000);

  test('successful importReplica binds its wallet only after the frame commits', async () => {
    const { env, jadapter, jurisdiction } = await bootScenario({
      name: 'runtime-import-replica-wallet-postcommit',
      seed: 'runtime-import-replica-wallet-postcommit',
      signerIds: ['1'],
      storageEnabled: false,
      mode: 'browservm',
    });
    env.quietRuntimeLogs = true;
    try {
      const browserVM = jadapter.getBrowserVM();
      if (!browserVM) throw new Error('BROWSERVM_PROVIDER_MISSING');
      const signerId = signerAddress(env, '1');
      const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
      expect(() => browserVM.getEntityWallet(entityId)).toThrow('BrowserVM missing wallet for entity');
      enqueueRuntimeInput(env, {
        runtimeTxs: [{
          type: 'importReplica',
          entityId,
          signerId,
          data: {
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerId],
              shares: { [signerId]: 1n },
              jurisdiction,
            },
            isProposer: true,
          },
        }],
        entityInputs: [],
      });
      await processRuntime(env);
      expect(browserVM.getEntityWallet(entityId).address.toLowerCase()).toBe(signerId);
    } finally {
      await jadapter.close();
    }
  }, 30_000);
});
