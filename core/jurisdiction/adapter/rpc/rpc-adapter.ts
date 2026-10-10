import {
  createNativeTronClient,
  createSolidifiedTronTransactionReader,
  readTronExpiryEvidence,
} from '../operations/tron-authority';
import { broadcastPreparedRpcTransaction } from './write/prepared/prepared-broadcast';
import type { Provider, Signer } from 'ethers';
import { ethers } from 'ethers';
import type { BrowserVMProvider, JAdapter, JAdapterConfig } from '../types';
import { DEV_CHAIN_IDS } from '../chain-ids';
import { createRpcChainIo } from './rpc-chain-io';
import { createRpcContractStack } from './rpc-contract-stack';
import { createRpcLifecycleMethods } from './rpc-lifecycle';
import { readAndAssertRpcChainId } from './rpc-network';
import {
  isTransientRpcUnavailableError,
  resolveDisputeFinalizationEvidence,
} from '../rpc-public';
import { ReceiptAvailabilityError } from '../receipt-root';
import { isRpcTransportUnavailable } from '../kernel/failure';
import { createRpcReadMethods } from './rpc-reads';
import { createRpcReceiptReaders } from './rpc-receipts';
import { createRpcSubmitTx } from './write/rpc-submission';
import { createRpcTransactionSequencer } from './write/rpc-transaction-sequencer';
import { createRpcWalletWriteMethods } from './wallet/rpc-wallet-writes';
import { createRpcWatcherController } from './watcher/rpc-watcher-controller';
import {
  createTxDisputeProofBodyReader,
  createTxFinalizationEvidenceReader,
} from '../rpc-watcher-inputs';
import { createRpcWriteMethods } from './write/rpc-write-methods';
import { prepareDurableTransaction } from './write/prepared/durable-transaction';

export const isRpcWatcherTransientError = (error: unknown): boolean =>
  error instanceof ReceiptAvailabilityError ||
  isRpcTransportUnavailable(error) ||
  isTransientRpcUnavailableError(error);

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
  const readNativeTronTransaction = config.mode === 'tron' ? createSolidifiedTronTransactionReader(config) : undefined;
  const readTxFinalizationEvidence = createTxFinalizationEvidenceReader(provider, readNativeTronTransaction);
  const readTxDisputeProofBody = createTxDisputeProofBodyReader(provider, readNativeTronTransaction);
  const watcher = createRpcWatcherController({
    provider,
    mode: config.mode,
    chainId: config.chainId,
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    ...(config.watchPollMs === undefined ? {} : { watchPollMs: config.watchPollMs }),
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
    resolveDisputeFinalizationEvidence: async (txHash, args, location) =>
      resolveDisputeFinalizationEvidence(await readTxFinalizationEvidence(txHash, location), txHash, args),
    resolveDisputeProofBody: readTxDisputeProofBody,
    isTransientRpcUnavailable: isRpcWatcherTransientError,
  });
  const lifecycle = createRpcLifecycleMethods({
    provider,
    chainId: config.chainId,
    ...(config.stateFile ? { stateFile: config.stateFile } : {}),
    markStackBindingUnverified: stack.markBindingUnverified,
    verifyStackBinding: stack.verifyBinding,
  });
  const reads = createRpcReadMethods({
    config,
    provider,
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    get depository() { return stack.depository; },
    get entityProvider() { return stack.entityProvider; },
    ...receipts,
  });
  const walletWrites = createRpcWalletWriteMethods({
    provider,
    signerForPrivateKey: chainIo.signerForPrivateKey,
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
    setPendingSignedTransactionSource: sequencer.setPendingSignedTransactionSource,
    getTronExpiryEvidence: async raw => readTronExpiryEvidence(await createNativeTronClient(config), provider, raw),
    broadcastPreparedTransaction: raw => broadcastPreparedRpcTransaction(config, provider, raw),
    async prepareDurableTransaction(signerPrivateKey, request, accept) {
      const activeSigner = await chainIo.signerForPrivateKey(ethers.hexlify(signerPrivateKey));
      return prepareDurableTransaction({
        signer: activeSigner,
        nativeTron: config.mode === 'tron',
        request,
        accept,
        sequencer,
        buildOverrides: chainIo.buildFeeOverrides,
      });
    },
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
