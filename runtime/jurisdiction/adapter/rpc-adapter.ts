import type { Provider, Signer } from 'ethers';
import { ethers } from 'ethers';
import type { BrowserVMProvider, JAdapter, JAdapterConfig } from './types';
import { DEV_CHAIN_IDS } from './chain-ids';
import { createRpcChainIo } from './rpc-chain-io';
import { createRpcContractStack } from './rpc-contract-stack';
import { createRpcLifecycleMethods } from './rpc-lifecycle';
import { readAndAssertRpcChainId } from './rpc-network';
import {
  isTransientRpcUnavailableError,
  resolveDisputeFinalizationEvidence,
} from './rpc-public';
import { createRpcReadMethods } from './rpc-reads';
import { createRpcReceiptReaders } from './rpc-receipts';
import { createRpcSubmitTx } from './rpc-submission';
import { createRpcTransactionSequencer } from './rpc-transaction-sequencer';
import { createRpcWalletWriteMethods } from './rpc-wallet-writes';
import { createRpcWatcherController } from './rpc-watcher-controller';
import { createTxFinalizationEvidenceReader } from './rpc-watcher-inputs';
import { createRpcWriteMethods } from './rpc-write-methods';
import { asRpcTxResponse } from './rpc-boundary';

export async function createRpcAdapter(
  config: JAdapterConfig,
  provider: ethers.JsonRpcProvider,
  signer: Signer,
): Promise<JAdapter> {
  const traceEnabled = process.env['JADAPTER_TRACE'] === '1';
  const trace = (phase: string, extra?: Record<string, unknown>): void => {
    if (traceEnabled) {
      console.log(`[JAdapter:rpc][trace] ${phase}${extra ? ` ${JSON.stringify(extra)}` : ''}`);
    }
  };
  trace('provider.eth_chainId:start');
  const rpcChainId = await readAndAssertRpcChainId(provider, config.chainId);
  trace('provider.eth_chainId:done', { rpcChainId, configChainId: Number(config.chainId) });

  const chainIo = createRpcChainIo(config, provider, signer);
  const stack = await createRpcContractStack(config, provider, signer, chainIo);
  const sequencer = createRpcTransactionSequencer({
    provider,
    primarySigner: signer,
    usesEvmNonce: config.mode !== 'tron',
    buildFeeOverrides: chainIo.buildFeeOverrides,
    waitForReceipt: chainIo.waitForReceipt,
  });
  const receipts = createRpcReceiptReaders(provider, stack);
  let quietLogs = false;
  const writes = createRpcWriteMethods({
    config,
    provider,
    signer,
    chainIo,
    stack,
    sequencer,
    mintDebugEnabled: process.env['XLN_JADAPTER_MINT_DEBUG'] === '1',
    isQuiet: () => quietLogs,
  });
  const readTxFinalizationEvidence = createTxFinalizationEvidenceReader(provider);
  const watcher = createRpcWatcherController({
    provider,
    chainId: config.chainId,
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    get depositoryAddress() { return stack.addresses.depository; },
    get entityProviderAddress() { return stack.addresses.entityProvider; },
    getDepository: () => stack.depository,
    getEntityProvider: () => stack.entityProvider,
    getLiveDepositoryAddress: stack.getDepositoryAddress,
    getLiveEntityProviderAddress: stack.getEntityProviderAddress,
    assertStackBindingVerified: () => {
      if (!stack.bindingVerified) {
        throw new Error(`J_STACK_BINDING_UNVERIFIED:rpc:chainId=${config.chainId}`);
      }
    },
    readCurrentBlockNumber: chainIo.readCurrentBlockNumber,
    readSafeBlockNumber: chainIo.readSafeBlockNumber,
    readBlockHeaders: chainIo.readBlockHeaders,
    sendAuthenticatedBatch: chainIo.sendAuthenticatedBatch,
    resolveFinalityDepth: chainIo.resolveFinalityDepth,
    resolveDisputeFinalizationEvidence: async (txHash, args) =>
      resolveDisputeFinalizationEvidence(await readTxFinalizationEvidence(txHash), txHash, args),
    isTransientRpcUnavailable: isTransientRpcUnavailableError,
  });
  const lifecycle = createRpcLifecycleMethods({
    provider,
    chainId: config.chainId,
    ...(config.stateFile ? { stateFile: config.stateFile } : {}),
    markStackBindingUnverified: stack.markBindingUnverified,
    verifyStackBinding: stack.verifyBinding,
  });
  const reads = createRpcReadMethods({
    provider,
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    get depository() { return stack.depository; },
    get entityProvider() { return stack.entityProvider; },
    ...receipts,
  });
  const walletWrites = createRpcWalletWriteMethods({
    provider,
    signerForPrivateKey: chainIo.signerForPrivateKey,
    buildFeeOverrides: chainIo.buildFeeOverrides,
    waitForReceipt: chainIo.waitForReceipt,
    asRpcTxResponse,
    runSerializedBatchFor: sequencer.runFor,
    sendSignerTxWithExplicitNonce: sequencer.send,
  });
  let closePromise: Promise<void> | null = null;
  const adapter: JAdapter = {
    mode: config.mode,
    chainId: config.chainId,
    provider,
    signer,
    get account() { return stack.account; },
    get depository() { return stack.depository; },
    get entityProvider() { return stack.entityProvider; },
    get deltaTransformer() { return stack.deltaTransformer; },
    get addresses() { return stack.addresses; },
    get entityProviderDeploymentBlock() { return stack.entityProviderDeploymentBlock; },
    deployStack: stack.deploy,
    ...lifecycle,
    ...reads,
    ...writes,
    ...walletWrites,
    submitTx: createRpcSubmitTx({
      config,
      signer,
      watchOnly: Boolean(config.watchOnly && !DEV_CHAIN_IDS.has(config.chainId)),
      chainIo,
      stack,
      sequencer,
      receipts,
      writes,
    }),
    ...watcher,
    getBrowserVM(): BrowserVMProvider | null { return null; },
    setQuietLogs(quiet: boolean): void { quietLogs = quiet; },
    getCurrentBlockNumber: chainIo.readSafeBlockNumber,
    getFinalityDepth: () => chainIo.resolveFinalityDepth(false),
    close(): Promise<void> {
      closePromise ??= (async () => {
        await watcher.stopWatchingAndWait();
        stack.removeAllListeners();
        const lifecycleProvider = provider as Provider & { destroy?: () => void | Promise<void> };
        if (typeof lifecycleProvider.destroy === 'function') await lifecycleProvider.destroy();
      })();
      return closePromise;
    },
  };
  trace('return adapter');
  return adapter;
}
