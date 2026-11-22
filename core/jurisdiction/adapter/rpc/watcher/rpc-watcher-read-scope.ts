import type { Signer, ethers } from 'ethers';
import { readBooleanEnv, readPositiveIntegerEnv } from '../../../../config/environment';
import { MAX_RPC_BATCH_CALLS } from '../../rpc-utils';
import type { JAdapterConfig } from '../../types';
import { watcherPollWindowLimit } from '../../watcher/observe/watcher-poll-policy';
import { createRpcChainIo } from '../rpc-chain-io';
import type { RpcContractStack } from '../rpc-contract-stack';
import { createRpcBlockRangeReader, createRpcReceiptBatch } from './rpc-watcher-block-range';
import type { RpcWatcherReadScope } from './rpc-watcher-types';

type WatchProfile = {
  pollWindowLimit?: number;
  headerBatchCalls?: number;
  blockRange?: boolean;
  receiptBatchCalls?: number;
};

export const readRpcWatcherProfile = (config: JAdapterConfig): WatchProfile => {
  if (config.mode !== 'rpc') return {};
  const pollLimitName = 'XLN_J_WATCHER_RPC_MAX_BLOCKS_PER_POLL';
  const configuredLimit = process.env[`${pollLimitName}_${config.chainId}`] ?? process.env[pollLimitName];
  const batchLimitName = 'XLN_J_WATCHER_RPC_HEADER_BATCH_CALLS';
  const headerBatchCalls = process.env[batchLimitName] === undefined
    ? undefined : readPositiveIntegerEnv(batchLimitName, MAX_RPC_BATCH_CALLS);
  if (headerBatchCalls !== undefined && headerBatchCalls > MAX_RPC_BATCH_CALLS)
    throw new Error('RPC_BATCH_CALL_LIMIT_INVALID');
  const receiptSizeName = `XLN_J_WATCHER_RPC_RECEIPT_BATCH_CALLS_${config.chainId}`;
  const receiptBatchCalls = process.env[receiptSizeName] === undefined
    ? undefined : readPositiveIntegerEnv(receiptSizeName, MAX_RPC_BATCH_CALLS);
  if (receiptBatchCalls !== undefined && receiptBatchCalls > MAX_RPC_BATCH_CALLS)
    throw new Error('RPC_RECEIPT_BATCH_CALL_LIMIT_INVALID');
  return {
    ...(configuredLimit === undefined ? {} : { pollWindowLimit: watcherPollWindowLimit(config.mode, configuredLimit) }),
    ...(headerBatchCalls === undefined ? {} : { headerBatchCalls }),
    ...(receiptBatchCalls === undefined ? {} : { receiptBatchCalls }),
    blockRange: readBooleanEnv(`XLN_J_WATCHER_RPC_BLOCK_RANGE_${config.chainId}`, false),
  };
};

export const openRpcWatcherReadScope = (
  config: JAdapterConfig,
  provider: ethers.JsonRpcProvider,
  signer: Signer,
  stack: RpcContractStack,
  profile: WatchProfile,
  signal: AbortSignal,
  isTransientRpcUnavailable: (error: unknown) => boolean,
): RpcWatcherReadScope => {
  const { blockRange, receiptBatchCalls, ...window } = profile;
  const chainIo = createRpcChainIo(config, provider, signer, window.headerBatchCalls, signal);
  return {
    close: () => provider.destroy(),
    services: {
      provider,
      mode: config.mode,
      chainId: config.chainId,
      ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
      ...(config.watchPollMs === undefined ? {} : { watchPollMs: config.watchPollMs }),
      ...window,
      ...(blockRange ? { readReceiptBlockRange: createRpcBlockRangeReader(config.rpcUrl ?? '', signal) } : {}),
      ...(receiptBatchCalls === undefined ? {}
        : { receiptBatch: createRpcReceiptBatch(config.rpcUrl ?? '', receiptBatchCalls, signal) }),
      get depositoryAddress() { return stack.addresses.depository; },
      get entityProviderAddress() { return stack.addresses.entityProvider; },
      getDepository: () => stack.depository.connect(provider),
      getEntityProvider: () => stack.entityProvider.connect(provider),
      getLiveDepositoryAddress: stack.getDepositoryAddress,
      getLiveEntityProviderAddress: stack.getEntityProviderAddress,
      assertStackBindingVerified: () => {
        if (!stack.bindingVerified) throw new Error(`J_STACK_BINDING_UNVERIFIED:rpc:chainId=${config.chainId}`);
      },
      readCurrentBlockNumber: chainIo.readCurrentBlockNumber,
      readSafeBlockNumber: chainIo.readSafeBlockNumber,
      readBlockHeaders: chainIo.readBlockHeaders,
      sendAuthenticatedBatch: chainIo.sendAuthenticatedBatch,
      resolveFinalityDepth: chainIo.resolveFinalityDepth,
      isTransientRpcUnavailable,
    },
  };
};
