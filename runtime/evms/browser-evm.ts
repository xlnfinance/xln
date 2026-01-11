/**
 * BrowserEVM - In-browser EVM using @ethereumjs/vm
 * Proxies all BrowserVMProvider methods automatically
 */

import type { JurisdictionEVM, XlnomySnapshot } from '../types.js';
import { BrowserVMProvider } from '../browservm.js';

// Singleton across bundles via window global
declare global {
  interface Window {
    __xlnBrowserVM?: BrowserVMProvider;
  }
}

function getOrCreateBrowserVM(): BrowserVMProvider {
  if (typeof window !== 'undefined') {
    if (!window.__xlnBrowserVM) {
      window.__xlnBrowserVM = new BrowserVMProvider();
    }
    return window.__xlnBrowserVM;
  }
  // Fallback for non-browser (shouldn't happen)
  return new BrowserVMProvider();
}

export class BrowserEVM implements JurisdictionEVM {
  type: 'browservm' = 'browservm';
  // Use window global singleton - works across bundles
  private provider = getOrCreateBrowserVM();

  // Proxy all provider methods
  async init() { return this.provider.init(); }
  async reset() { return this.provider.reset(); }
  getDepositoryAddress() { return this.provider.getDepositoryAddress(); }
  getDeltaTransformerAddress() { return this.provider.getDeltaTransformerAddress(); }
  getBlockNumber() { return this.provider.getBlockNumber(); }
  async captureStateRoot() { return this.provider.captureStateRoot(); }
  async timeTravel(stateRoot: Uint8Array) { return this.provider.timeTravel(stateRoot); }
  async debugFundReserves(entityId: string, tokenId: number, amount: bigint) { return this.provider.debugFundReserves(entityId, tokenId, amount); }
  async getReserves(entityId: string, tokenId: number) { return this.provider.getReserves(entityId, tokenId); }
  async getCollateral(entity1: string, entity2: string, tokenId: number) { return this.provider.getCollateral(entity1, entity2, tokenId); }
  async reserveToReserve(from: string, to: string, tokenId: number, amount: bigint) { return this.provider.reserveToReserve(from, to, tokenId, amount); }
  async processBatch(entityId: string, batch: any) { return this.provider.processBatch(entityId, batch); }
  getProvider() { return this.provider; }

  // Event subscription for j-watcher (proxied from BrowserVMProvider)
  onAny(callback: (event: any) => void): () => void { return this.provider.onAny(callback); }
  getBlockHash(): string { return this.provider.getBlockHash(); }
  async registerNumberedEntitiesBatch(boardHashes: string[]): Promise<number[]> { return this.provider.registerNumberedEntitiesBatch(boardHashes); }
  async getEntityInfo(entityId: string) { return this.provider.getEntityInfo(entityId); }

  // JurisdictionEVM interface
  async deployContract(bytecode: string, args?: any[]): Promise<string> { throw new Error('Not implemented'); }
  async call(to: string, data: string, from?: string): Promise<string> { throw new Error('Not implemented'); }
  async send(to: string, data: string, value?: bigint): Promise<string> { return this.provider.executeTx({ to, data, gasLimit: 1000000n }); }
  async getBlock(): Promise<number> { return 0; }
  async getBalance(address: string): Promise<bigint> { throw new Error('Not implemented'); }
  getEntityProviderAddress(): string { return this.provider.getEntityProviderAddress(); }

  async serialize(): Promise<XlnomySnapshot> {
    return {
      name: 'unknown',
      version: '1.0.0',
      created: Date.now(),
      evmType: 'browservm',
      blockTimeMs: 1000,
      jMachine: { position: { x: 0, y: 600, z: 0 }, capacity: 3, jHeight: 0 },
      contracts: {
        entityProviderAddress: this.provider.getEntityProviderAddress(),
        depositoryAddress: this.provider.getDepositoryAddress(),
        deltaTransformerAddress: this.provider.getDeltaTransformerAddress(),
      },
      evmState: { vmState: null },
      entities: [],
    };
  }
}
