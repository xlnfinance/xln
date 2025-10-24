/**
 * BrowserVM EVM - In-browser EVM using @ethereumjs/vm
 * Wraps frontend/src/lib/view/utils/browserVMProvider.ts for runtime use
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import type { JurisdictionEVM, XlnomySnapshot } from '../types.js';
import { BrowserVMProvider } from '../../frontend/src/lib/view/utils/browserVMProvider.js';

export class BrowserVMEVM implements JurisdictionEVM {
  type: 'browservm' = 'browservm';
  private provider: BrowserVMProvider;

  constructor() {
    this.provider = new BrowserVMProvider();
  }

  async init(): Promise<void> {
    await this.provider.init();
  }

  async deployContract(bytecode: string, args?: any[]): Promise<string> {
    // BrowserVMProvider's init() already deploys EntityProvider + Depository
    // This method is for future contract deployments
    throw new Error('Custom contract deployment not yet implemented');
  }

  async call(to: string, data: string, from?: string): Promise<string> {
    // Execute view call via provider
    throw new Error('call() not yet implemented');
  }

  async send(to: string, data: string, value?: bigint): Promise<string> {
    return await this.provider.executeTx({ to, data, gasLimit: 1000000n });
  }

  async getBlock(): Promise<number> {
    return 0; // BrowserVM doesn't have block concept yet
  }

  async getBalance(address: string): Promise<bigint> {
    throw new Error('getBalance() not yet implemented');
  }

  async serialize(): Promise<XlnomySnapshot> {
    // TODO: Serialize VM state
    return {
      name: 'unknown',
      version: '1.0.0',
      created: Date.now(),
      evmType: 'browservm',
      blockTimeMs: 1000,
      jMachine: { position: { x: 0, y: 100, z: 0 }, capacity: 3, jHeight: 0 },
      contracts: {
        entityProviderAddress: '0x0000000000000000000000000000000000000000', // EntityProvider removed from BrowserVM
        depositoryAddress: this.provider.getDepositoryAddress(),
      },
      evmState: {
        vmState: null, // TODO: Serialize @ethereumjs/vm state
      },
      entities: [],
    };
  }

  getEntityProviderAddress(): string {
    return '0x0000000000000000000000000000000000000000'; // EntityProvider removed from BrowserVM
  }

  getDepositoryAddress(): string {
    return this.provider.getDepositoryAddress();
  }
}
