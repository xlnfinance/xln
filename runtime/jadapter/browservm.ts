/**
 * JAdapter - BrowserVM Implementation
 * In-memory EVM using @ethereumjs/vm
 * @license AGPL-3.0
 */

import { ethers } from 'ethers';
import type { Provider, Signer } from 'ethers';

import type { Account, Depository, EntityProvider, DeltaTransformer } from '../../jurisdictions/typechain-types/index.ts';
import type { TypedContractMethod } from '../../jurisdictions/typechain-types/common.ts';
import { Account__factory, Depository__factory, EntityProvider__factory, DeltaTransformer__factory } from '../../jurisdictions/typechain-types/index.ts';

import type { BrowserVMState, JTx } from '../types';
import type { JAdapter, JAdapterAddresses, JAdapterConfig, JEvent, JEventCallback, JSubmitResult, SnapshotId, JBatchReceipt, JTokenInfo, JReserveMint } from './types';
import {
  buildExternalTokenToReserveBatch,
  computeAccountKey,
  entityIdToAddress,
  isCanonicalEvent,
  normalizeAdapterEvents,
  parseReceiptLogsToJEvents,
  processEventBatch,
  toJEvent,
  updateWatcherJurisdictionCursor,
  type RawJEvent,
} from './helpers';
import type { BrowserVMProvider } from './browservm-provider';

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
  const account = addresses.account
    ? Account__factory.connect(addresses.account, signer as any) as Account
    : null;
  const depository = Depository__factory.connect(addresses.depository, signer as any) as Depository;
  const entityProvider = EntityProvider__factory.connect(addresses.entityProvider, signer as any) as EntityProvider;
  const deltaTransformer = addresses.deltaTransformer
    ? DeltaTransformer__factory.connect(addresses.deltaTransformer, signer as any) as DeltaTransformer
    : null;

  const eventCallbacks = new Map<string, Set<JEventCallback>>();
  const anyCallbacks = new Set<JEventCallback>();
  type NonPayableMethod<TArgs extends Array<any>, TResult> = TypedContractMethod<TArgs, [TResult], 'nonpayable'>;

  const sendTypedTx = async <TArgs extends Array<any>, TResult>(
    label: string,
    method: NonPayableMethod<TArgs, TResult>,
    args: [...TArgs],
    gasLimit: bigint,
    carriers: Array<{ interface: ethers.Interface }>,
  ): Promise<{ receipt: any; events: JEvent[] }> => {
    const tx = await method(...args, { gasLimit });
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      throw new Error(`${label} failed`);
    }
    return {
      receipt,
      events: parseReceiptLogsToJEvents(receipt, carriers),
    };
  };

  const beginJurisdictionBlock = (timestamp: number): void => {
    browserVM.setBlockTimestamp(timestamp);
    if ((browserVM as any).beginJurisdictionBlock) {
      (browserVM as any).beginJurisdictionBlock(timestamp);
      console.log(`🔨 [JAdapter:browservm] beginJurisdictionBlock(ts=${timestamp})`);
    }
  };

  const endJurisdictionBlock = (): void => {
    if ((browserVM as any).endJurisdictionBlock) {
      (browserVM as any).endJurisdictionBlock();
    }
  };

  // Store snapshots for revert functionality
  const snapshots = new Map<string, any>();
  let snapshotCounter = 0;

  // Forward events from browserVM
  browserVM.onAny((event: any) => {
    const jEvent = toJEvent(event.name, event.args ?? {}, {
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      transactionHash: event.transactionHash,
    });
    eventCallbacks.get(event.name)?.forEach(cb => cb(jEvent));
    anyCallbacks.forEach(cb => cb(jEvent));
  });

  const adapter: JAdapter = {
    mode: 'browservm',
    chainId: config.chainId,
    provider,
    signer,

    get account() {
      if (!account) {
        throw new Error('BrowserVM adapter missing Account contract address');
      }
      return account;
    },
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

    async getAccountInfo(
      entityId: string,
      counterpartyId: string,
    ): Promise<{ nonce: bigint; disputeHash: string; disputeTimeout: bigint }> {
      if ((browserVM as any).getAccountInfo) {
        return (browserVM as any).getAccountInfo(entityId, counterpartyId);
      }
      const key = computeAccountKey(entityId, counterpartyId);
      const result = await depository._accounts(key);
      return {
        nonce: result.nonce,
        disputeHash: result.disputeHash,
        disputeTimeout: result.disputeTimeout,
      };
    },

    async getEntityNonce(entityId: string): Promise<bigint> {
      return depository.entityNonces(entityId);
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
      const { receipt, events } = await sendTypedTx(
        'processBatch',
        depository.processBatch,
        [encodedBatch, hankoData, nonce],
        10_000_000n,
        [depository, entityProvider],
      );
      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        events,
      };
    },

    async enforceDebts(entityId: string, tokenId: number): Promise<void> {
      await sendTypedTx(
        'enforceDebts',
        depository.enforceDebts,
        [entityId, BigInt(tokenId), 100n],
        2_000_000n,
        [depository],
      );
    },

    async debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<JEvent[]> {
      const { events } = await sendTypedTx(
        'mintToReserve',
        depository.mintToReserve,
        [entityId, tokenId, amount],
        1_000_000n,
        [depository],
      );
      return events;
    },

    async debugFundReservesBatch(mints: JReserveMint[]): Promise<JEvent[]> {
      const payload = mints.map((mint) => ({
        entity: mint.entityId,
        tokenId: BigInt(mint.tokenId),
        amount: mint.amount,
      }));
      const { events } = await sendTypedTx(
        'mintToReserveBatch',
        depository.mintToReserveBatch,
        [payload],
        5_000_000n,
        [depository],
      );
      return events;
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
      const batch = buildExternalTokenToReserveBatch({
        entityId,
        tokenAddress,
        amount,
        tokenType,
        externalTokenId: options?.externalTokenId ?? 0n,
        internalTokenId: options?.internalTokenId ?? 0,
      });
      const events = await browserVM.processEntityBatch(entityId, batch, signerPrivateKey, signerPrivateKey);
      return normalizeAdapterEvents(events);
    },

    // === High-level J-tx submission ===
    async submitTx(jTx: JTx, options: { env: any; signerId?: string; signerPrivateKey?: Uint8Array; timestamp?: number }): Promise<JSubmitResult> {
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
        const normalizedId = normalizeEntityId(jTx.entityId);

        // Validate settlements have signatures + entityProvider
        for (const settlement of jTx.data.batch.settlements ?? []) {
          if (!settlement.entityProvider || settlement.entityProvider === '0x0000000000000000000000000000000000000000') {
            settlement.entityProvider = entityProviderAddr;
          }
          if (settlement.diffs?.length > 0 && (!settlement.sig || settlement.sig === '0x')) {
            return { success: false, error: `Settlement missing hanko sig: ${settlement.leftEntity?.slice(-4)}↔${settlement.rightEntity?.slice(-4)}` };
          }
        }

        // Use pre-provided encoded batch + hanko (from entity consensus) or sign locally
        let encodedBatch: string;
        let hankoData: string;
        let nextNonce: bigint;

        if (jTx.data.hankoSignature && jTx.data.encodedBatch && jTx.data.entityNonce) {
          // Entity consensus already signed — use pre-provided hanko
          encodedBatch = jTx.data.encodedBatch;
          hankoData = jTx.data.hankoSignature;
          nextNonce = BigInt(jTx.data.entityNonce);
          console.log(`🔐 [JAdapter:browservm] Using consensus hanko: nonce=${nextNonce}`);
        } else {
          // Fallback: single-signer sign locally (for scenarios / backward compat)
          const sid = signerId ?? jTx.data.signerId;
          if (!sid) {
            return { success: false, error: `Missing signerId for batch from ${jTx.entityId.slice(-4)}` };
          }

          const depositoryAddr = browserVM.getDepositoryAddress();
          const chainId = (browserVM as any).getChainId?.() ?? BigInt(config.chainId);
          encodedBatch = encodeJBatch(jTx.data.batch);
          const currentNonce = await browserVM.getEntityNonce(normalizedId);
          nextNonce = currentNonce + 1n;
          const batchHash = computeBatchHankoHash(chainId, depositoryAddr, encodedBatch, nextNonce);

          console.log(`🔐 [JAdapter:browservm] Local signing: entity=${normalizedId.slice(-4)} signer=${sid} nonce=${nextNonce} chainId=${chainId}`);
          const { signHashesAsSingleEntity } = await import('../hanko/signing');
          const hankos = await signHashesAsSingleEntity(env, normalizedId, sid, [batchHash]);
          hankoData = hankos[0]!;
          if (!hankoData) {
            return { success: false, error: 'Failed to build batch hanko signature' };
          }
        }

        // Preflight check
        const issues = preflightBatchForE2(normalizedId, jTx.data.batch, Math.floor(ts / 1000));
        if (issues.length > 0) {
          return { success: false, error: `Preflight failed: ${issues.join('; ')}` };
        }

        beginJurisdictionBlock(ts);

        try {
          console.log(`📦 [JAdapter:browservm] processBatch (${getBatchSize(jTx.data.batch)} ops) nonce=${nextNonce}`);
          const { receipt, events } = await sendTypedTx(
            'processBatch',
            depository.processBatch,
            [encodedBatch, hankoData, nextNonce],
            10_000_000n,
            [depository, entityProvider],
          );
          endJurisdictionBlock();
          console.log(`✅ [JAdapter:browservm] Batch executed: ${events.length} events`);
          return {
            success: true,
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            events,
          };
        } catch (error) {
          endJurisdictionBlock();
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`❌ [JAdapter:browservm] processBatch failed: ${msg}`);
          return { success: false, error: msg };
        }
      }

      if (jTx.type === 'mint' && jTx.data) {
        const { entityId, tokenId, amount } = jTx.data as any;
        console.log(`💰 [JAdapter:browservm] Minting ${amount} token ${tokenId} to ${entityId.slice(-4)}`);
        try {
          const events = await adapter.debugFundReserves(entityId, tokenId, amount);
          console.log(`✅ [JAdapter:browservm] Mint ok (${events.length} events)`);
          return { success: true, events };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`❌ [JAdapter:browservm] Mint failed: ${msg}`);
          return { success: false, error: msg };
        }
      }

      return { success: false, error: `Unknown JTx type: ${(jTx as any).type}` };
    },

    async getErc20Allowance(tokenAddress: string, owner: string, spender: string): Promise<bigint> {
      if (!browserVM.getErc20Allowance) return 0n;
      return browserVM.getErc20Allowance(tokenAddress, owner, spender);
    },

    async approveErc20(
      signerPrivateKey: Uint8Array,
      tokenAddress: string,
      spender: string,
      amount: bigint,
    ): Promise<string> {
      if (!browserVM.approveErc20) {
        throw new Error('BrowserVM approveErc20 not available');
      }
      return browserVM.approveErc20(signerPrivateKey, tokenAddress, spender, amount);
    },

    async transferErc20(
      signerPrivateKey: Uint8Array,
      tokenAddress: string,
      to: string,
      amount: bigint,
    ): Promise<string> {
      if (!browserVM.transferErc20) {
        throw new Error('BrowserVM transferErc20 not available');
      }
      return browserVM.transferErc20(signerPrivateKey, tokenAddress, to, amount);
    },

    async transferNative(
      signerPrivateKey: Uint8Array,
      to: string,
      amount: bigint,
    ): Promise<string> {
      if (!browserVM.transferNative) {
        throw new Error('BrowserVM transferNative not available');
      }
      return browserVM.transferNative(signerPrivateKey, to, amount);
    },

    async fundSignerWallet(address: string, amount?: bigint): Promise<void> {
      if (!browserVM.fundSignerWallet) {
        throw new Error('BrowserVM fundSignerWallet not available');
      }
      await browserVM.fundSignerWallet(address, amount);
    },

    // === J-Watcher integration (uses shared event conversion from helpers.ts) ===
    startWatching(env: any): void {
      if (watcherUnsubscribe) {
        console.log(`🔭 [JAdapter:browservm] Already watching`);
        return;
      }
      watcherEnv = env;
      txCounter.value = 0;
      (txCounter as any)._seenLogs = { set: new Set<string>(), order: [] as string[] };
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
          logIndex: e.logIndex,
        }));

        const blockNumber = normalized[0]?.blockNumber ?? Number((browserVM as any).getBlockNumber?.() ?? 0n);
        const blockHash = normalized[0]?.blockHash ?? (browserVM as any).getBlockHash?.() ?? '0x0';
        updateWatcherJurisdictionCursor(
          watcherEnv,
          blockNumber,
          browserVM.getDepositoryAddress?.() ?? addresses.depository,
        );

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

    setQuietLogs(quiet: boolean): void {
      browserVM.setQuietLogs?.(quiet);
    },

    registerEntityWallet(entityId: string, privateKey: string): void {
      browserVM.registerEntityWallet?.(entityId, privateKey);
    },

    async captureStateRoot(): Promise<Uint8Array | null> {
      if (!browserVM.captureStateRoot) return null;
      return browserVM.captureStateRoot();
    },

    async syncRuntimeState(
      accountPairs: Array<{ entityId: string; counterpartyId: string }>,
      tokenIds: number[],
    ): Promise<{
      collaterals: Map<string, Map<number, { collateral: bigint; ondelta: bigint }>>;
      blockNumber: bigint;
    } | null> {
      if (!browserVM.syncAllCollaterals) return null;
      const collaterals = await browserVM.syncAllCollaterals(accountPairs, tokenIds);
      const blockNumber = BigInt(browserVM.getBlockHeight?.() ?? 0);
      return { collaterals, blockNumber };
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
