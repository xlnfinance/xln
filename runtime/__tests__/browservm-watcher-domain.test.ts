import { expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { createJAdapter, DEFAULT_PRIVATE_KEY } from '../jadapter';
import {
  applyCompleteImportJurisdiction,
  buildJurisdictionImportRequestHash,
  normalizeJurisdictionImportRequest,
} from '../machine/jurisdiction-import';
import { createEmptyEnv } from '../runtime';
import { createJReplica } from '../scenarios/boot';
import { validateBrowserVmState } from '../wal/runtime-machine-schema/browser';

test('BrowserVM stack does not reuse the fresh-Anvil watcher domain', async () => {
  const adapter = await createJAdapter({ mode: 'browservm', chainId: 31_337 });
  try {
    const deployer = new ethers.Wallet(DEFAULT_PRIVATE_KEY).address;
    const freshAnvilDepository = ethers.getCreateAddress({ from: deployer, nonce: 2 });
    expect(adapter.chainId).toBe(31_337);
    expect(adapter.addresses.depository.toLowerCase()).not.toBe(freshAnvilDepository.toLowerCase());
  } finally {
    await adapter.close();
  }
}, 30_000);

test('jurisdiction import rejects a duplicate watcher domain before publication', () => {
  const env = createEmptyEnv('duplicate-watcher-domain');
  const contracts = {
    depository: `0x${'11'.repeat(20)}`,
    entityProvider: `0x${'22'.repeat(20)}`,
    account: `0x${'33'.repeat(20)}`,
    deltaTransformer: `0x${'44'.repeat(20)}`,
  };
  const primary = createJReplica(env, 'primary', contracts.depository);
  Object.assign(primary, {
    chainId: 31_337,
    depositoryAddress: contracts.depository,
    entityProviderAddress: contracts.entityProvider,
    entityProviderDeploymentBlock: 1,
    contracts,
    rpcs: ['http://127.0.0.1:8545/'],
  });

  const request = normalizeJurisdictionImportRequest({
    name: 'duplicate',
    chainId: 31_337,
    ticker: 'ETH',
    rpcs: ['http://127.0.0.1:9545'],
    entityProviderDeploymentBlock: 1,
    contracts,
  });
  const requestHash = buildJurisdictionImportRequestHash(request);
  env.runtimeState ??= {};
  env.runtimeState.pendingJurisdictionImports = new Map([[
    requestHash,
    { importId: requestHash, requestHash, request },
  ]]);

  expect(() => applyCompleteImportJurisdiction(env, {
    type: 'completeImportJ',
    data: {
      importId: requestHash,
      requestHash,
      name: request.name,
      chainId: request.chainId,
      ticker: request.ticker,
      rpcs: request.rpcs,
      blockNumber: '0',
      stateRoot: null,
      defaultDisputeDelayBlocks: 1,
      watcherConfirmationDepth: 0,
      entityProviderDeploymentBlock: 1,
      contracts,
    },
  })).toThrow('IMPORT_J_WATCHER_IDENTITY_CONFLICT:duplicate:primary');
  expect(env.jReplicas.has('duplicate')).toBe(false);
});

test('BrowserVM reset preserves its configured chain and recreates the same fresh chain', async () => {
  const adapter = await createJAdapter({ mode: 'browservm', chainId: 31_338 });
  try {
    const browserVM = adapter.getBrowserVM();
    if (!browserVM) throw new Error('BROWSERVM_PROVIDER_MISSING');
    const initial = await browserVM.serializeState();

    browserVM.setBlockTimestamp(123_456);
    await browserVM.reset();
    const reset = await browserVM.serializeState();

    expect(browserVM.getChainId()).toBe(31_338n);
    expect(browserVM.getBlockTimestamp()).toBe(0);
    expect(reset.chain).toEqual(initial.chain);
    expect(reset.stateRoot).toBe(initial.stateRoot);
  } finally {
    await adapter.close();
  }
}, 30_000);

test('BrowserVM serialized chain domain is exact and mismatch rejects before state mutation', async () => {
  const source = await createJAdapter({ mode: 'browservm', chainId: 31_337 });
  const target = await createJAdapter({ mode: 'browservm', chainId: 31_338 });
  try {
    const sourceBrowserVM = source.getBrowserVM();
    const targetBrowserVM = target.getBrowserVM();
    if (!sourceBrowserVM || !targetBrowserVM) throw new Error('BROWSERVM_PROVIDER_MISSING');

    const sourceState = await sourceBrowserVM.serializeState();
    const targetBefore = await targetBrowserVM.serializeState();
    expect(sourceState.chainId).toBe(31_337);
    expect(() => validateBrowserVmState(sourceState, 'BROWSERVM_TEST_STATE')).not.toThrow();

    const { chainId: _chainId, ...missingChainId } = sourceState;
    expect(() => validateBrowserVmState(missingChainId, 'BROWSERVM_TEST_STATE'))
      .toThrow('BROWSERVM_TEST_STATE_FIELDS:missing=chainId');
    await expect(targetBrowserVM.restoreState(sourceState))
      .rejects.toThrow('BROWSERVM_STATE_CHAIN_ID_MISMATCH:31337:31338');

    const targetAfter = await targetBrowserVM.serializeState();
    expect(targetAfter).toEqual(targetBefore);
  } finally {
    await Promise.all([source.close(), target.close()]);
  }
}, 30_000);
