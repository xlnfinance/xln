import { ethers } from 'ethers';

import { normalizeLoopbackUrl } from '../../../network/p2p/loopback-url';
import { createBrowserVMAdapter } from '../browservm/browservm';
import { DEV_CHAIN_IDS, TRON_CHAIN_IDS } from '../chain-ids';
import { createRpcAdapter } from '../rpc/rpc-adapter';
import type { JAdapter, JAdapterConfig } from '../types';

const DEFAULT_RPC_POLLING_INTERVAL_MS = 1_000;

/** External RPC lifetime only; no observation becomes committed J state here. */
class XlnJsonRpcProvider extends ethers.JsonRpcProvider {
  private readonly pendingReads = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;

  override async _perform(request: ethers.PerformActionRequest): Promise<unknown> {
    const pending = super._perform(request);
    this.pendingReads.add(pending);
    try {
      return await pending;
    } finally {
      this.pendingReads.delete(pending);
    }
  }

  override destroy(): Promise<void> {
    this.closing ??= this.closeAfterReads();
    return this.closing;
  }

  private async closeAfterReads(): Promise<void> {
    // A mined receipt can wake multiple Ethers polls. tx.wait() resolves on the
    // first, while another still reads confirmations. Cancelling that read in
    // destroy() rejects an unowned Ethers listener and can kill the Runtime.
    await this.removeAllListeners();
    try {
      const failures: unknown[] = [];
      while (this.pendingReads.size > 0) {
        const results = await Promise.allSettled(this.pendingReads);
        for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      }
      if (failures.length > 0) throw new AggregateError(failures, 'RPC_CLOSE_READ_FAILED');
    } finally {
      super.destroy();
    }
  }
}

/** Publicly known Hardhat account #0 key, allowed only on local dev chains. */
export const DEFAULT_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

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

const xlnJsonRpcProviderOptions = (network?: ethers.Networkish): ethers.JsonRpcApiProviderOptions => ({
  // Ethers caches low-level perform calls for 250ms and batches same-tick
  // requests. Both behaviours can expose stale state on fast local chains.
  cacheTimeout: -1,
  batchMaxCount: 1,
  // Jurisdiction URLs are immutable Runtime configuration. Binding the
  // network once avoids an unrelated eth_chainId lookup before each call.
  ...(network === undefined ? {} : { staticNetwork: ethers.Network.from(network) }),
});

export const createXlnJsonRpcProvider = (rpcUrl: string, network?: ethers.Networkish): ethers.JsonRpcProvider =>
  new XlnJsonRpcProvider(rpcUrl, network, xlnJsonRpcProviderOptions(network));

const configureRpcPolling = (provider: ethers.JsonRpcProvider): void => {
  const configuredInterval =
    typeof process !== 'undefined' && process.env ? process.env['XLN_RPC_POLLING_INTERVAL_MS'] : undefined;
  const rawInterval = Number(configuredInterval ?? DEFAULT_RPC_POLLING_INTERVAL_MS);
  if (!Number.isFinite(rawInterval) || rawInterval <= 0) return;
  provider.pollingInterval = Math.floor(rawInterval);
};

/**
 * Wallet nonce allocation belongs to the external RPC adapter, never to RJEA
 * state. It serializes rapid submissions when an RPC node reports a stale
 * pending nonce; finalized J events remain the deterministic source of truth.
 */
class NonceTrackingWallet extends ethers.Wallet {
  private managedNonce = -1;

  override async populateTransaction(tx: ethers.TransactionRequest): Promise<ethers.TransactionLike<string>> {
    const explicitNonce =
      typeof tx.nonce === 'number' ? tx.nonce : typeof tx.nonce === 'bigint' ? Number(tx.nonce) : null;

    if (explicitNonce !== null) {
      this.managedNonce = Math.max(this.managedNonce, explicitNonce + 1);
      return super.populateTransaction({ ...tx, nonce: explicitNonce });
    }

    if (this.managedNonce === -1) {
      const address = await this.getAddress();
      this.managedNonce = await this.provider!.getTransactionCount(address, 'pending');
    }
    return super.populateTransaction({ ...tx, nonce: this.managedNonce++ });
  }

  resetNonce(): void {
    this.managedNonce = -1;
  }
}

const createBrowserAdapter = async (config: JAdapterConfig, privateKey: string | undefined): Promise<JAdapter> => {
  const { BrowserVMProvider } = await import('../browservm/browservm-provider');
  const browserVM = new BrowserVMProvider();
  await browserVM.init({ chainId: config.chainId });
  if (config.browserVMState) await browserVM.restoreState(config.browserVMState);

  const { BrowserVMEthersProvider } = await import('../browservm/browservm-ethers-provider');
  const provider = new BrowserVMEthersProvider(browserVM);
  if (!privateKey) throw new Error('BROWSERVM_SIGNER_KEY_REQUIRED');
  return createBrowserVMAdapter(config, provider, new NonceTrackingWallet(privateKey, provider), browserVM);
};

const createNetworkAdapter = async (config: JAdapterConfig, privateKey: string | undefined): Promise<JAdapter> => {
  if (!config.rpcUrl) throw new Error('rpcUrl required for anvil/rpc/tron mode');

  // Native authority attests the configured endpoint identity. Rewriting its
  // host here disconnects the observed receipt source from the committed J RPC.
  const rpcUrl = config.mode === 'tron' ? config.rpcUrl : normalizeLoopbackUrl(config.rpcUrl);
  const provider = createXlnJsonRpcProvider(rpcUrl, config.chainId);
  configureRpcPolling(provider);
  const tronApiKey = config.mode === 'tron' ? config.tronApiKey || process.env['TRONGRID_API_KEY'] : undefined;
  const signer =
    config.mode === 'tron' && privateKey
      ? await (
          await import('../operations/tron-signer')
        ).createTronSigner({
          provider,
          privateKey,
          rpcUrl,
          fullHost: config.tronFullHost,
          solidityHost: config.tronSolidityHost,
          apiKey: tronApiKey,
        })
      : privateKey
        ? new NonceTrackingWallet(privateKey, provider)
        : new ethers.VoidSigner(ethers.ZeroAddress, provider);

  return createRpcAdapter({ ...config, rpcUrl, ...(tronApiKey ? { tronApiKey } : {}) }, provider, signer);
};

/** Build the external Jurisdiction adapter selected by immutable Runtime config. */
export const createJAdapter = async (config: JAdapterConfig): Promise<JAdapter> => {
  const effectiveConfig: JAdapterConfig =
    config.mode === 'rpc' && TRON_CHAIN_IDS.has(config.chainId) ? { ...config, mode: 'tron' } : config;
  const privateKey = resolveJAdapterPrivateKey(effectiveConfig);
  return effectiveConfig.mode === 'browservm'
    ? createBrowserAdapter(effectiveConfig, privateKey)
    : createNetworkAdapter(effectiveConfig, privateKey);
};
