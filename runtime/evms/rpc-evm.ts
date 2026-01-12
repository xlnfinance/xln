/**
 * RPC EVM - External EVM via JSON-RPC (Reth/Erigon/Monad/etc)
 * Allows connecting to real blockchains for production use
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import type { JurisdictionEVM, XlnomySnapshot } from '../types.js';
import { getWallClockMs } from '../time.js';

export class RPCEVM implements JurisdictionEVM {
  type: 'rpc' = 'rpc';
  private rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  async deployContract(bytecode: string, args?: any[]): Promise<string> {
    // TODO: Deploy contract via eth_sendTransaction
    throw new Error('RPC backend not yet implemented');
  }

  async call(to: string, data: string, from?: string): Promise<string> {
    // TODO: Execute eth_call
    throw new Error('RPC backend not yet implemented');
  }

  async send(to: string, data: string, value?: bigint): Promise<string> {
    // TODO: Execute eth_sendTransaction
    throw new Error('RPC backend not yet implemented');
  }

  async getBlock(): Promise<number> {
    // TODO: Execute eth_blockNumber
    throw new Error('RPC backend not yet implemented');
  }

  async getBalance(address: string): Promise<bigint> {
    // TODO: Execute eth_getBalance
    throw new Error('RPC backend not yet implemented');
  }

  async serialize(): Promise<XlnomySnapshot> {
    // RPC EVM just stores connection URL, no state to serialize
    return {
      name: 'unknown',
      version: '1.0.0',
      created: getWallClockMs(),
      evmType: 'reth', // TODO: Support erigon/monad too
      blockTimeMs: 1000,
      jMachine: { position: { x: 0, y: 600, z: 0 }, capacity: 3, jHeight: 0 },
      contracts: {
        entityProviderAddress: '0x0',
        depositoryAddress: '0x0',
      },
      evmState: {
        rpcUrl: this.rpcUrl,
      },
      entities: [],
    };
  }

  getEntityProviderAddress(): string {
    throw new Error('RPC backend not yet initialized');
  }

  getDepositoryAddress(): string {
    throw new Error('RPC backend not yet initialized');
  }
}
