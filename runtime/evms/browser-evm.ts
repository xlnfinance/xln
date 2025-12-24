/**
 * BrowserEVM - In-browser EVM using @ethereumjs/vm
 * Proxies all BrowserVMProvider methods automatically
 */

import type { JurisdictionEVM, XlnomySnapshot } from '../types.js';
import { BrowserVMProvider } from '../../frontend/src/lib/view/utils/browserVMProvider.js';

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
  getBlockNumber() { return this.provider.getBlockNumber(); }
  async captureStateRoot() { return this.provider.captureStateRoot(); }
  async timeTravel(stateRoot: Uint8Array) { return this.provider.timeTravel(stateRoot); }
  async debugFundReserves(entityId: string, tokenId: number, amount: bigint) { return this.provider.debugFundReserves(entityId, tokenId, amount); }
  async getReserves(entityId: string, tokenId: number) { return this.provider.getReserves(entityId, tokenId); }
  async getCollateral(entity1: string, entity2: string, tokenId: number) { return this.provider.getCollateral(entity1, entity2, tokenId); }
  async reserveToReserve(from: string, to: string, tokenId: number, amount: bigint) { return this.provider.reserveToReserve(from, to, tokenId, amount); }
  async prefundAccount(entityId: string, counterpartyId: string, tokenId: number, amount: bigint) { return this.provider.prefundAccount(entityId, counterpartyId, tokenId, amount); }
  async executeTx(tx: { to: string; data: string; gasLimit?: bigint }) { return this.provider.executeTx(tx); }
  async executeBatch(entityId: string, batch: any) { return this.provider.executeBatch(entityId, batch); }
  async processBatch(entityId: string, batch: any) { return this.provider.processBatch(entityId, batch); }

  // Event subscription for j-watcher (proxied from BrowserVMProvider)
  onAny(callback: (event: any) => void): () => void { return this.provider.onAny(callback); }
  getBlockHash(): string { return this.provider.getBlockHash(); }

  // JurisdictionEVM interface
  async deployContract(bytecode: string, args?: any[]): Promise<string> { throw new Error('Not implemented'); }
  async call(to: string, data: string, from?: string): Promise<string> { throw new Error('Not implemented'); }
  async send(to: string, data: string, value?: bigint): Promise<string> { return this.provider.executeTx({ to, data, gasLimit: 1000000n }); }
  async getBlock(): Promise<number> { return 0; }
  async getBalance(address: string): Promise<bigint> { throw new Error('Not implemented'); }
  getEntityProviderAddress(): string { return '0x0000000000000000000000000000000000000000'; }

  async serialize(): Promise<XlnomySnapshot> {
    return {
      name: 'unknown',
      version: '1.0.0',
      created: Date.now(),
      evmType: 'browservm',
      blockTimeMs: 1000,
      jMachine: { position: { x: 0, y: 600, z: 0 }, capacity: 3, jHeight: 0 },
      contracts: {
        entityProviderAddress: '0x0000000000000000000000000000000000000000',
        depositoryAddress: this.provider.getDepositoryAddress(),
      },
      evmState: { vmState: null },
      entities: [],
    };
  }
}
