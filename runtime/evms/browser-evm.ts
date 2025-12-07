/**
 * BrowserEVM - In-browser EVM using @ethereumjs/vm
 * Proxies all BrowserVMProvider methods automatically
 */

import type { JurisdictionEVM, XlnomySnapshot } from '../types.js';
import { BrowserVMProvider } from '../../frontend/src/lib/view/utils/browserVMProvider.js';

export class BrowserEVM implements JurisdictionEVM {
  type: 'browservm' = 'browservm';
  private provider: BrowserVMProvider;

  constructor() {
    this.provider = new BrowserVMProvider();
  }

  // Proxy all provider methods
  async init() { return this.provider.init(); }
  getDepositoryAddress() { return this.provider.getDepositoryAddress(); }
  getBlockNumber() { return this.provider.getBlockNumber(); }
  async captureStateRoot() { return this.provider.captureStateRoot(); }
  async timeTravel(stateRoot: Uint8Array) { return this.provider.timeTravel(stateRoot); }
  async debugFundReserves(entityId: string, tokenId: number, amount: bigint) { return this.provider.debugFundReserves(entityId, tokenId, amount); }
  async getReserves(entityId: string, tokenId: number) { return this.provider.getReserves(entityId, tokenId); }
  async reserveToReserve(from: string, to: string, tokenId: number, amount: bigint) { return this.provider.reserveToReserve(from, to, tokenId, amount); }
  async executeTx(tx: { to: string; data: string; gasLimit?: bigint }) { return this.provider.executeTx(tx); }
  async executeBatch(entityId: string, batch: any) { return this.provider.executeBatch(entityId, batch); }

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
      jMachine: { position: { x: 0, y: 400, z: 0 }, capacity: 3, jHeight: 0 },
      contracts: {
        entityProviderAddress: '0x0000000000000000000000000000000000000000',
        depositoryAddress: this.provider.getDepositoryAddress(),
      },
      evmState: { vmState: null },
      entities: [],
    };
  }
}
