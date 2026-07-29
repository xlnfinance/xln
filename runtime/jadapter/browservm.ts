/**
 * BrowserVM JAdapter.
 *
 * BrowserVM is not release evidence for public testnet/mainnet. It is the
 * local visual-debugger/simnet J-machine used by Graph3D, scenarios, and
 * deterministic browser demos. Keep the boundary explicit: runtime code talks
 * to this module through JAdapter only; BrowserVMProvider owns the in-memory
 * EVM details.
 */

import type { Provider, Signer } from 'ethers';
import {
  Account__factory,
  Depository__factory,
  DeltaTransformer__factory,
  EntityProvider__factory,
} from '../../jurisdictions/typechain-types/index.ts';

import type { RuntimeState } from '../types';
import type {
  JAdapter,
  JAdapterConfig,
} from './types';
import type { BrowserVMProvider } from './browservm-provider';
import {
  assertDepositoryEntityProviderBinding,
  assertJStackAddressMatch,
} from './stack-binding';
import { createBrowserVmHistoryWatcher } from './browservm-history';
import {
  createBrowserVmSubmitTx,
} from './browservm-submit';
import { createBrowserVmStateMethods } from './browservm-state-methods';
import { createBrowserVmIoMethods } from './browservm-io';

export async function createBrowserVMAdapter(
  config: JAdapterConfig,
  provider: Provider,
  signer: Signer,
  browserVM: BrowserVMProvider,
): Promise<JAdapter> {
  if (config.fromReplica && !config.browserVMState) {
    throw new Error('BrowserVM cannot attach to fromReplica without browserVMState');
  }

  const addresses = {
    account: browserVM.getAccountAddress(),
    depository: browserVM.getDepositoryAddress(),
    entityProvider: browserVM.getEntityProviderAddress(),
    deltaTransformer: browserVM.getDeltaTransformerAddress(),
  };

  const account = Account__factory.connect(addresses.account, signer);
  const depository = Depository__factory.connect(addresses.depository, signer);
  const entityProvider = EntityProvider__factory.connect(addresses.entityProvider, signer);
  const deltaTransformer = DeltaTransformer__factory.connect(addresses.deltaTransformer, signer);

  let stackBindingVerified = false;
  const verifyStackBinding = async (context: string): Promise<void> => {
    stackBindingVerified = false;
    assertJStackAddressMatch(
      `${context}:depository`,
      addresses.depository,
      browserVM.getDepositoryAddress(),
    );
    assertJStackAddressMatch(
      `${context}:entity_provider`,
      addresses.entityProvider,
      browserVM.getEntityProviderAddress(),
    );
    await assertDepositoryEntityProviderBinding(context, depository, addresses.entityProvider);
    stackBindingVerified = true;
  };
  await verifyStackBinding('browservm_connect');

  const historyWatcher = createBrowserVmHistoryWatcher({
    chainId: config.chainId,
    depositoryAddress: addresses.depository,
    entityProviderAddress: addresses.entityProvider,
    depository,
    entityProvider,
    browserVM,
  });
  const submitTx = createBrowserVmSubmitTx({
    chainId: config.chainId,
    addresses,
    browserVM,
  });
  const stateMethods = createBrowserVmStateMethods(
    browserVM,
    () => {
      stackBindingVerified = false;
    },
    verifyStackBinding,
  );
  const ioMethods = createBrowserVmIoMethods(browserVM);

  const adapter: JAdapter = {
    mode: 'browservm',
    chainId: config.chainId,
    provider,
    signer,
    account,
    depository,
    entityProvider,
    deltaTransformer,
    addresses,
    get entityProviderDeploymentBlock() { return browserVM.getEntityProviderDeploymentBlock(); },
    ...stateMethods,
    ...ioMethods,

    submitTx,

    startWatching(env: RuntimeState): void {
      if (!stackBindingVerified) {
        throw new Error(`J_STACK_BINDING_UNVERIFIED:browservm:chainId=${config.chainId}`);
      }
      historyWatcher.startWatching(env);
    },

    isWatching(): boolean {
      return historyWatcher.isWatching();
    },

    stopWatching(): void {
      historyWatcher.stopWatching();
    },

    async stopWatchingAndWait(): Promise<void> {
      await historyWatcher.stopWatchingAndWait();
    },

    async pollNow(): Promise<void> {
      await historyWatcher.pollNow();
    },

    getWatcherScanProgress() {
      return historyWatcher.getProgress();
    },

    async close(): Promise<void> {
      await adapter.stopWatchingAndWait();
    },
  };

  return adapter;
}
