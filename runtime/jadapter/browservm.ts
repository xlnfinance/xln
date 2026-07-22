/**
 * BrowserVM JAdapter.
 *
 * BrowserVM is not release evidence for public testnet/mainnet. It is the
 * local visual-debugger/simnet J-machine used by Graph3D, scenarios, and
 * deterministic browser demos. Keep the boundary explicit: runtime code talks
 * to this module through JAdapter only; BrowserVMProvider owns the in-memory
 * EVM details.
 */

import type { LogDescription, Provider, Signer } from 'ethers';
import {
  Account__factory,
  Depository__factory,
  DeltaTransformer__factory,
  EntityProvider__factory,
} from '../../jurisdictions/typechain-types/index.ts';

import { normalizeEntityId } from '../entity/id';
import { getBatchSize, isBatchEmpty } from '../jurisdiction/batch';
import type { BrowserVMState, Env, JTx, RuntimeTx } from '../types';
import {
  CANONICAL_J_EVENTS,
  enqueueJHistoryRange,
  findWatcherJurisdictionReplica,
  getMinimumScannedSignerJHeight,
  isEntityReplicaRelevantToWatcher,
  normalizeAdapterEvents,
  processEventBatch,
  updateWatcherJurisdictionCursor,
  type EventBatchCounter,
  type RawJEvent,
} from './helpers';
import type {
  JAdapter,
  JAdapterConfig,
  JBatchReceipt,
  JEvent,
  JReserveMint,
  JSubmitResult,
  JTokenInfo,
  JWalletSnapshot,
  JWalletSnapshotRequest,
  SnapshotId,
} from './types';
import { makeJAdapterFailureResult } from './failure';
import type { BrowserVmChainCheckpoint, BrowserVMProvider } from './browservm-provider';
import type { AuthenticatedRpcLog } from './receipt-codec';
import {
  assertDepositoryEntityProviderBinding,
  assertJStackAddressMatch,
} from './stack-binding';
import {
  buildCertifiedRegistrationEvidence,
  markLocalJAuthorityRuntimeTx,
} from '../jurisdiction/registration-evidence';
import { assertEntityProviderActionJTxBinding } from '../entity/entity-provider-action';
import { extractCanonicalDepositoryEventArgs } from './depository-event-codec';

const asFactoryRunner = (runner: unknown): Parameters<typeof Account__factory.connect>[1] =>
  runner as Parameters<typeof Account__factory.connect>[1];

const receiptFromEvents = (events: JEvent[]): JBatchReceipt => ({
  txHash: events.find((event) => event.transactionHash && event.transactionHash !== '0x')?.transactionHash ?? '0x',
  blockNumber: events.reduce((max, event) => Math.max(max, Number(event.blockNumber || 0)), 0),
  events,
});

const requireBrowserVmState = (state: BrowserVMState | string): BrowserVMState => {
  if (typeof state !== 'string') return state;
  try {
    return JSON.parse(state) as BrowserVMState;
  } catch {
    throw new Error('BrowserVM loadState requires serialized BrowserVMState JSON or object');
  }
};

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

  const account = Account__factory.connect(addresses.account, asFactoryRunner(signer));
  const depository = Depository__factory.connect(addresses.depository, asFactoryRunner(signer));
  const entityProvider = EntityProvider__factory.connect(addresses.entityProvider, asFactoryRunner(signer));
  const deltaTransformer = DeltaTransformer__factory.connect(addresses.deltaTransformer, asFactoryRunner(signer));

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

  let watcherUnsubscribe: (() => void) | null = null;
  let watcherEnv: Env | null = null;
  let pollInFlight: Promise<void> | null = null;
  let snapshotCounter = 0;
  const snapshots = new Map<SnapshotId, { root: Uint8Array; chain: BrowserVmChainCheckpoint }>();
  const txCounter: EventBatchCounter = { value: 0 };

  const toJEvents = (events: Array<{
    name: string;
    args?: Record<string, unknown>;
    blockNumber?: number;
    blockHash?: string;
    transactionHash?: string;
    logIndex?: number;
  }>): JEvent[] => normalizeAdapterEvents(events);

  const decodeHistoricalLog = (log: AuthenticatedRpcLog): RawJEvent | null => {
    const address = log.address.toLowerCase();
    const carrier = address === addresses.depository.toLowerCase()
      ? depository
      : address === addresses.entityProvider.toLowerCase()
        ? entityProvider
        : null;
    if (!carrier) {
      throw new Error(`BROWSERVM_HISTORICAL_LOG_ADDRESS_UNEXPECTED:${address}`);
    }
    let parsed: LogDescription | null;
    try {
      parsed = carrier.interface.parseLog({ topics: log.topics, data: log.data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `BROWSERVM_HISTORICAL_LOG_DECODE_FAILED:block=${log.blockNumber}` +
        `:tx=${log.transactionHash}:index=${log.logIndex}:${message}`,
      );
    }
    if (!parsed || !CANONICAL_J_EVENTS.some((name) => name === parsed?.name)) return null;
    const args = extractCanonicalDepositoryEventArgs(parsed);
    return {
      name: parsed.name,
      args,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    };
  };

  const pollBrowserVmHistory = async (): Promise<void> => {
    const activeEnv = watcherEnv;
    if (!activeEnv) return;
    const watcherReplica = findWatcherJurisdictionReplica(
      activeEnv,
      addresses.depository,
      config.chainId,
    );
    if (!watcherReplica) {
      throw new Error(`BROWSERVM_WATCHER_JURISDICTION_MISSING:${config.chainId}:${addresses.depository}`);
    }
    const targetBlock = Number(browserVM.getBlockNumber());
    const committedCursor = Number(watcherReplica.blockNumber ?? 0n);
    const minimumLocalScan = getMinimumScannedSignerJHeight(activeEnv, watcherReplica);
    if (!Number.isSafeInteger(targetBlock) || targetBlock < 0) {
      throw new Error(`BROWSERVM_WATCHER_TARGET_INVALID:${String(targetBlock)}`);
    }
    if (!Number.isSafeInteger(committedCursor) || committedCursor < 0) {
      throw new Error(`BROWSERVM_WATCHER_CURSOR_INVALID:${String(committedCursor)}`);
    }
    const nextGlobalBlock = committedCursor + 1;
    const nextReplicaBlock = minimumLocalScan === null ? nextGlobalBlock : minimumLocalScan + 1;
    const fromBlock = Math.max(
      browserVM.getEntityProviderDeploymentBlock(),
      Math.min(nextGlobalBlock, nextReplicaBlock),
    );
    if (fromBlock > targetBlock) return;

    const tipBlockHash = browserVM.getBlockHashAt(targetBlock);
    const headers = Array.from(
      { length: targetBlock - fromBlock + 1 },
      (_, index) => {
        const jHeight = fromBlock + index;
        return { jHeight, jBlockHash: browserVM.getBlockHashAt(jHeight) };
      },
    );
    const logs = await browserVM.getAuthenticatedLogsForRange(
      fromBlock,
      targetBlock,
      [addresses.depository, addresses.entityProvider],
    );
    const byBlock = new Map<number, RawJEvent[]>();
    const authorityTxsByBlock = new Map<number, RuntimeTx[]>();
    for (const log of logs) {
      const decoded = decodeHistoricalLog(log);
      if (!decoded) continue;
      const block = decoded.blockNumber;
      if (!Number.isSafeInteger(block) || Number(block) < fromBlock || Number(block) > targetBlock) {
        throw new Error(`BROWSERVM_HISTORICAL_LOG_HEIGHT_INVALID:${String(block)}`);
      }
      const events = byBlock.get(Number(block)) ?? [];
      events.push(decoded);
      byBlock.set(Number(block), events);
      if (
        log.address.toLowerCase() === addresses.entityProvider.toLowerCase() &&
        (decoded.name === 'EntityRegistered' || decoded.name === 'FoundationBootstrapped')
      ) {
        const evidence = buildCertifiedRegistrationEvidence(
          activeEnv,
          watcherReplica,
          decoded.name,
          log,
          {
            observedThroughHeight: targetBlock,
            observedTipBlockHash: tipBlockHash,
            observedHeadHeight: targetBlock,
            confirmationDepth: 0,
          },
        );
        const tx = markLocalJAuthorityRuntimeTx({
          type: 'recordAuthenticatedJAuthority',
          data: evidence,
        });
        authorityTxsByBlock.set(Number(block), [
          ...(authorityTxsByBlock.get(Number(block)) ?? []),
          tx,
        ]);
      }
    }

    const observedInputs = [];
    const historicalReplicaCatchUp = fromBlock <= committedCursor;
    for (const [blockNumber, events] of [...byBlock.entries()].sort(([left], [right]) => left - right)) {
      events.sort((left, right) => Number(left.logIndex) - Number(right.logIndex));
      const blockHash = events[0]?.blockHash;
      if (!blockHash) throw new Error(`BROWSERVM_HISTORICAL_BLOCK_HASH_MISSING:${blockNumber}`);
      const input = processEventBatch(
        events,
        activeEnv,
        blockNumber,
        blockHash,
        txCounter,
        'browservm',
        addresses.depository,
        true,
        'chain',
        config.chainId,
        historicalReplicaCatchUp,
        authorityTxsByBlock.get(blockNumber) ?? [],
      );
      if (input) observedInputs.push(input);
    }

    const range = enqueueJHistoryRange(
      activeEnv,
      observedInputs,
      targetBlock,
      tipBlockHash,
      addresses.depository,
      headers,
      config.chainId,
    );
    if (observedInputs.length > 0 || range.scannedReplicaKeys.length > 0) {
      updateWatcherJurisdictionCursor(activeEnv, targetBlock, addresses.depository, config.chainId);
    }
    const byReplica = new Map(Object.entries(watcherScanProgress.replicaScannedThrough));
    for (const [key, replica] of activeEnv.eReplicas.entries()) {
      if (!isEntityReplicaRelevantToWatcher(activeEnv, replica, watcherReplica)) continue;
      byReplica.set(key, Math.max(byReplica.get(key) ?? 0, targetBlock));
    }
    watcherScanProgress = {
      scannedThroughHeight: Math.max(watcherScanProgress.scannedThroughHeight, targetBlock),
      replicaScannedThrough: Object.fromEntries([...byReplica.entries()].sort(([left], [right]) => left.localeCompare(right))),
    };
  };

  const pollBrowserVmHistorySerialized = async (): Promise<void> => {
    if (pollInFlight) return await pollInFlight;
    const poll = pollBrowserVmHistory();
    pollInFlight = poll;
    try {
      await poll;
    } finally {
      if (pollInFlight === poll) pollInFlight = null;
    }
  };

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

    async deployStack(): Promise<void> {
      await verifyStackBinding('browservm_deploy');
    },

    async snapshot(): Promise<SnapshotId> {
      const root = await browserVM.captureStateRoot();
      const id = `browservm:${++snapshotCounter}:${Buffer.from(root).toString('hex')}`;
      snapshots.set(id, {
        root: new Uint8Array(root),
        chain: browserVM.captureChainCheckpoint(),
      });
      return id;
    },

    async revert(snapshotId: SnapshotId): Promise<void> {
      const snapshot = snapshots.get(snapshotId);
      if (!snapshot) throw new Error(`BrowserVM snapshot not found: ${snapshotId}`);
      stackBindingVerified = false;
      await browserVM.timeTravel(snapshot.root);
      await browserVM.restoreChainCheckpoint(snapshot.chain);
      await verifyStackBinding('browservm_revert');
    },

    async dumpState(): Promise<BrowserVMState> {
      return await browserVM.serializeState();
    },

    async loadState(state: BrowserVMState | string): Promise<void> {
      stackBindingVerified = false;
      await browserVM.restoreState(requireBrowserVmState(state));
      await verifyStackBinding('browservm_restore');
    },

    async processBlock(): Promise<JEvent[]> {
      return [];
    },

    async getReserves(entityId: string, tokenId: number): Promise<bigint> {
      return await browserVM.getReserves(entityId, tokenId);
    },

    async getCollateral(entityId: string, counterpartyId: string, tokenId: number): Promise<bigint> {
      const collateral = await browserVM.getCollateral(entityId, counterpartyId, tokenId);
      return collateral.collateral;
    },

    async getAccountInfo(entityId: string, counterpartyId: string) {
      return await browserVM.getAccountInfo(entityId, counterpartyId);
    },

    async getEntityNonce(entityId: string): Promise<bigint> {
      return await browserVM.getEntityNonce(normalizeEntityId(entityId));
    },

    async hasProcessedBatch(entityId: string, batchHash: string, entityNonce: bigint): Promise<boolean> {
      return browserVM.hasProcessedBatch(normalizeEntityId(entityId), batchHash, entityNonce);
    },

    async getEntityProviderActionNonce(entityId: string): Promise<bigint> {
      return await browserVM.getEntityProviderActionNonce(normalizeEntityId(entityId));
    },

    async getEntityProviderActionReceipt(entityId: string, actionNonce: bigint): Promise<JEvent | null> {
      const receipt = browserVM.getEntityProviderActionReceipt(normalizeEntityId(entityId), actionNonce);
      return receipt ? toJEvents([receipt])[0] ?? null : null;
    },

    async isEntityRegistered(entityId: string): Promise<boolean> {
      return (await browserVM.getEntityInfo(normalizeEntityId(entityId))).exists;
    },

    async getTokenRegistry(): Promise<JTokenInfo[]> {
      return browserVM.getTokenRegistry();
    },

    async readWalletSnapshot(request: JWalletSnapshotRequest): Promise<JWalletSnapshot> {
      const tokenAddresses = request.tokenAddresses;
      const allowances = request.allowances ?? [];
      return {
        nativeBalance: request.includeNativeBalance === false
          ? null
          : await browserVM.getEthBalance(request.owner),
        tokenBalances: await Promise.all(
          tokenAddresses.map((tokenAddress) => browserVM.getErc20Balance(tokenAddress, request.owner)),
        ),
        allowances: await Promise.all(
          allowances.map((allowance) =>
            browserVM.getErc20Allowance(allowance.tokenAddress, request.owner, allowance.spender)
          ),
        ),
      };
    },

    async getErc20Balance(tokenAddress: string, owner: string): Promise<bigint> {
      return await browserVM.getErc20Balance(tokenAddress, owner);
    },

    async getErc20Balances(tokenAddresses: string[], owner: string): Promise<bigint[]> {
      return await Promise.all(tokenAddresses.map((tokenAddress) => browserVM.getErc20Balance(tokenAddress, owner)));
    },

    async getErc20Allowance(tokenAddress: string, owner: string, spender: string): Promise<bigint> {
      return await browserVM.getErc20Allowance(tokenAddress, owner, spender);
    },

    async getEthBalance(owner: string): Promise<bigint> {
      return await browserVM.getEthBalance(owner);
    },

    async processBatch(encodedBatch: string, hankoData: string, nonce: bigint): Promise<JBatchReceipt> {
      return receiptFromEvents(toJEvents(await browserVM.processBatch(encodedBatch, hankoData, nonce)));
    },

    async enforceDebts(entityId: string, tokenId: number, maxIterations?: number | bigint): Promise<void> {
      await browserVM.enforceDebts(entityId, tokenId, maxIterations);
    },

    async debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<JEvent[]> {
      return toJEvents(await browserVM.debugFundReserves(entityId, tokenId, amount));
    },

    async debugFundReservesBatch(mints: JReserveMint[]): Promise<JEvent[]> {
      const events: JEvent[] = [];
      for (const mint of mints) {
        events.push(...toJEvents(await browserVM.debugFundReserves(mint.entityId, mint.tokenId, mint.amount)));
      }
      return events;
    },

    async externalTokenToReserve(signerPrivateKey, entityId, tokenAddress, amount, options) {
      return toJEvents(await browserVM.externalTokenToReserve(signerPrivateKey, entityId, tokenAddress, amount, options));
    },

    async approveErc20(signerPrivateKey, tokenAddress, spender, amount): Promise<JEvent[]> {
      return toJEvents(await browserVM.approveErc20(signerPrivateKey, tokenAddress, spender, amount));
    },

    async transferErc20(signerPrivateKey, tokenAddress, to, amount): Promise<string> {
      return await browserVM.transferErc20(signerPrivateKey, tokenAddress, to, amount);
    },

    async transferNative(signerPrivateKey, to, amount): Promise<string> {
      return await browserVM.transferNative(signerPrivateKey, to, amount);
    },

    async fundSignerWallet(address: string, amount?: bigint, tokenSymbol?: string): Promise<void> {
      await browserVM.fundSignerWallet(address, amount, tokenSymbol);
    },

    async submitTx(jTx: JTx, options: { env: Env; signerId?: string; signerPrivateKey?: Uint8Array; timestamp?: number }): Promise<JSubmitResult> {
      if (typeof options.timestamp === 'number') browserVM.setBlockTimestamp(options.timestamp);

      if (jTx.type === 'mint') {
        const entityId = String(jTx.data.entityId || jTx.entityId || '');
        const tokenId = Number(jTx.data.tokenId);
        const amount = jTx.data.amount;
        if (!entityId || !Number.isFinite(tokenId) || amount <= 0n) {
          return { success: false, error: 'Invalid mint payload' };
        }
        const events = await adapter.debugFundReserves(entityId, tokenId, amount);
        return { success: true, events, blockNumber: receiptFromEvents(events).blockNumber };
      }

      if (jTx.type === 'debtEnforcement') {
        const entityId = String(jTx.entityId || '').toLowerCase();
        const tokenId = Number(jTx.data.tokenId);
        const maxIterations = BigInt(jTx.data.maxIterations);
        if (!entityId || !Number.isInteger(tokenId) || tokenId < 0 || maxIterations <= 0n) {
          return { success: false, error: 'Invalid debt enforcement payload' };
        }
        await adapter.enforceDebts(entityId, tokenId, maxIterations);
        return { success: true };
      }

      if (
        jTx.type === 'entityProviderTransfer' ||
        jTx.type === 'entityProviderReleaseControlShares' ||
        jTx.type === 'entityProviderCancelAction'
      ) {
        if (!jTx.data.hankoSignature) {
          return {
            success: false,
            error: `ENTITY_PROVIDER_ACTION_CONSENSUS_HANKO_MISSING:${normalizeEntityId(jTx.entityId)}`,
          };
        }
        try {
          assertEntityProviderActionJTxBinding(jTx, {
            chainId: config.chainId,
            entityProviderAddress: addresses.entityProvider,
            depositoryAddress: addresses.depository,
          });
          const events = toJEvents(await browserVM.submitEntityProviderAction(
            jTx.data.intent,
            jTx.data.hankoSignature,
            {
              entityId: normalizeEntityId(jTx.entityId),
              kind: jTx.type === 'entityProviderTransfer'
                ? 'entityTransferTokens'
                : jTx.type === 'entityProviderReleaseControlShares'
                  ? 'releaseControlShares'
                  : 'cancelPendingAction',
            },
          ));
          const receipt = receiptFromEvents(events);
          return {
            success: true,
            txHash: receipt.txHash,
            blockNumber: receipt.blockNumber,
            events,
          };
        } catch (error) {
          return makeJAdapterFailureResult(error);
        }
      }

      if (jTx.type === 'batch') {
        const batchData = jTx.data;
        const batch = batchData.batch;
        if (isBatchEmpty(batch)) return { success: true };
        if (!batchData.hankoSignature || !batchData.encodedBatch || typeof batchData.entityNonce !== 'number') {
          const missing = [
            batchData.hankoSignature ? '' : 'hankoSignature',
            batchData.encodedBatch ? '' : 'encodedBatch',
            typeof batchData.entityNonce === 'number' ? '' : 'entityNonce',
          ].filter(Boolean).join(',');
          return {
            success: false,
            error: `J_BATCH_CONSENSUS_HANKO_MISSING:${normalizeEntityId(jTx.entityId)}:missing=${missing || 'unknown'}`,
          };
        }

        try {
          const externalBatch = batch.externalTokenToReserve.length > 0;
          const rawEvents = externalBatch && options.signerPrivateKey
            ? await browserVM.processBatchAs(
                batchData.encodedBatch,
                batchData.hankoSignature,
                BigInt(batchData.entityNonce),
                options.signerPrivateKey,
              )
            : await browserVM.processBatch(
                batchData.encodedBatch,
                batchData.hankoSignature,
                BigInt(batchData.entityNonce),
              );
          const events = toJEvents(rawEvents);
          const receipt = receiptFromEvents(events);
          console.log(`✅ [JAdapter:browservm] Batch executed (${getBatchSize(batch)} ops) block=${receipt.blockNumber}`);
          return { success: true, txHash: receipt.txHash, blockNumber: receipt.blockNumber, events };
        } catch (error) {
          return makeJAdapterFailureResult(error);
        }
      }

      const unhandled: never = jTx;
      return { success: false, error: `Unhandled JTx type: ${(unhandled as { type?: string }).type}` };
    },

    startWatching(env: Env): void {
      if (!stackBindingVerified) {
        throw new Error(`J_STACK_BINDING_UNVERIFIED:browservm:chainId=${config.chainId}`);
      }
      if (watcherUnsubscribe) return;
      watcherEnv = env;
      watcherUnsubscribe = browserVM.onAny(async () => {
        if (!watcherEnv) return;
        await pollBrowserVmHistorySerialized();
      });
    },

    isWatching(): boolean {
      return watcherUnsubscribe !== null;
    },

    stopWatching(): void {
      watcherUnsubscribe?.();
      watcherUnsubscribe = null;
      watcherEnv = null;
    },

    async stopWatchingAndWait(): Promise<void> {
      adapter.stopWatching();
      const inFlight = pollInFlight;
      if (inFlight) await inFlight;
    },

    async pollNow(): Promise<void> {
      await pollBrowserVmHistorySerialized();
    },

    getBrowserVM(): BrowserVMProvider {
      return browserVM;
    },

    setBlockTimestamp(timestamp: number): void {
      browserVM.setBlockTimestamp(timestamp);
    },

    setQuietLogs(quiet: boolean): void {
      browserVM.setQuietLogs(quiet);
    },

    registerEntityWallet(entityId: string, privateKey: string): void {
      browserVM.registerEntityWallet(entityId, privateKey);
    },

    async captureStateRoot(): Promise<Uint8Array> {
      return await browserVM.captureStateRoot();
    },

    async getCurrentBlockNumber(): Promise<number> {
      return Number(browserVM.getBlockNumber());
    },

    getWatcherScanProgress() {
      return watcherScanProgress;
    },

    getFinalityDepth(): number {
      return 0;
    },

    async syncRuntimeState(accountPairs, tokenIds) {
      return {
        collaterals: await browserVM.syncAllCollaterals(accountPairs, tokenIds),
        blockNumber: BigInt(browserVM.getBlockNumber()),
      };
    },

    async close(): Promise<void> {
      await adapter.stopWatchingAndWait();
    },
  };

  let watcherScanProgress = {
    scannedThroughHeight: 0,
    replicaScannedThrough: {} as Record<string, number>,
  };

  return adapter;
}
