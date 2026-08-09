import type { Depository, EntityProvider } from '../../../jurisdictions/typechain-types/index.ts';
import type { RuntimeReplica, RuntimeTx } from '../../runtime/types';
import {
  enqueueJHistoryRange,
  findWatcherJurisdictionReplica,
  getMinimumScannedSignerJHeight,
  isEntityReplicaRelevantToWatcher,
  processEventBatch,
  updateWatcherJurisdictionCursor,
  type EventBatchCounter,
} from './watcher';
import type { JEventIngress } from './types';
import type { BrowserVMProvider } from './browservm-provider';
import type { AuthenticatedRpcLog } from '../machine/receipt-codec';
import {
  buildCertifiedRegistrationEvidence,
  markLocalJAuthorityRuntimeTx,
} from '../machine/registration-evidence';
import { CANONICAL_J_EVENTS } from '../machine/event-catalog';
import { decodeJEventLog } from './j-event-log-decoder';
import {
  decodeDisputeFinalizationEvidenceCalldata,
  decodeDisputeProofBodyEvidenceCalldata,
  resolveDisputeFinalizationEvidence,
  resolveDisputeProofBodyEvidence,
} from './rpc-public';

type BrowserVmHistoryOptions = {
  chainId: number;
  depositoryAddress: string;
  entityProviderAddress: string;
  depository: Depository;
  entityProvider: EntityProvider;
  browserVM: BrowserVMProvider;
};

type BrowserVmWatcherProgress = {
  scannedThroughHeight: number;
  replicaScannedThrough: Record<string, number>;
};

const decodeHistoricalLog = (options: BrowserVmHistoryOptions, log: AuthenticatedRpcLog): JEventIngress | null => {
  const address = log.address.toLowerCase();
  const carrier =
    address === options.depositoryAddress.toLowerCase()
      ? options.depository
      : address === options.entityProviderAddress.toLowerCase()
        ? options.entityProvider
        : null;
  if (!carrier) throw new Error(`BROWSERVM_HISTORICAL_LOG_ADDRESS_UNEXPECTED:${address}`);
  const event = decodeJEventLog(
    log,
    carrier.interface,
    {
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    },
    `BROWSERVM_HISTORICAL_LOG_DECODE_FAILED:block=${log.blockNumber}` +
      `:tx=${log.transactionHash}:index=${log.logIndex}`,
  );
  if (
    event.name === 'DisputeStarted' ||
    event.name === 'CounterDisputeRegistered' ||
    event.name === 'DisputeFinalized'
  ) {
    const receipt = options.browserVM.getTransactionReceipt(log.transactionHash);
    if (!receipt) {
      throw new Error(`BROWSERVM_DISPUTE_RECEIPT_MISSING:${log.transactionHash}`);
    }
    const proofbody = resolveDisputeProofBodyEvidence(
      decodeDisputeProofBodyEvidenceCalldata(receipt.data),
      event.name,
      event.args,
    );
    event.args[
      event.name === 'DisputeStarted'
        ? 'initialProofbody'
        : event.name === 'CounterDisputeRegistered'
          ? 'counterProofbody'
          : 'finalProofbody'
    ] = proofbody;
    if (event.name === 'DisputeFinalized') {
      event.disputeFinalizationEvidence = resolveDisputeFinalizationEvidence(
        decodeDisputeFinalizationEvidenceCalldata(receipt.data),
        log.transactionHash,
        event.args,
      );
    }
  }
  return CANONICAL_J_EVENTS.some(name => name === event.name) ? event : null;
};

const buildHistoryHeaders = (
  browserVM: BrowserVMProvider,
  fromBlock: number,
  targetBlock: number,
): Array<{ jHeight: number; jBlockHash: string }> =>
  Array.from({ length: targetBlock - fromBlock + 1 }, (_, index) => {
    const jHeight = fromBlock + index;
    return { jHeight, jBlockHash: browserVM.getBlockHashAt(jHeight) };
  });

const collectHistoricalEvents = (
  options: BrowserVmHistoryOptions,
  env: RuntimeReplica,
  logs: AuthenticatedRpcLog[],
  fromBlock: number,
  targetBlock: number,
  tipBlockHash: string,
): {
  byBlock: Map<number, JEventIngress[]>;
  authorityTxsByBlock: Map<number, RuntimeTx[]>;
} => {
  const byBlock = new Map<number, JEventIngress[]>();
  const authorityTxsByBlock = new Map<number, RuntimeTx[]>();
  const watcherReplica = findWatcherJurisdictionReplica(env, options.depositoryAddress, options.chainId);
  if (!watcherReplica) {
    throw new Error(`BROWSERVM_WATCHER_JURISDICTION_MISSING:${options.chainId}:${options.depositoryAddress}`);
  }
  for (const log of logs) {
    const event = decodeHistoricalLog(options, log);
    if (!event) continue;
    const block = Number(event.blockNumber);
    if (!Number.isSafeInteger(block) || block < fromBlock || block > targetBlock) {
      throw new Error(`BROWSERVM_HISTORICAL_LOG_HEIGHT_INVALID:${String(event.blockNumber)}`);
    }
    const events = byBlock.get(block) ?? [];
    events.push(event);
    byBlock.set(block, events);
    if (
      log.address.toLowerCase() === options.entityProviderAddress.toLowerCase() &&
      (event.name === 'EntityRegistered' || event.name === 'FoundationBootstrapped')
    ) {
      const evidence = buildCertifiedRegistrationEvidence(env, watcherReplica, event.name, log, {
        observedThroughHeight: targetBlock,
        observedTipBlockHash: tipBlockHash,
        observedHeadHeight: targetBlock,
        confirmationDepth: 0,
      });
      authorityTxsByBlock.set(block, [
        ...(authorityTxsByBlock.get(block) ?? []),
        markLocalJAuthorityRuntimeTx({
          type: 'recordAuthenticatedJAuthority',
          data: evidence,
        }),
      ]);
    }
  }
  return { byBlock, authorityTxsByBlock };
};

const buildObservedInputs = (
  options: BrowserVmHistoryOptions,
  env: RuntimeReplica,
  byBlock: Map<number, JEventIngress[]>,
  authorityTxsByBlock: Map<number, RuntimeTx[]>,
  txCounter: EventBatchCounter,
  historicalReplicaCatchUp: boolean,
) => {
  const inputs = [];
  for (const [blockNumber, events] of [...byBlock.entries()].sort(([left], [right]) => left - right)) {
    events.sort((left, right) => Number(left.logIndex) - Number(right.logIndex));
    const blockHash = events[0]?.blockHash;
    if (!blockHash) throw new Error(`BROWSERVM_HISTORICAL_BLOCK_HASH_MISSING:${blockNumber}`);
    const input = processEventBatch(
      events,
      env,
      blockNumber,
      blockHash,
      txCounter,
      'browservm',
      options.depositoryAddress,
      true,
      'chain',
      options.chainId,
      historicalReplicaCatchUp,
      authorityTxsByBlock.get(blockNumber) ?? [],
    );
    if (input) inputs.push(input);
  }
  return inputs;
};

export const createBrowserVmHistoryWatcher = (options: BrowserVmHistoryOptions) => {
  let watcherUnsubscribe: (() => void) | null = null;
  let watcherEnv: RuntimeReplica | null = null;
  let pollInFlight: Promise<void> | null = null;
  let progress: BrowserVmWatcherProgress = {
    scannedThroughHeight: 0,
    replicaScannedThrough: {},
  };
  const txCounter: EventBatchCounter = { value: 0 };

  const poll = async (): Promise<void> => {
    const env = watcherEnv;
    if (!env) return;
    const watcherReplica = findWatcherJurisdictionReplica(env, options.depositoryAddress, options.chainId);
    if (!watcherReplica) {
      throw new Error(`BROWSERVM_WATCHER_JURISDICTION_MISSING:${options.chainId}:${options.depositoryAddress}`);
    }
    const targetBlock = Number(options.browserVM.getBlockNumber());
    const committedCursor = Number(watcherReplica.blockNumber ?? 0n);
    const minimumLocalScan = getMinimumScannedSignerJHeight(env, watcherReplica);
    if (!Number.isSafeInteger(targetBlock) || targetBlock < 0) {
      throw new Error(`BROWSERVM_WATCHER_TARGET_INVALID:${String(targetBlock)}`);
    }
    if (!Number.isSafeInteger(committedCursor) || committedCursor < 0) {
      throw new Error(`BROWSERVM_WATCHER_CURSOR_INVALID:${String(committedCursor)}`);
    }
    const fromBlock = Math.max(
      options.browserVM.getEntityProviderDeploymentBlock(),
      Math.min(committedCursor + 1, minimumLocalScan === null ? committedCursor + 1 : minimumLocalScan + 1),
    );
    if (fromBlock > targetBlock) return;
    const tipBlockHash = options.browserVM.getBlockHashAt(targetBlock);
    const logs = await options.browserVM.getAuthenticatedLogsForRange(fromBlock, targetBlock, [
      options.depositoryAddress,
      options.entityProviderAddress,
    ]);
    const { byBlock, authorityTxsByBlock } = collectHistoricalEvents(
      options,
      env,
      logs,
      fromBlock,
      targetBlock,
      tipBlockHash,
    );
    const observedInputs = buildObservedInputs(
      options,
      env,
      byBlock,
      authorityTxsByBlock,
      txCounter,
      fromBlock <= committedCursor,
    );
    const range = enqueueJHistoryRange(
      env,
      observedInputs,
      targetBlock,
      tipBlockHash,
      options.depositoryAddress,
      buildHistoryHeaders(options.browserVM, fromBlock, targetBlock),
      options.chainId,
    );
    if (observedInputs.length > 0 || range.scannedReplicaKeys.length > 0) {
      updateWatcherJurisdictionCursor(env, targetBlock, options.depositoryAddress, options.chainId);
    }
    const byReplica = new Map(Object.entries(progress.replicaScannedThrough));
    for (const [key, replica] of env.state.eReplicas.entries()) {
      if (!isEntityReplicaRelevantToWatcher(env, replica, watcherReplica)) continue;
      byReplica.set(key, Math.max(byReplica.get(key) ?? 0, targetBlock));
    }
    progress = {
      scannedThroughHeight: Math.max(progress.scannedThroughHeight, targetBlock),
      replicaScannedThrough: Object.fromEntries(
        [...byReplica.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
  };

  const pollSerialized = async (): Promise<void> => {
    if (pollInFlight) return await pollInFlight;
    const currentPoll = poll();
    pollInFlight = currentPoll;
    try {
      await currentPoll;
    } finally {
      if (pollInFlight === currentPoll) pollInFlight = null;
    }
  };

  const stopWatching = (): void => {
    watcherUnsubscribe?.();
    watcherUnsubscribe = null;
    watcherEnv = null;
  };

  return {
    startWatching(env: RuntimeReplica): void {
      if (watcherUnsubscribe) return;
      watcherEnv = env;
      watcherUnsubscribe = options.browserVM.onAny(async () => {
        if (watcherEnv) await pollSerialized();
      });
    },
    isWatching: (): boolean => watcherUnsubscribe !== null,
    stopWatching,
    async stopWatchingAndWait(): Promise<void> {
      stopWatching();
      if (pollInFlight) await pollInFlight;
    },
    pollNow: pollSerialized,
    getProgress: (): BrowserVmWatcherProgress => progress,
  };
};
