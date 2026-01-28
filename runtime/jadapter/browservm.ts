/**
 * JAdapter - BrowserVM Implementation
 * In-memory EVM using @ethereumjs/vm
 * @license AGPL-3.0
 */

import { ethers } from 'ethers';
import type { Provider, Signer } from 'ethers';

import type { Depository } from '../../jurisdictions/typechain-types/Depository';
import type { EntityProvider } from '../../jurisdictions/typechain-types/EntityProvider';
import type { Account } from '../../jurisdictions/typechain-types/Account';
import type { DeltaTransformer } from '../../jurisdictions/typechain-types/DeltaTransformer';
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository__factory';
import { EntityProvider__factory } from '../../jurisdictions/typechain-types/factories/EntityProvider__factory';
import { DeltaTransformer__factory } from '../../jurisdictions/typechain-types/factories/DeltaTransformer__factory';

import type { BrowserVMState } from '../types';
import type { JAdapter, JAdapterAddresses, JAdapterConfig, JEvent, JEventCallback, SnapshotId, JBatchReceipt, JTxReceipt, SettlementDiff, InsuranceReg } from './types';
import { computeAccountKey, entityIdToAddress } from './helpers';
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
      const events = await browserVM.settleWithInsurance(
        leftEntity,
        rightEntity,
        diffs,
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

    getBrowserVM(): BrowserVMProvider | null {
      return browserVM;
    },

    setBlockTimestamp(timestamp: number): void {
      browserVM.setBlockTimestamp(timestamp);
    },

    async close(): Promise<void> {
      // BrowserVM doesn't have persistent connections to close
    },
  };

  return adapter;
}
