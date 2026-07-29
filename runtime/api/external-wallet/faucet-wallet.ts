import { ethers } from 'ethers';
import { ERC20Mock__factory } from '../../../jurisdictions/typechain-types/index.ts';
import { deriveSignerKeySync } from '../../account/crypto';
import type { JAdapter, JTokenInfo } from '../../jadapter/types';
import { safeStringify } from '../../protocol/serialization';
import type { ExternalWalletApiContext } from './context';
import { externalWalletLog } from './http';

type Erc20ContractRunner = NonNullable<Parameters<typeof ERC20Mock__factory.connect>[1]>;

interface FaucetLock {
  locked: boolean;
  queue: Array<() => void>;
  acquire(): Promise<void>;
  release(): void;
}

interface FaucetWalletState {
  provider: ethers.Provider;
  wallet: ethers.NonceManager;
  lock: FaucetLock;
}

export interface WaitableTransaction {
  hash: string;
  wait(confirms?: number, timeout?: number): Promise<unknown | null>;
}

const readPositiveIntEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name] || '');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

const FAUCET_TX_WAIT_TIMEOUT_MS = readPositiveIntEnv('XLN_FAUCET_TX_WAIT_TIMEOUT_MS', 20_000);
const FAUCET_REFILL_THRESHOLD_BPS = Math.min(10_000, readPositiveIntEnv('XLN_FAUCET_REFILL_THRESHOLD_BPS', 5_000));

const createFaucetLock = (): FaucetLock => ({
  locked: false,
  queue: [],
  async acquire() {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
  },
  release() {
    if (!this.locked) throw new Error('FAUCET_LOCK_RELEASE_WITHOUT_ACQUIRE');
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  },
});

export const toErc20ContractRunner = (runner: unknown, label: string): Erc20ContractRunner => {
  if (!runner || typeof runner !== 'object') {
    throw new Error(`INVALID_ERC20_CONTRACT_RUNNER: ${label}`);
  }
  // TypeChain and Runtime resolve ethers from different package roots. Keep
  // that structurally identical v6 ContractRunner cast at this one boundary.
  return runner as Erc20ContractRunner;
};

const providerIdentityByObject = new Map<object, string>();
const faucetWalletStateByKey = new Map<string, FaucetWalletState>();
let providerIdentityCounter = 0;

const resolveProviderIdentity = (provider: ethers.Provider): string => {
  const jsonRpcProvider = provider as ethers.Provider & {
    _getConnection?: () => { url?: string };
    connection?: { url?: string };
  };
  const connectionUrl = jsonRpcProvider._getConnection?.().url ?? jsonRpcProvider.connection?.url;
  if (connectionUrl) return `rpc:${connectionUrl}`;
  const cached = providerIdentityByObject.get(provider);
  if (cached) return cached;
  const identity = `provider:${++providerIdentityCounter}`;
  providerIdentityByObject.set(provider, identity);
  return identity;
};

const getFaucetWalletState = (context: ExternalWalletApiContext, adapter: JAdapter): FaucetWalletState => {
  const privateKey = deriveSignerKeySync(context.faucetSeed, context.faucetSignerLabel);
  const wallet = new ethers.Wallet(ethers.hexlify(privateKey), adapter.provider);
  const key = [
    adapter.mode,
    String(adapter.chainId),
    resolveProviderIdentity(adapter.provider),
    wallet.address.toLowerCase(),
  ].join(':');
  const cached = faucetWalletStateByKey.get(key);
  if (cached) {
    if (cached.provider !== adapter.provider) {
      cached.provider = adapter.provider;
      cached.wallet = new ethers.NonceManager(wallet);
    }
    return cached;
  }
  const state = {
    provider: adapter.provider,
    wallet: new ethers.NonceManager(wallet),
    lock: createFaucetLock(),
  };
  faucetWalletStateByKey.set(key, state);
  return state;
};

export const withFaucetWalletLock = async <Result>(
  context: ExternalWalletApiContext,
  adapter: JAdapter,
  action: (wallet: ethers.NonceManager) => Promise<Result>,
): Promise<Result> => {
  const state = getFaucetWalletState(context, adapter);
  await state.lock.acquire();
  try {
    return await action(state.wallet);
  } finally {
    state.lock.release();
  }
};

export const waitForFaucetTx = async (
  tx: WaitableTransaction,
  label: string,
  details: Record<string, unknown>,
): Promise<void> => {
  try {
    if (!(await tx.wait(1, FAUCET_TX_WAIT_TIMEOUT_MS))) throw new Error('receipt_timeout');
  } catch (error) {
    throw new Error(
      `FAUCET_TX_WAIT_FAILED:${safeStringify({
        label,
        hash: tx.hash,
        timeoutMs: FAUCET_TX_WAIT_TIMEOUT_MS,
        error: error instanceof Error ? error.message : String(error),
        ...details,
      })}`,
    );
  }
};

const refillThresholdFor = (target: bigint): bigint => {
  if (target <= 0n) return 0n;
  const threshold = (target * BigInt(FAUCET_REFILL_THRESHOLD_BPS)) / 10_000n;
  return threshold > 0n ? threshold : 1n;
};

const provisionTokenBalance = async (
  context: ExternalWalletApiContext,
  adapter: JAdapter,
  wallet: ethers.NonceManager,
  token: JTokenInfo,
): Promise<void> => {
  const faucetAddress = await wallet.getAddress();
  const contract = ERC20Mock__factory.connect(token.address, toErc20ContractRunner(adapter.signer, 'adapter.signer'));
  const balance = await contract.balanceOf(faucetAddress);
  const target = context.faucetTokenTargetUnits * 10n ** BigInt(token.decimals);
  const threshold = refillThresholdFor(target);
  externalWalletLog.debug('faucet.provision.token_balance', {
    token: token.symbol,
    faucetAddress,
    currentBalance: balance.toString(),
    refillThreshold: threshold.toString(),
    targetBalance: target.toString(),
  });
  if (balance >= threshold) return;
  const tx = await contract.transfer(faucetAddress, target - balance);
  await waitForFaucetTx(tx, 'token-transfer', {
    token: token.symbol,
    tokenAddress: token.address,
    faucetAddress,
    currentBalance: balance.toString(),
    refillThreshold: threshold.toString(),
    targetBalance: target.toString(),
  });
};

const provisionEthBalance = async (
  context: ExternalWalletApiContext,
  adapter: JAdapter,
  faucetAddress: string,
): Promise<void> => {
  const balance = await adapter.provider.getBalance(faucetAddress);
  const threshold = refillThresholdFor(context.faucetWalletEthTarget);
  if (balance >= threshold) return;
  const tx = await adapter.signer.sendTransaction({
    to: faucetAddress,
    value: context.faucetWalletEthTarget - balance,
  });
  await waitForFaucetTx(tx, 'eth-topup', {
    faucetAddress,
    currentEth: balance.toString(),
    refillThreshold: threshold.toString(),
    targetEth: context.faucetWalletEthTarget.toString(),
  });
};

export const provisionFaucetWalletFunding = async (
  context: ExternalWalletApiContext,
  adapter: JAdapter,
  tokens: JTokenInfo[],
  options: { ensureEth: boolean; ensureTokens: boolean },
): Promise<void> => {
  await withFaucetWalletLock(context, adapter, async wallet => {
    const faucetAddress = await wallet.getAddress();
    if (adapter.mode === 'browservm') {
      if (options.ensureEth) {
        const funded = await context.fundBrowserVmWallet(faucetAddress, context.faucetWalletEthTarget);
        if (!funded) throw new Error('BROWSERVM_FAUCET_UNAVAILABLE');
      }
      return;
    }
    if (options.ensureTokens) {
      for (const token of tokens) await provisionTokenBalance(context, adapter, wallet, token);
    }
    if (options.ensureEth) await provisionEthBalance(context, adapter, faucetAddress);
  });
};

export const requireFaucetWalletBalances = async (
  context: ExternalWalletApiContext,
  adapter: JAdapter,
  tokenCatalog: JTokenInfo[],
  options: {
    requiredEth: bigint;
    requiredTokenAddress?: string;
    requiredTokenAmount?: bigint;
  },
): Promise<ethers.NonceManager> => {
  const wallet = getFaucetWalletState(context, adapter).wallet;
  const faucetAddress = await wallet.getAddress();
  if (adapter.mode === 'browservm') return wallet;
  const currentEth = await adapter.provider.getBalance(faucetAddress);
  if (currentEth < options.requiredEth) {
    throw new Error(`FAUCET_WALLET_ETH_UNDERFUNDED current=${currentEth} required=${options.requiredEth}`);
  }
  if (!options.requiredTokenAddress || !options.requiredTokenAmount || options.requiredTokenAmount <= 0n) {
    return wallet;
  }
  const address = options.requiredTokenAddress.toLowerCase();
  const token = tokenCatalog.find(item => item.address.toLowerCase() === address);
  if (!token) throw new Error(`FAUCET_TOKEN_UNKNOWN address=${options.requiredTokenAddress}`);
  const contract = ERC20Mock__factory.connect(
    token.address,
    toErc20ContractRunner(adapter.provider, 'adapter.provider'),
  );
  const balance = await contract.balanceOf(faucetAddress);
  if (balance < options.requiredTokenAmount) {
    throw new Error(
      `FAUCET_WALLET_TOKEN_UNDERFUNDED token=${token.symbol} current=${balance} required=${options.requiredTokenAmount}`,
    );
  }
  return wallet;
};
