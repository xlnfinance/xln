/**
 * BrowserEVMAdapter - Wraps BrowserVMProvider to implement EVM interface
 *
 * Exposes contract-like interfaces that internally call BrowserVMProvider methods.
 * This allows runtime code to use the same API as RPC EVM.
 */

import type { EVM, DepositoryContract, EntityProviderContract } from '../evm-interface';
import { BrowserVMProvider } from '../browservm';
import { isLeftEntity, normalizeEntityId } from '../entity-id-utils';
import { ethers } from 'ethers';

/**
 * Depository contract wrapper for BrowserVM
 */
class BrowserDepositoryContract implements DepositoryContract {
  private provider: BrowserVMProvider;
  readonly address: string;
  private listeners: Map<string, Set<(...args: any[]) => void>> = new Map();

  constructor(provider: BrowserVMProvider) {
    this.provider = provider;
    this.address = provider.getDepositoryAddress();

    // Subscribe to provider events and forward them
    provider.onAny((event: any) => {
      const listeners = this.listeners.get(event.name);
      if (listeners) {
        listeners.forEach(listener => {
          try {
            listener(...Object.values(event.args || {}));
          } catch (e) {
            console.error(`Event listener error for ${event.name}:`, e);
          }
        });
      }
    });
  }

  async _reserves(entityId: string, tokenId: number): Promise<bigint> {
    return this.provider.getReserves(entityId, tokenId);
  }

  async _collaterals(accountKey: string, tokenId: number): Promise<{ collateral: bigint; ondelta: bigint }> {
    // accountKey is already computed, need to parse entities from it
    // For now, use getCollateral which takes two entity IDs
    // This is a limitation - BrowserVM doesn't have accountKey lookup
    throw new Error('_collaterals by key not supported in BrowserVM, use getCollateral(e1, e2, tokenId)');
  }

  async _accounts(accountKey: string): Promise<{ cooperativeNonce: bigint; disputeHash: string; disputeTimeout: bigint }> {
    // Similar limitation
    throw new Error('_accounts by key not supported in BrowserVM');
  }

  async entityNonces(address: string): Promise<bigint> {
    // Convert address to entityId format if needed
    const entityId = address.length === 66 ? address : `0x${address.slice(2).padStart(64, '0')}`;
    return this.provider.getEntityNonce(entityId);
  }

  async accountKey(e1: string, e2: string): Promise<string> {
    const left = isLeftEntity(e1, e2) ? e1 : e2;
    const right = isLeftEntity(e1, e2) ? e2 : e1;
    return ethers.solidityPacked(['bytes32', 'bytes32'], [left, right]);
  }

  async processBatch(
    encodedBatch: string,
    entityProvider: string,
    hankoData: string,
    nonce: bigint
  ): Promise<{ hash: string; wait: () => Promise<{ blockNumber: number; gasUsed: bigint }> }> {
    // BrowserVMProvider.processBatch returns EVMEvent[] (events emitted)
    const events = await this.provider.processBatch(encodedBatch, entityProvider, hankoData, nonce);
    return {
      hash: '0x' + Math.random().toString(16).slice(2), // Simulated tx hash
      wait: async () => ({
        blockNumber: Number(this.provider.getBlockNumber()),
        gasUsed: 0n, // BrowserVM doesn't track gas
      }),
    };
  }

  async settle(
    leftEntity: string,
    rightEntity: string,
    diffs: Array<{ tokenId: number; leftDiff: bigint; rightDiff: bigint; collateralDiff: bigint; ondeltaDiff: bigint }>,
    forgiveDebtsInTokenIds: number[],
    insuranceRegs: Array<{ insured: string; insurer: string; tokenId: number; limit: bigint; expiresAt: bigint }>,
    sig: string
  ): Promise<{ hash: string; wait: () => Promise<any> }> {
    await this.provider.settleWithInsurance(leftEntity, rightEntity, diffs, forgiveDebtsInTokenIds, insuranceRegs, sig);
    return {
      hash: '0x',
      wait: async () => ({ blockNumber: Number(this.provider.getBlockNumber()) }),
    };
  }

  async reserveToReserve(
    fromEntity: string,
    toEntity: string,
    tokenId: number,
    amount: bigint
  ): Promise<{ hash: string; wait: () => Promise<any> }> {
    await this.provider.reserveToReserve(fromEntity, toEntity, tokenId, amount);
    return {
      hash: '0x',
      wait: async () => ({ blockNumber: Number(this.provider.getBlockNumber()) }),
    };
  }

  on(event: string, listener: (...args: any[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  off(event: string, listener: (...args: any[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}

/**
 * EntityProvider contract wrapper for BrowserVM
 */
class BrowserEntityProviderContract implements EntityProviderContract {
  private provider: BrowserVMProvider;
  readonly address: string;
  private listeners: Map<string, Set<(...args: any[]) => void>> = new Map();

  constructor(provider: BrowserVMProvider) {
    this.provider = provider;
    this.address = provider.getEntityProviderAddress();
  }

  async entities(entityId: string): Promise<{ boardHash: string; status: number; activationTime: bigint }> {
    const info = await this.provider.getEntityInfo(entityId);
    return {
      boardHash: info?.currentBoardHash || '0x0',
      status: info?.exists ? 1 : 0,
      activationTime: BigInt(info?.registrationBlock || 0),
    };
  }

  async nameToNumber(name: string): Promise<bigint> {
    // Not implemented in BrowserVMProvider yet
    throw new Error('nameToNumber not implemented in BrowserVM');
  }

  async numberToName(entityNumber: bigint): Promise<string> {
    // Not implemented in BrowserVMProvider yet
    throw new Error('numberToName not implemented in BrowserVM');
  }

  async nextNumber(): Promise<bigint> {
    // Not implemented in BrowserVMProvider yet
    throw new Error('nextNumber not implemented in BrowserVM');
  }

  async registerNumberedEntity(boardHash: string): Promise<{ hash: string; wait: () => Promise<any> }> {
    const results = await this.provider.registerNumberedEntitiesBatch([boardHash]);
    return {
      hash: '0x',
      wait: async () => ({ entityNumber: results[0] }),
    };
  }

  async registerNumberedEntitiesBatch(boardHashes: string[]): Promise<{ hash: string; wait: () => Promise<any> }> {
    const results = await this.provider.registerNumberedEntitiesBatch(boardHashes);
    return {
      hash: '0x',
      wait: async () => ({ entityNumbers: results }),
    };
  }

  async assignName(name: string, entityNumber: bigint): Promise<{ hash: string; wait: () => Promise<any> }> {
    throw new Error('assignName not implemented in BrowserVM');
  }

  on(event: string, listener: (...args: any[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  off(event: string, listener: (...args: any[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}

/**
 * BrowserEVMAdapter - Full EVM interface implementation using BrowserVMProvider
 */
export class BrowserEVMAdapter implements EVM {
  readonly type = 'browser' as const;
  readonly name: string;
  readonly chainId: number = 1337;
  readonly depository: DepositoryContract;
  readonly entityProvider: EntityProviderContract;

  private provider: BrowserVMProvider;

  private constructor(name: string, provider: BrowserVMProvider) {
    this.name = name;
    this.provider = provider;
    this.depository = new BrowserDepositoryContract(provider);
    this.entityProvider = new BrowserEntityProviderContract(provider);
  }

  static async create(name: string): Promise<BrowserEVMAdapter> {
    const provider = new BrowserVMProvider();
    await provider.init();
    return new BrowserEVMAdapter(name, provider);
  }

  async init(): Promise<void> {
    // Already initialized in create()
  }

  async getBlockNumber(): Promise<number> {
    return Number(this.provider.getBlockNumber());
  }

  // ─── Test-only methods ───

  async debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<void> {
    await this.provider.debugFundReserves(entityId, tokenId, amount);
  }

  async timeTravel(stateRoot: Uint8Array): Promise<void> {
    await this.provider.timeTravel(stateRoot);
  }

  async captureStateRoot(): Promise<Uint8Array> {
    return this.provider.captureStateRoot();
  }

  async serialize(): Promise<any> {
    return this.provider.serializeState();
  }

  async restore(state: any): Promise<void> {
    await this.provider.restoreState(state);
  }

  // ─── Direct provider access (for advanced use) ───
  getProvider(): BrowserVMProvider {
    return this.provider;
  }
}
