/**
 * JAdapter - Unified interface to J-Machine (Jurisdiction L1)
 *
 * Usage:
 *   const j = await createJAdapter({ mode: 'browservm', chainId: 31337 });
 *   await j.deployStack();
 *   const balance = await j.depository._reserves(entityId, tokenId);
 *
 * Modes:
 *   - browservm: In-memory EVM (@ethereumjs/vm), no server needed
 *   - anvil: Local testnet via Foundry's Anvil
 *   - rpc: EVM chains (mainnet, testnet)
 *   - tron: TRON JSON-RPC reads + native protobuf transaction writes
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import { ethers } from 'ethers';

// Re-export types
export * from './types';
export { DEFAULT_PRIVATE_KEY } from './helpers';
export * from './browservm-registry';
export * from './jurisdiction';
export {
  assignNameOnChain,
  debugFundReserves,
  getEntityInfoFromChain,
  submitProcessBatch,
  transferNameBetweenEntities,
} from './runtime-api';

/**
 * Set of chain IDs treated as local dev chains.
 * Used to gate mint/debugFundReserves and disable confirmation depth.
 */
export const DEV_CHAIN_IDS = new Set<number>([31337, 31338]);
export const TRON_CHAIN_IDS = new Set<number>([728126428, 3448148188]);
const DEFAULT_RPC_POLLING_INTERVAL_MS = 1_000;

export const resolveJAdapterPrivateKey = (config: JAdapterConfig): string | undefined => {
  if (config.privateKey) return config.privateKey;
  if (DEV_CHAIN_IDS.has(config.chainId)) {
    return process.env['JADAPTER_DEV_PRIVATE_KEY'] ?? DEFAULT_PRIVATE_KEY;
  }
  if (config.watchOnly) return undefined;
  throw new Error(
    `[JAdapter] privateKey is required for chainId=${config.chainId}. Refusing unsafe default key on non-dev chain.`,
  );
};
const xlnJsonRpcProviderOptions = (
  network?: ethers.Networkish,
): ethers.JsonRpcApiProviderOptions => ({
  // Ethers caches low-level perform calls for 250ms by default and batches
  // same-tick JSON-RPC requests. Fast local chains can mine thousands of
  // blocks synchronously inside that window, which makes later eth_call
  // preflights run against stale historical state. XLN needs latest-state
  // reads for submit safety, so disable both behaviours at the adapter edge.
  cacheTimeout: -1,
  batchMaxCount: 1,
  // A jurisdiction URL is immutable runtime configuration, not an injected
  // wallet whose selected chain can change. Binding the provider once avoids
  // ethers issuing eth_chainId before unrelated calls. createRpcAdapter still
  // performs one explicit wire-level chain check before any contract use.
  ...(network === undefined ? {} : { staticNetwork: ethers.Network.from(network) }),
});

export const createXlnJsonRpcProvider = (
  rpcUrl: string,
  network?: ethers.Networkish,
): ethers.JsonRpcProvider => new ethers.JsonRpcProvider(rpcUrl, network, xlnJsonRpcProviderOptions(network));

const configureRpcPolling = (provider: ethers.JsonRpcProvider): void => {
  const configuredInterval =
    typeof process !== 'undefined' && process.env
      ? process.env['XLN_RPC_POLLING_INTERVAL_MS']
      : undefined;
  const rawInterval = Number(configuredInterval ?? DEFAULT_RPC_POLLING_INTERVAL_MS);
  if (!Number.isFinite(rawInterval) || rawInterval <= 0) return;
  (provider as ethers.JsonRpcProvider & { pollingInterval?: number }).pollingInterval = Math.floor(rawInterval);
};

import type { JAdapter, JAdapterConfig } from './types';
import { DEFAULT_PRIVATE_KEY } from './helpers';
import { createBrowserVMAdapter } from './browservm';
import { createRpcAdapter } from './rpc';
import { normalizeLoopbackUrl } from '../networking/loopback-url';

/**
 * NonceTrackingWallet - Wallet that tracks nonce locally to avoid race conditions
 * Needed for rapid sequential transactions where getTransactionCount might be stale
 */
class NonceTrackingWallet extends ethers.Wallet {
  private _managedNonce: number = -1;

  override async populateTransaction(tx: ethers.TransactionRequest): Promise<ethers.TransactionLike<string>> {
    const explicitNonce =
      typeof tx.nonce === 'number'
        ? tx.nonce
        : typeof tx.nonce === 'bigint'
          ? Number(tx.nonce)
          : null;

    if (explicitNonce !== null) {
      if (this._managedNonce < explicitNonce + 1) {
        this._managedNonce = explicitNonce + 1;
      }
      return super.populateTransaction({ ...tx, nonce: explicitNonce });
    }

    // Manually track nonce to avoid race conditions with pending txs.
    if (this._managedNonce === -1) {
      const address = await this.getAddress();
      this._managedNonce = await this.provider!.getTransactionCount(address, 'pending');
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
  const effectiveConfig: JAdapterConfig = config.mode === 'rpc' && TRON_CHAIN_IDS.has(config.chainId)
    ? { ...config, mode: 'tron' }
    : config;
  const privateKey = resolveJAdapterPrivateKey(effectiveConfig);

  if (effectiveConfig.mode === 'browservm') {
    const { BrowserVMProvider } = await import('./browservm-provider');
    const browserVM = new BrowserVMProvider();
    await browserVM.init({ chainId: config.chainId });

    if (config.browserVMState) {
      await browserVM.restoreState(config.browserVMState);
    }

    const { BrowserVMEthersProvider } = await import('./browservm-ethers-provider');
    const provider = new BrowserVMEthersProvider(browserVM);

    // Use NonceTrackingWallet to track nonce locally (VM uses skipNonce anyway)
    if (!privateKey) throw new Error('BROWSERVM_SIGNER_KEY_REQUIRED');
    const signer = new NonceTrackingWallet(privateKey, provider);

    return createBrowserVMAdapter(effectiveConfig, provider, signer, browserVM);
  }

  // anvil, EVM RPC, and TRON share the same ABI/receipt adapter. TRON swaps
  // only the signer transport because java-tron does not accept Ethereum raw txs.
  if (!config.rpcUrl) {
    throw new Error('rpcUrl required for anvil/rpc/tron mode');
  }
  const rpcUrl = normalizeLoopbackUrl(config.rpcUrl);
  const provider = createXlnJsonRpcProvider(rpcUrl, config.chainId);
  configureRpcPolling(provider);
  const tronApiKey = effectiveConfig.mode === 'tron'
    ? effectiveConfig.tronApiKey || process.env['TRONGRID_API_KEY']
    : undefined;
  const signer = effectiveConfig.mode === 'tron' && privateKey
    ? await (await import('./tron-signer')).createTronSigner({
        provider,
        privateKey,
        rpcUrl,
        fullHost: effectiveConfig.tronFullHost,
        apiKey: tronApiKey,
      })
    : privateKey
      ? new NonceTrackingWallet(privateKey, provider)
      : new ethers.VoidSigner(ethers.ZeroAddress, provider);

  return createRpcAdapter({
    ...effectiveConfig,
    rpcUrl,
    ...(tronApiKey ? { tronApiKey } : {}),
  }, provider, signer);
}
