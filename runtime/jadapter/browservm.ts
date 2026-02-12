/**
 * JAdapter - BrowserVM Implementation
 * In-memory EVM using @ethereumjs/vm
 * @license AGPL-3.0
 */

import { ethers } from 'ethers';
import type { Provider, Signer } from 'ethers';

import type { Account, Depository, EntityProvider, DeltaTransformer } from '../../jurisdictions/typechain-types';
import { Depository__factory, EntityProvider__factory, DeltaTransformer__factory } from '../../jurisdictions/typechain-types';

import type { BrowserVMState, JTx } from '../types';
import type { JAdapter, JAdapterAddresses, JAdapterConfig, JEvent, JEventCallback, JSubmitResult, SnapshotId, JBatchReceipt, JTxReceipt, SettlementDiff, JTokenInfo } from './types';
import { computeAccountKey, entityIdToAddress, isCanonicalEvent, processEventBatch, type RawJEvent } from './helpers';
import type { BrowserVMProvider } from './browservm-provider';

// Re-export BrowserVMProvider for external use
export { BrowserVMProvider } from './browservm-provider';

export async function createBrowserVMAdapter(
  config: JAdapterConfig,
  provider: Provider,
  signer: Signer,
  browserVM: BrowserVMProvider
): Promise<JAdapter> {
  const addresses: JAdapterAddresses = {
    account: browserVM.getAccountAddress?.() ?? '',
    depository: browserVM.getDepositoryAddress(),
    entityProvider: browserVM.getEntityProviderAddress(),
    deltaTransformer: browserVM.getDeltaTransformerAddress?.() ?? '',
  };

  // Get contract instances from browserVM
  // Use any cast to handle ethers version mismatch between root and jurisdictions
  const depository = Depository__factory.connect(addresses.depository, signer as any) as Depository;
  const entityProvider = EntityProvider__factory.connect(addresses.entityProvider, signer as any) as EntityProvider;
  const deltaTransformer = addresses.deltaTransformer
    ? DeltaTransformer__factory.connect(addresses.deltaTransformer, signer as any) as DeltaTransformer
    : null;

  const eventCallbacks = new Map<string, Set<JEventCallback>>();
  const anyCallbacks = new Set<JEventCallback>();

  // Store snapshots for revert functionality
  const snapshots = new Map<string, any>();
  let snapshotCounter = 0;

  // Forward events from browserVM
  browserVM.onAny((event: any) => {
    const jEvent: JEvent = {
      name: event.name,
      args: event.args ?? {},
      blockNumber: event.blockNumber ?? 0,
      blockHash: event.blockHash ?? '0x',
      transactionHash: event.transactionHash ?? '0x',
    };
    eventCallbacks.get(event.name)?.forEach(cb => cb(jEvent));
    anyCallbacks.forEach(cb => cb(jEvent));
  });

  const adapter: JAdapter = {
    mode: 'browservm',
    chainId: config.chainId,
    provider,
    signer,

    get account() { return null as unknown as Account; }, // BrowserVM doesn't expose Account library directly
    get depository() { return depository; },
    get entityProvider() { return entityProvider; },
    get deltaTransformer() { return deltaTransformer!; },
    get addresses() { return addresses; },

    async deployStack() {
      // BrowserVM already deploys during init(), just log addresses
      console.log('[JAdapter:browservm] Stack ready:');
      console.log(`  Account: ${addresses.account}`);
      console.log(`  Depository: ${addresses.depository}`);
      console.log(`  EntityProvider: ${addresses.entityProvider}`);
      console.log(`  DeltaTransformer: ${addresses.deltaTransformer}`);
    },

    async snapshot(): Promise<SnapshotId> {
      const state = await browserVM.serializeState();
      const id = `0x${(++snapshotCounter).toString(16)}`;
      snapshots.set(id, state);
      return id;
    },

    async revert(snapshotId: SnapshotId): Promise<void> {
      const state = snapshots.get(snapshotId);
      if (!state) {
        throw new Error(`Snapshot ${snapshotId} not found`);
      }
      await browserVM.restoreState(state);
    },

    async dumpState(): Promise<BrowserVMState> {
      return browserVM.serializeState();
    },

    async loadState(state: BrowserVMState | string): Promise<void> {
      if (typeof state === 'string') {
        throw new Error('BrowserVM requires BrowserVMState object, not file path');
      }
      await browserVM.restoreState(state);
    },

    on(eventName: string, callback: JEventCallback): () => void {
      if (!eventCallbacks.has(eventName)) {
        eventCallbacks.set(eventName, new Set());
      }
      eventCallbacks.get(eventName)!.add(callback);
      return () => eventCallbacks.get(eventName)?.delete(callback);
    },

    onAny(callback: JEventCallback): () => void {
      anyCallbacks.add(callback);
      return () => anyCallbacks.delete(callback);
    },

    async processBlock(): Promise<JEvent[]> {
      // BrowserVM processes transactions synchronously
      return [];
    },

    async getReserves(entityId: string, tokenId: number): Promise<bigint> {
      return depository._reserves(entityId, tokenId);
    },

    async getCollateral(entity1: string, entity2: string, tokenId: number): Promise<bigint> {
      const key = computeAccountKey(entity1, entity2);
      const result = await depository._collaterals(key, tokenId);
      return result.collateral;
    },

    async getEntityNonce(entityId: string): Promise<bigint> {
      return depository.entityNonces(entityIdToAddress(entityId));
    },

    async isEntityRegistered(entityId: string): Promise<boolean> {
      const info = await entityProvider.entities(entityId);
      // registrationBlock > 0 means entity was registered
      return info.registrationBlock !== 0n;
    },

    async getTokenRegistry(): Promise<JTokenInfo[]> {
      const registry = (browserVM as any).getTokenRegistry?.() || [];
      return registry.map((t: any) => ({
        symbol: t.symbol,
        name: t.name,
        address: t.address,
        decimals: typeof t.decimals === 'number' ? t.decimals : 18,
        tokenId: typeof t.tokenId === 'number' ? t.tokenId : undefined,
      }));
    },

    async getErc20Balance(tokenAddress: string, owner: string): Promise<bigint> {
      if ((browserVM as any).getErc20Balance) {
        return browserVM.getErc20Balance(tokenAddress, owner);
      }
      const erc20 = new ethers.Contract(tokenAddress, ['function balanceOf(address owner) view returns (uint256)'], provider);
      const balanceOf = erc20.getFunction('balanceOf') as (owner: string) => Promise<bigint>;
      return balanceOf(owner);
    },

    async getErc20Balances(tokenAddresses: string[], owner: string): Promise<bigint[]> {
      const balances: bigint[] = [];
      for (const tokenAddress of tokenAddresses) {
        balances.push(await adapter.getErc20Balance(tokenAddress, owner));
      }
      return balances;
    },

    // === WRITE METHODS ===

    async processBatch(encodedBatch: string, hankoData: string, nonce: bigint): Promise<JBatchReceipt> {
      const entityProviderAddr = browserVM.getEntityProviderAddress();
      const events = await browserVM.processBatch(encodedBatch, entityProviderAddr, hankoData, nonce);
      return {
        txHash: '0x' + 'browservm'.padStart(64, '0'), // BrowserVM doesn't have real tx hashes
        blockNumber: Number(browserVM.getBlockNumber?.() ?? 0),
        events: events.map((e: any) => ({
          name: e.name,
          args: e.args ?? {},
          blockNumber: e.blockNumber ?? 0,
          blockHash: e.blockHash ?? '0x',
          transactionHash: e.transactionHash ?? '0x',
        })),
      };
    },

    async settle(
      leftEntity: string,
      rightEntity: string,
      diffs: SettlementDiff[],
      forgiveDebtsInTokenIds: number[] = [],
      insuranceRegs: InsuranceReg[] = [],
      sig?: string
    ): Promise<JTxReceipt> {
      // BrowserVM has settleWithInsurance which handles both cases
      // Ensure ondeltaDiff is set (default to 0n if not provided)
      const normalizedDiffs = diffs.map(d => ({
        tokenId: d.tokenId,
        leftDiff: d.leftDiff,
        rightDiff: d.rightDiff,
        collateralDiff: d.collateralDiff,
        ondeltaDiff: d.ondeltaDiff ?? 0n,
      }));
      const events = await browserVM.settleWithInsurance(
        leftEntity,
        rightEntity,
        normalizedDiffs,
        forgiveDebtsInTokenIds,
        insuranceRegs,
        sig
      );
      return {
        txHash: '0x' + 'browservm-settle'.padStart(64, '0'),
        blockNumber: Number(browserVM.getBlockNumber?.() ?? 0),
      };
    },

    async registerNumberedEntity(boardHash: string): Promise<{ entityNumber: number; txHash: string }> {
      const result = await browserVM.registerNumberedEntitiesBatch([boardHash]);
      return {
        entityNumber: result.entityNumbers[0] ?? 0,
        txHash: result.txHash,
      };
    },

    async registerNumberedEntitiesBatch(boardHashes: string[]): Promise<{ entityNumbers: number[]; txHash: string }> {
      return browserVM.registerNumberedEntitiesBatch(boardHashes);
    },

    async getNextEntityNumber(): Promise<number> {
      return browserVM.getNextEntityNumber();
    },

    async debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<JEvent[]> {
      const events = await browserVM.debugFundReserves(entityId, tokenId, amount);
      return events.map((e: any) => ({
        name: e.name,
        args: e.args ?? {},
        blockNumber: e.blockNumber ?? 0,
        blockHash: e.blockHash ?? '0x',
        transactionHash: e.transactionHash ?? '0x',
      }));
    },

    async reserveToReserve(from: string, to: string, tokenId: number, amount: bigint): Promise<JEvent[]> {
      const events = await browserVM.reserveToReserve(from, to, tokenId, amount);
      return events.map((e: any) => ({
        name: e.name,
        args: e.args ?? {},
        blockNumber: e.blockNumber ?? 0,
        blockHash: e.blockHash ?? '0x',
        transactionHash: e.transactionHash ?? '0x',
      }));
    },

    async externalTokenToReserve(
      signerPrivateKey: Uint8Array,
      entityId: string,
      tokenAddress: string,
      amount: bigint,
      options?: {
        tokenType?: number;
        externalTokenId?: bigint;
        internalTokenId?: number;
      }
    ): Promise<JEvent[]> {
      const depositoryAddress = browserVM.getDepositoryAddress();
      const ownerAddress = new ethers.Wallet(ethers.hexlify(signerPrivateKey)).address;
      const tokenType = options?.tokenType ?? 0;
      if (tokenType === 0 && browserVM.getErc20Allowance && browserVM.approveErc20) {
        const allowance = await browserVM.getErc20Allowance(tokenAddress, ownerAddress, depositoryAddress);
        if (allowance < amount) {
          await browserVM.approveErc20(signerPrivateKey, tokenAddress, depositoryAddress, (2n ** 256n) - 1n);
        }
      }

      if (!browserVM.externalTokenToReserve) {
        throw new Error('BrowserVM externalTokenToReserve not available');
      }
      const events = await browserVM.externalTokenToReserve(signerPrivateKey, entityId, tokenAddress, amount, options);
      return events.map((e: any) => ({
        name: e.name,
        args: e.args ?? {},
        blockNumber: e.blockNumber ?? 0,
        blockHash: e.blockHash ?? '0x',
        transactionHash: e.transactionHash ?? '0x',
      }));
    },

    // === High-level J-tx submission ===
    async submitTx(jTx: JTx, options: { env: any; signerId?: string; timestamp?: number }): Promise<JSubmitResult> {
      const { env, signerId, timestamp } = options;
      const ts = timestamp ?? env.timestamp ?? 0;

      console.log(`📤 [JAdapter:browservm] submitTx type=${jTx.type} entity=${jTx.entityId.slice(-4)}`);

      if (jTx.type === 'batch' && jTx.data?.batch) {
        const { encodeJBatch, computeBatchHankoHash, isBatchEmpty, getBatchSize, preflightBatchForE2 } = await import('../j-batch');
        const { normalizeEntityId } = await import('../entity-id-utils');

        if (isBatchEmpty(jTx.data.batch)) {
          console.log(`📦 [JAdapter:browservm] Empty batch, skipping`);
          return { success: true };
        }

        const entityProviderAddr = browserVM.getEntityProviderAddress();
        const depositoryAddr = browserVM.getDepositoryAddress();
        const chainId = (browserVM as any).getChainId?.() ?? BigInt(config.chainId);
        const sid = signerId ?? jTx.data.signerId;

        if (!sid) {
          return { success: false, error: `Missing signerId for batch from ${jTx.entityId.slice(-4)}` };
        }

        // Validate settlements have signatures
        for (const settlement of jTx.data.batch.settlements ?? []) {
          settlement.entityProvider = entityProviderAddr;
          if (settlement.diffs?.length > 0 && (!settlement.sig || settlement.sig === '0x')) {
            return { success: false, error: `Settlement missing hanko sig: ${settlement.leftEntity?.slice(-4)}↔${settlement.rightEntity?.slice(-4)}` };
          }
        }

        const encodedBatch = encodeJBatch(jTx.data.batch);
        const normalizedId = normalizeEntityId(jTx.entityId);
        const currentNonce = await browserVM.getEntityNonce(normalizedId);
        const nextNonce = currentNonce + 1n;
        const batchHash = computeBatchHankoHash(chainId, depositoryAddr, encodedBatch, nextNonce);

        console.log(`🔐 [JAdapter:browservm] Signing hanko: entity=${normalizedId.slice(-4)} nonce=${nextNonce} chainId=${chainId}`);

        const { signHashesAsSingleEntity } = await import('../hanko-signing');
        const hankos = await signHashesAsSingleEntity(env, normalizedId, sid, [batchHash]);
        const hankoData = hankos[0];
        if (!hankoData) {
          return { success: false, error: 'Failed to build batch hanko signature' };
        }

        // Preflight check
        const issues = preflightBatchForE2(normalizedId, jTx.data.batch, Math.floor(ts / 1000));
        if (issues.length > 0) {
          return { success: false, error: `Preflight failed: ${issues.join('; ')}` };
        }

        browserVM.setBlockTimestamp(ts);
        if ((browserVM as any).beginJurisdictionBlock) {
          (browserVM as any).beginJurisdictionBlock(ts);
          console.log(`🔨 [JAdapter:browservm] beginJurisdictionBlock(ts=${ts})`);
        }

        try {
          console.log(`📦 [JAdapter:browservm] processBatch (${getBatchSize(jTx.data.batch)} ops) nonce=${nextNonce}`);
          const events = await browserVM.processBatch(encodedBatch, entityProviderAddr, hankoData, nextNonce);

          if ((browserVM as any).endJurisdictionBlock) {
            (browserVM as any).endJurisdictionBlock();
          }

          console.log(`✅ [JAdapter:browservm] Batch executed: ${events.length} events`);
          return {
            success: true,
            txHash: `0x${'browservm-batch'.padStart(64, '0')}`,
            blockNumber: Number((browserVM as any).getBlockNumber?.() ?? 0),
            events: events.map((e: any) => ({
              name: e.name,
              args: e.args ?? {},
              blockNumber: e.blockNumber ?? 0,
              blockHash: e.blockHash ?? '0x',
              transactionHash: e.transactionHash ?? '0x',
            })),
          };
        } catch (error) {
          if ((browserVM as any).endJurisdictionBlock) {
            (browserVM as any).endJurisdictionBlock();
          }
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`❌ [JAdapter:browservm] processBatch failed: ${msg}`);
          return { success: false, error: msg };
        }
      }

      if (jTx.type === 'mint' && jTx.data && browserVM.debugFundReserves) {
        const { entityId, tokenId, amount } = jTx.data as any;
        console.log(`💰 [JAdapter:browservm] Minting ${amount} token ${tokenId} to ${entityId.slice(-4)}`);
        try {
          const events = await browserVM.debugFundReserves(entityId, tokenId, amount);
          console.log(`✅ [JAdapter:browservm] Mint ok (${events.length} events)`);
          return { success: true, events: events.map((e: any) => ({ name: e.name, args: e.args ?? {}, blockNumber: 0, blockHash: '0x', transactionHash: '0x' })) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`❌ [JAdapter:browservm] Mint failed: ${msg}`);
          return { success: false, error: msg };
        }
      }

      return { success: false, error: `Unknown JTx type: ${(jTx as any).type}` };
    },

    // === J-Watcher integration (uses shared event conversion from helpers.ts) ===
    startWatching(env: any): void {
      if (watcherUnsubscribe) {
        console.log(`🔭 [JAdapter:browservm] Already watching`);
        return;
      }
      watcherEnv = env;
      console.log(`🔭 [JAdapter:browservm] Starting event watcher (eReplicas=${env.eReplicas?.size ?? 0})...`);

      watcherUnsubscribe = browserVM.onAny((rawEvents: any[]) => {
        if (!watcherEnv) return;

        // Normalize to RawJEvent format (BrowserVM already emits { name, args })
        const normalized: RawJEvent[] = rawEvents.map((e: any) => ({
          name: e.name,
          args: e.args ?? {},
          blockNumber: e.blockNumber,
          blockHash: e.blockHash,
          transactionHash: e.transactionHash,
        }));

        const blockNumber = normalized[0]?.blockNumber ?? Number((browserVM as any).getBlockNumber?.() ?? 0n);
        const blockHash = normalized[0]?.blockHash ?? (browserVM as any).getBlockHash?.() ?? '0x0';

        // Shared: filter canonical, group by entity, convert, enqueue
        processEventBatch(normalized, watcherEnv, blockNumber, blockHash, txCounter, 'browservm');
      });

      console.log(`🔭 [JAdapter:browservm] Watcher started (event subscription)`);
    },

    stopWatching(): void {
      if (watcherUnsubscribe) {
        watcherUnsubscribe();
        watcherUnsubscribe = null;
        watcherEnv = null;
        console.log(`🔭 [JAdapter:browservm] Watcher stopped`);
      }
    },

    getBrowserVM(): BrowserVMProvider | null {
      return browserVM;
    },

    setBlockTimestamp(timestamp: number): void {
      browserVM.setBlockTimestamp(timestamp);
    },

    async close(): Promise<void> {
      adapter.stopWatching();
    },
  };

  // Watcher state (managed by adapter, not external j-watcher)
  let watcherUnsubscribe: (() => void) | null = null;
  let watcherEnv: any = null;
  const txCounter = { value: 0 };

  return adapter;
}

// Event conversion and relevance checking now in jadapter/helpers.ts (shared with RPC adapter)
