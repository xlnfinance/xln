/**
 * JAdapter - Unified interface to J-Machine (Jurisdiction L1)
 *
 * Usage:
 *   const j = await createJAdapter({ mode: 'browservm', chainId: 1337 });
 *   await j.deployStack();
 *   const balance = await j.depository._reserves(entityId, tokenId);
 *
 * Modes:
 *   - browservm: In-memory EVM (@ethereumjs/vm), no server needed
 *   - anvil: Local testnet via Foundry's Anvil
 *   - rpc: Real chains (mainnet, testnet)
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import { ethers } from 'ethers';

// Re-export types
export * from './types';
export { DEFAULT_PRIVATE_KEY } from './helpers';
export { BrowserVMProvider } from './browservm-provider';
export { BrowserVMEthersProvider } from './browservm-ethers-provider';

import type { JAdapter, JAdapterConfig } from './types';
import { DEFAULT_PRIVATE_KEY } from './helpers';
import { createBrowserVMAdapter } from './browservm';
import { createRpcAdapter } from './rpc';

/**
 * NonceTrackingWallet - Wallet that tracks nonce locally to avoid race conditions
 * Needed for rapid sequential transactions where getTransactionCount might be stale
 */
class NonceTrackingWallet extends ethers.Wallet {
  private _managedNonce: number = -1;

  override async populateTransaction(tx: ethers.TransactionRequest): Promise<ethers.TransactionLike<string>> {
    // Manually track nonce to avoid race conditions with pending txs
    if (this._managedNonce === -1) {
      const address = await this.getAddress();
      this._managedNonce = await this.provider!.getTransactionCount(address, 'latest');
    }
    const nonce = this._managedNonce++;
    return super.populateTransaction({ ...tx, nonce });
  }

  resetNonce(): void {
    this._managedNonce = -1;
  }
}

/**
 * Create a JAdapter for interacting with J-Machine
 */
export async function createJAdapter(config: JAdapterConfig): Promise<JAdapter> {
  const privateKey = config.privateKey ?? DEFAULT_PRIVATE_KEY;

  if (config.mode === 'browservm') {
    const { BrowserVMProvider } = await import('./browservm-provider');
    const browserVM = new BrowserVMProvider();
    await browserVM.init();

    if (config.browserVMState) {
      await browserVM.restoreState(config.browserVMState);
    }

    const { BrowserVMEthersProvider } = await import('./browservm-ethers-provider');
    const provider = new BrowserVMEthersProvider(browserVM);

    // Use NonceTrackingWallet to track nonce locally (VM uses skipNonce anyway)
    const signer = new NonceTrackingWallet(privateKey, provider);

    return createBrowserVMAdapter(config, provider, signer, browserVM);
  }

  // anvil and rpc modes both use RPC adapter
  if (!config.rpcUrl) {
    throw new Error('rpcUrl required for anvil/rpc mode');
  }
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  // Use NonceTrackingWallet for rapid sequential txs (anvil deploys many contracts)
  const signer = new NonceTrackingWallet(privateKey, provider);

  return createRpcAdapter(config, provider, signer);
}
