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

import { normalizeEntityId } from '../entity/id';
import { getBatchSize, isBatchEmpty } from '../jurisdiction/batch';
import { setDeltaTransformerAddress } from '../protocol/dispute/proof-builder';
import type { BrowserVMState, Env, JTx } from '../types';
import { normalizeAdapterEvents, processEventBatch, type EventBatchCounter, type RawJEvent } from './helpers';
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
import type { BrowserVMProvider } from './browservm-provider';

const asFactoryRunner = (runner: unknown): Parameters<typeof Account__factory.connect>[1] =>
  runner as Parameters<typeof Account__factory.connect>[1];

const eventsToRaw = (events: JEvent[]): RawJEvent[] =>
  events.map((event) => ({
    name: event.name,
    args: event.args as RawJEvent['args'],
    blockNumber: event.blockNumber,
    blockHash: event.blockHash,
    transactionHash: event.transactionHash,
  }));

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

  let watcherUnsubscribe: (() => void) | null = null;
  let watcherEnv: Env | null = null;
  let snapshotCounter = 0;
  const snapshots = new Map<SnapshotId, Uint8Array>();
  const txCounter: EventBatchCounter = { value: 0 };

  const toJEvents = (events: Array<{
    name: string;
    args?: Record<string, unknown>;
    blockNumber?: number;
    blockHash?: string;
    transactionHash?: string;
  }>): JEvent[] => normalizeAdapterEvents(events);

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

    async deployStack(): Promise<void> {
      setDeltaTransformerAddress(addresses.deltaTransformer);
    },

    async snapshot(): Promise<SnapshotId> {
      const root = await browserVM.captureStateRoot();
      const id = `browservm:${++snapshotCounter}:${Buffer.from(root).toString('hex')}`;
      snapshots.set(id, new Uint8Array(root));
      return id;
    },

    async revert(snapshotId: SnapshotId): Promise<void> {
      const root = snapshots.get(snapshotId);
      if (!root) throw new Error(`BrowserVM snapshot not found: ${snapshotId}`);
      await browserVM.timeTravel(root);
    },

    async dumpState(): Promise<BrowserVMState> {
      return await browserVM.serializeState();
    },

    async loadState(state: BrowserVMState | string): Promise<void> {
      await browserVM.restoreState(requireBrowserVmState(state));
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

    async getDebts(entityId: string, tokenId: number) {
      return await browserVM.getDebts(entityId, tokenId);
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

    async fundSignerWallet(address: string, amount?: bigint): Promise<void> {
      await browserVM.fundSignerWallet(address, amount);
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
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      }

      const unhandled: never = jTx;
      return { success: false, error: `Unhandled JTx type: ${(unhandled as { type?: string }).type}` };
    },

    startWatching(env: Env): void {
      if (watcherUnsubscribe) return;
      watcherEnv = env;
      watcherUnsubscribe = browserVM.onAny((events) => {
        const activeEnv = watcherEnv;
        if (!activeEnv) return;
        const normalized = toJEvents(events);
        if (normalized.length === 0) return;
        const blockNumber = normalized[0]?.blockNumber ?? Number(browserVM.getBlockNumber());
        const blockHash = normalized[0]?.blockHash ?? browserVM.getBlockHash();
        processEventBatch(eventsToRaw(normalized), activeEnv, blockNumber, blockHash, txCounter, 'browservm');
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

    async pollNow(): Promise<void> {
      // BrowserVM pushes events synchronously from each transaction.
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
      adapter.stopWatching();
    },
  };

  return adapter;
}
