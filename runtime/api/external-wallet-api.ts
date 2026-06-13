import { ethers } from 'ethers';
import { ERC20Mock__factory } from '../../jurisdictions/typechain-types/index.ts';
import { deriveSignerKeySync } from '../account-crypto';
import type { JAdapter, JTokenInfo } from '../jadapter/types';
import { safeStringify } from '../serialization-utils';

type Erc20ContractRunner = NonNullable<Parameters<typeof ERC20Mock__factory.connect>[1]>;

export type ExternalWalletApiContext = {
  getJAdapter: () => JAdapter | null;
  getRuntimeId: () => string;
  getTokenCatalog: () => Promise<JTokenInfo[]>;
  jsonHeaders: Record<string, string>;
  faucetSeed: string;
  faucetSignerLabel: string;
  faucetWalletEthTarget: bigint;
  faucetTokenTargetUnits: bigint;
  emitDebugEvent: (entry: {
    event: string;
    runtimeId: string;
    status: string;
    reason: string;
    details: Record<string, unknown>;
  }) => void;
  fundBrowserVmWallet: (address: string, amount: bigint) => Promise<boolean>;
};

type FaucetRequestBody = {
  userAddress: string;
  tokenSymbol: string;
  amount: string;
};

type GasFaucetRequestBody = {
  userAddress: string;
  amount: string;
};

type FaucetLock = {
  locked: boolean;
  queue: Array<() => void>;
  acquire: () => Promise<void>;
  release: () => void;
};

type FaucetWalletState = {
  provider: ethers.Provider;
  wallet: ethers.NonceManager;
  lock: FaucetLock;
};

type WaitableTransaction = {
  hash: string;
  wait: (confirms?: number, timeout?: number) => Promise<unknown | null>;
};

const readPositiveIntEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name] || '');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

const FAUCET_TX_WAIT_TIMEOUT_MS = readPositiveIntEnv('XLN_FAUCET_TX_WAIT_TIMEOUT_MS', 20_000);

const createJsonResponse = (
  headers: Record<string, string>,
  payload: unknown,
  status = 200,
): Response =>
  new Response(safeStringify(payload), {
    status,
    headers,
  });

const createFaucetLock = (): FaucetLock => ({
  locked: false,
  queue: [],
  async acquire() {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  },
  release() {
    if (!this.locked) {
      throw new Error('FAUCET_LOCK_RELEASE_WITHOUT_ACQUIRE');
    }
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  },
});

const readFaucetBody = async (request: Request): Promise<FaucetRequestBody> => {
  const body = await request.json() as Record<string, unknown>;
  const userAddress = String(body['userAddress'] || '').trim();
  const tokenSymbol = String(body['tokenSymbol'] || 'USDC').trim().toUpperCase();
  const amount = String(body['amount'] || '100').trim();
  return { userAddress, tokenSymbol, amount };
};

const readGasFaucetBody = async (request: Request): Promise<GasFaucetRequestBody> => {
  const body = await request.json() as Record<string, unknown>;
  const userAddress = String(body['userAddress'] || '').trim();
  const amount = String(body['amount'] || '0.1').trim();
  return { userAddress, amount };
};

const toErc20ContractRunner = (runner: unknown, label: string): Erc20ContractRunner => {
  if (!runner || typeof runner !== 'object') {
    throw new Error(`INVALID_ERC20_CONTRACT_RUNNER: ${label}`);
  }
  // TypeChain was generated under jurisdictions/node_modules/ethers while runtime imports root ethers.
  // Both expose the same v6 ContractRunner surface; keep the package-boundary cast local and explicit.
  return runner as Erc20ContractRunner;
};

const providerIdentityByObject = new Map<object, string>();
const faucetWalletStateByKey = new Map<string, FaucetWalletState>();
let providerIdentityCounter = 0;

const resolveProviderIdentity = (provider: ethers.Provider): string => {
  const maybeJsonRpcProvider = provider as ethers.Provider & {
    _getConnection?: () => { url?: string };
    connection?: { url?: string };
  };
  const connectionUrl = maybeJsonRpcProvider._getConnection?.().url ?? maybeJsonRpcProvider.connection?.url;
  if (connectionUrl) return `rpc:${connectionUrl}`;

  const providerObject = provider as object;
  const cached = providerIdentityByObject.get(providerObject);
  if (cached) return cached;

  providerIdentityCounter += 1;
  const identity = `provider:${providerIdentityCounter}`;
  providerIdentityByObject.set(providerObject, identity);
  return identity;
};

const resolveFaucetWalletStateKey = (
  adapter: JAdapter,
  faucetAddress: string,
): string => [
  adapter.mode,
  String(adapter.chainId),
  resolveProviderIdentity(adapter.provider),
  faucetAddress.toLowerCase(),
].join(':');

const getFaucetWalletState = (context: ExternalWalletApiContext, adapter: JAdapter): FaucetWalletState => {
  const privateKeyBytes = deriveSignerKeySync(context.faucetSeed, context.faucetSignerLabel);
  const wallet = new ethers.Wallet(ethers.hexlify(privateKeyBytes), adapter.provider);
  const cacheKey = resolveFaucetWalletStateKey(adapter, wallet.address);
  const cached = faucetWalletStateByKey.get(cacheKey);
  if (cached) {
    if (cached.provider !== adapter.provider) {
      cached.provider = adapter.provider;
      cached.wallet = new ethers.NonceManager(wallet);
    }
    return cached;
  }
  const state: FaucetWalletState = {
    provider: adapter.provider,
    wallet: new ethers.NonceManager(wallet),
    lock: createFaucetLock(),
  };
  faucetWalletStateByKey.set(cacheKey, state);
  return state;
};

const getFaucetWallet = (context: ExternalWalletApiContext, adapter: JAdapter): ethers.NonceManager =>
  getFaucetWalletState(context, adapter).wallet;

const withFaucetWalletLock = async <T>(
  context: ExternalWalletApiContext,
  adapter: JAdapter,
  action: (faucetWallet: ethers.NonceManager) => Promise<T>,
): Promise<T> => {
  const state = getFaucetWalletState(context, adapter);
  const faucetWallet = state.wallet;
  await state.lock.acquire();
  try {
    return await action(faucetWallet);
  } finally {
    state.lock.release();
  }
};

const waitForFaucetProvisionTx = async (
  tx: WaitableTransaction,
  label: string,
  details: Record<string, unknown>,
): Promise<void> => {
  try {
    const receipt = await tx.wait(1, FAUCET_TX_WAIT_TIMEOUT_MS);
    if (!receipt) {
      throw new Error('receipt_timeout');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`FAUCET_PROVISION_TX_WAIT_FAILED:${safeStringify({
      label,
      hash: tx.hash,
      timeoutMs: FAUCET_TX_WAIT_TIMEOUT_MS,
      error: message,
      ...details,
    })}`);
  }
};

const provisionFaucetWalletFunding = async (
  context: ExternalWalletApiContext,
  adapter: JAdapter,
  tokenCatalog: JTokenInfo[],
  options: {
    ensureEth: boolean;
    ensureTokens: boolean;
  },
) : Promise<ethers.NonceManager> => {
  return withFaucetWalletLock(context, adapter, async (faucetWallet) => {
    const faucetAddress = await faucetWallet.getAddress();
    const deployerAddress = await adapter.signer.getAddress().catch(() => '');

    if (adapter.mode === 'browservm') {
      if (options.ensureEth) {
        const funded = await context.fundBrowserVmWallet(faucetAddress, context.faucetWalletEthTarget);
        if (!funded) throw new Error('BROWSERVM_FAUCET_UNAVAILABLE');
      }
      return faucetWallet;
    }

    if (options.ensureTokens) {
      for (const token of tokenCatalog) {
        const tokenContract = ERC20Mock__factory.connect(
          token.address,
          toErc20ContractRunner(adapter.signer, 'adapter.signer'),
        );
        const currentBalance = await tokenContract.balanceOf(faucetAddress);
        const targetBalance = context.faucetTokenTargetUnits * 10n ** BigInt(token.decimals);
        console.log(
          `[EXT-FAUCET/PROVISION] token=${token.symbol} faucet=${faucetAddress} current=${currentBalance.toString()} target=${targetBalance.toString()}`,
        );
        if (currentBalance >= targetBalance) continue;
        console.log(
          `[EXT-FAUCET/PROVISION] token-transfer-start token=${token.symbol} deployer=${deployerAddress || 'unknown'}`,
        );
        const refillTx = await tokenContract.transfer(
          faucetAddress,
          targetBalance - currentBalance,
        );
        console.log(`[EXT-FAUCET/PROVISION] token-transfer-tx token=${token.symbol} hash=${refillTx.hash}`);
        await waitForFaucetProvisionTx(refillTx, 'token-transfer', {
          token: token.symbol,
          tokenAddress: token.address,
          faucetAddress,
          deployerAddress,
          currentBalance: currentBalance.toString(),
          targetBalance: targetBalance.toString(),
        });
        console.log(`[EXT-FAUCET/PROVISION] token-transfer-mined token=${token.symbol} hash=${refillTx.hash}`);
      }
    }

    if (options.ensureEth) {
      const currentEth = await adapter.provider.getBalance(faucetAddress);
      console.log(
        `[EXT-FAUCET/PROVISION] eth faucet=${faucetAddress} current=${currentEth.toString()} target=${context.faucetWalletEthTarget.toString()}`,
      );
      if (currentEth < context.faucetWalletEthTarget) {
        console.log(
          `[EXT-FAUCET/PROVISION] eth-topup-start deployer=${deployerAddress || 'unknown'}`,
        );
        const topupTx = await adapter.signer.sendTransaction({
          to: faucetAddress,
          value: context.faucetWalletEthTarget - currentEth,
        });
        console.log(`[EXT-FAUCET/PROVISION] eth-topup-tx hash=${topupTx.hash}`);
        await waitForFaucetProvisionTx(topupTx, 'eth-topup', {
          faucetAddress,
          deployerAddress,
          currentEth: currentEth.toString(),
          targetEth: context.faucetWalletEthTarget.toString(),
        });
        console.log(`[EXT-FAUCET/PROVISION] eth-topup-mined hash=${topupTx.hash}`);
      }
    }

    return faucetWallet;
  });
};

const requireFaucetWalletBalances = async (
  context: ExternalWalletApiContext,
  adapter: JAdapter,
  tokenCatalog: JTokenInfo[],
  options: {
    requiredEth: bigint;
    requiredTokenAddress?: string;
    requiredTokenAmount?: bigint;
  },
) : Promise<ethers.NonceManager> => {
  const faucetWallet = getFaucetWallet(context, adapter);
  const faucetAddress = await faucetWallet.getAddress();

  if (adapter.mode === 'browservm') {
    return faucetWallet;
  }

  const currentEth = await adapter.provider.getBalance(faucetAddress);
  if (currentEth < options.requiredEth) {
    throw new Error(
      `FAUCET_WALLET_ETH_UNDERFUNDED current=${currentEth.toString()} required=${options.requiredEth.toString()}`,
    );
  }

  if (options.requiredTokenAddress && options.requiredTokenAmount && options.requiredTokenAmount > 0n) {
    const tokenInfo = tokenCatalog.find((token) =>
      String(token.address || '').toLowerCase() === String(options.requiredTokenAddress || '').toLowerCase(),
    );
    if (!tokenInfo) {
      throw new Error(`FAUCET_TOKEN_UNKNOWN address=${options.requiredTokenAddress}`);
    }
    const tokenContract = ERC20Mock__factory.connect(
      tokenInfo.address,
      toErc20ContractRunner(adapter.provider, 'adapter.provider'),
    );
    const currentBalance = await tokenContract.balanceOf(faucetAddress);
    if (currentBalance < options.requiredTokenAmount) {
      throw new Error(
        `FAUCET_WALLET_TOKEN_UNDERFUNDED token=${tokenInfo.symbol} current=${currentBalance.toString()} required=${options.requiredTokenAmount.toString()}`,
      );
    }
  }

  return faucetWallet;
};

export const createExternalWalletApi = (context: ExternalWalletApiContext) => {
  const handleTokens = async (): Promise<Response> => {
    const adapter = context.getJAdapter();
    if (!adapter) {
      return createJsonResponse(context.jsonHeaders, { error: 'J-adapter not initialized' }, 503);
    }

    try {
      const tokens = await context.getTokenCatalog();
      return createJsonResponse(context.jsonHeaders, { tokens });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createJsonResponse(context.jsonHeaders, { error: message }, 500);
    }
  };

  const handleErc20Faucet = async (request: Request): Promise<Response> => {
    try {
      const adapter = context.getJAdapter();
      if (!adapter) {
        return createJsonResponse(context.jsonHeaders, { error: 'J-adapter not initialized' }, 503);
      }

      const requestId = crypto.randomUUID();
      const { userAddress, tokenSymbol, amount } = await readFaucetBody(request);
      console.log(`[EXT-FAUCET/ERC20 ${requestId}] request to=${userAddress} token=${tokenSymbol} amount=${amount}`);
      if (!ethers.isAddress(userAddress)) {
        return createJsonResponse(context.jsonHeaders, { error: 'Invalid userAddress' }, 400);
      }

      context.emitDebugEvent({
        event: 'debug_event',
        runtimeId: context.getRuntimeId(),
        status: 'info',
        reason: 'FAUCET_ERC20_REQUEST',
        details: { requestId, userAddress, tokenSymbol, amount },
      });

      if (adapter.mode === 'browservm') {
        return await withFaucetWalletLock(context, adapter, async () => {
          const amountWei = ethers.parseUnits(amount, 18);
          console.log(`[EXT-FAUCET/ERC20 ${requestId}] browservm fund amountWei=${amountWei}`);
          const funded = await context.fundBrowserVmWallet(userAddress, amountWei);
          if (!funded) {
            return createJsonResponse(context.jsonHeaders, { error: 'BrowserVM faucet unavailable' }, 503);
          }
          context.emitDebugEvent({
            event: 'debug_event',
            runtimeId: context.getRuntimeId(),
            status: 'delivered',
            reason: 'FAUCET_ERC20_BROWSER_VM_OK',
            details: { requestId, userAddress, tokenSymbol, amount },
          });
          return createJsonResponse(context.jsonHeaders, {
            success: true,
            type: 'erc20',
            amount,
            tokenSymbol,
            userAddress,
            requestId,
          });
        });
      }

      return await withFaucetWalletLock(context, adapter, async () => {
        const tokens = await context.getTokenCatalog();
        console.log(`[EXT-FAUCET/ERC20 ${requestId}] token catalog size=${tokens.length}`);
        const tokenInfo = tokens.find((token) => token.symbol.toUpperCase() === tokenSymbol);
        if (!tokenInfo) {
          return createJsonResponse(context.jsonHeaders, { error: `Token ${tokenSymbol} not found` }, 404);
        }

        const amountWei = ethers.parseUnits(amount, tokenInfo.decimals);
        let ethTxHash = '';
        const userEth = await adapter.provider.getBalance(userAddress);
        const minBalance = ethers.parseEther('0.01');
        const targetBalance = ethers.parseEther('0.1');
        const userTopupAmount = userEth < minBalance ? targetBalance - userEth : 0n;

        console.log(`[EXT-FAUCET/ERC20 ${requestId}] checking faucet wallet balances`);
        const faucetWallet = await requireFaucetWalletBalances(context, adapter, tokens, {
          requiredEth: ethers.parseEther('0.02') + userTopupAmount,
          requiredTokenAddress: tokenInfo.address,
          requiredTokenAmount: amountWei,
        });
        console.log(`[EXT-FAUCET/ERC20 ${requestId}] transfer token=${tokenInfo.symbol} amountWei=${amountWei}`);
        const tokenContract = ERC20Mock__factory.connect(
          tokenInfo.address,
          toErc20ContractRunner(faucetWallet, 'faucetWallet'),
        );
        const transferTx = await tokenContract.transfer(userAddress, amountWei);
        console.log(`[EXT-FAUCET/ERC20 ${requestId}] transfer tx=${transferTx.hash} waiting`);
        await transferTx.wait();
        console.log(`[EXT-FAUCET/ERC20 ${requestId}] transfer mined`);

        if (userEth < minBalance) {
          console.log(`[EXT-FAUCET/ERC20 ${requestId}] topping up gas currentEth=${userEth}`);
          const topupTx = await faucetWallet.sendTransaction({
            to: userAddress,
            value: targetBalance - userEth,
          });
          console.log(`[EXT-FAUCET/ERC20 ${requestId}] topup tx=${topupTx.hash} waiting`);
          await topupTx.wait();
          ethTxHash = topupTx.hash;
          console.log(`[EXT-FAUCET/ERC20 ${requestId}] topup mined`);
        }

        context.emitDebugEvent({
          event: 'debug_event',
          runtimeId: context.getRuntimeId(),
          status: 'delivered',
          reason: 'FAUCET_ERC20_OK',
          details: {
            requestId,
            userAddress,
            tokenSymbol,
            amount,
            txHash: transferTx.hash,
            ethTxHash,
          },
        });
        return createJsonResponse(context.jsonHeaders, {
          success: true,
          type: 'erc20',
          amount,
          tokenSymbol,
          userAddress,
          txHash: transferTx.hash,
          ethTxHash,
          requestId,
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[EXT-FAUCET/ERC20] failed:', message);
      context.emitDebugEvent({
        event: 'error',
        runtimeId: context.getRuntimeId(),
        status: 'failed',
        reason: 'FAUCET_ERC20_FAILED',
        details: { error: message },
      });
      return createJsonResponse(context.jsonHeaders, { error: message }, 500);
    }
  };

  const handleGasFaucet = async (request: Request): Promise<Response> => {
    try {
      const adapter = context.getJAdapter();
      if (!adapter) {
        return createJsonResponse(context.jsonHeaders, { error: 'J-adapter not initialized' }, 503);
      }

      const requestId = crypto.randomUUID();
      const { userAddress, amount } = await readGasFaucetBody(request);
      console.log(`[EXT-FAUCET/GAS ${requestId}] request to=${userAddress} amount=${amount}`);
      if (!ethers.isAddress(userAddress)) {
        return createJsonResponse(context.jsonHeaders, { error: 'Invalid userAddress' }, 400);
      }

      const topupAmount = ethers.parseEther(amount);
      return await withFaucetWalletLock(context, adapter, async () => {
        const faucetWallet = await requireFaucetWalletBalances(context, adapter, [], {
          requiredEth: topupAmount + ethers.parseEther('0.01'),
        });
        console.log(`[EXT-FAUCET/GAS ${requestId}] sending topup wei=${topupAmount}`);
        const tx = await faucetWallet.sendTransaction({
          to: userAddress,
          value: topupAmount,
        });
        console.log(`[EXT-FAUCET/GAS ${requestId}] tx=${tx.hash} waiting`);
        await tx.wait();
        console.log(`[EXT-FAUCET/GAS ${requestId}] mined`);
        return createJsonResponse(context.jsonHeaders, {
          success: true,
          type: 'gas',
          amount,
          userAddress,
          txHash: tx.hash,
          requestId,
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[EXT-FAUCET/GAS] failed:', message);
      return createJsonResponse(context.jsonHeaders, { error: message }, 500);
    }
  };

  return {
    provisionFaucetWallet: async (): Promise<void> => {
      const adapter = context.getJAdapter();
      if (!adapter) throw new Error('J-adapter not initialized');
      const tokens = await context.getTokenCatalog();
      await provisionFaucetWalletFunding(context, adapter, tokens, {
        ensureEth: true,
        ensureTokens: adapter.mode !== 'browservm',
      });
    },
    handleTokens,
    handleErc20Faucet,
    handleGasFaucet,
  };
};
