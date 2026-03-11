import { ethers } from 'ethers';
import { ERC20Mock__factory } from '../../jurisdictions/typechain-types/index.ts';
import { deriveSignerKeySync } from '../account-crypto';
import type { JAdapter, JTokenInfo } from '../jadapter/types';

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

const createJsonResponse = (
  headers: Record<string, string>,
  payload: unknown,
  status = 200,
): Response =>
  new Response(JSON.stringify(payload), {
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
  const userAddress = String(body.userAddress || '').trim();
  const tokenSymbol = String(body.tokenSymbol || 'USDC').trim().toUpperCase();
  const amount = String(body.amount || '100').trim();
  return { userAddress, tokenSymbol, amount };
};

const readGasFaucetBody = async (request: Request): Promise<GasFaucetRequestBody> => {
  const body = await request.json() as Record<string, unknown>;
  const userAddress = String(body.userAddress || '').trim();
  const amount = String(body.amount || '0.1').trim();
  return { userAddress, amount };
};

const getFaucetWallet = (context: ExternalWalletApiContext, adapter: JAdapter): ethers.Wallet => {
  const privateKeyBytes = deriveSignerKeySync(context.faucetSeed, context.faucetSignerLabel);
  return new ethers.Wallet(ethers.hexlify(privateKeyBytes), adapter.provider);
};

const provisionFaucetWalletFunding = async (
  context: ExternalWalletApiContext,
  adapter: JAdapter,
  tokenCatalog: JTokenInfo[],
  options: {
    ensureEth: boolean;
    ensureTokens: boolean;
  },
): Promise<ethers.Wallet> => {
  const faucetWallet = getFaucetWallet(context, adapter);
  const faucetAddress = await faucetWallet.getAddress();
  const deployerAddress = await adapter.signer.getAddress().catch(() => '');
  let nextNonce = deployerAddress
    ? await adapter.provider.getTransactionCount(deployerAddress, 'pending').catch(() => -1)
    : -1;

  if (adapter.mode === 'browservm') {
    if (options.ensureEth) {
      const funded = await context.fundBrowserVmWallet(faucetAddress, context.faucetWalletEthTarget);
      if (!funded) throw new Error('BROWSERVM_FAUCET_UNAVAILABLE');
    }
    return faucetWallet;
  }

  if (options.ensureTokens) {
    for (const token of tokenCatalog) {
      const tokenContract = ERC20Mock__factory.connect(token.address, adapter.signer);
      const currentBalance = await tokenContract.balanceOf(faucetAddress);
      const targetBalance = context.faucetTokenTargetUnits * 10n ** BigInt(token.decimals);
      console.log(
        `[EXT-FAUCET/PROVISION] token=${token.symbol} faucet=${faucetAddress} current=${currentBalance.toString()} target=${targetBalance.toString()}`,
      );
      if (currentBalance >= targetBalance) continue;
      console.log(
        `[EXT-FAUCET/PROVISION] token-transfer-start token=${token.symbol} deployer=${deployerAddress || 'unknown'} nonce=${nextNonce}`,
      );
      const refillTx = await tokenContract.transfer(
        faucetAddress,
        targetBalance - currentBalance,
        nextNonce >= 0 ? { nonce: nextNonce } : {},
      );
      if (nextNonce >= 0) nextNonce += 1;
      console.log(`[EXT-FAUCET/PROVISION] token-transfer-tx token=${token.symbol} hash=${refillTx.hash}`);
      await refillTx.wait();
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
        `[EXT-FAUCET/PROVISION] eth-topup-start deployer=${deployerAddress || 'unknown'} nonce=${nextNonce}`,
      );
      const topupTx = await adapter.signer.sendTransaction({
        to: faucetAddress,
        value: context.faucetWalletEthTarget - currentEth,
        ...(nextNonce >= 0 ? { nonce: nextNonce } : {}),
      });
      if (nextNonce >= 0) nextNonce += 1;
      console.log(`[EXT-FAUCET/PROVISION] eth-topup-tx hash=${topupTx.hash}`);
      await topupTx.wait();
      console.log(`[EXT-FAUCET/PROVISION] eth-topup-mined hash=${topupTx.hash}`);
    }
  }

  return faucetWallet;
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
): Promise<ethers.Wallet> => {
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
    const tokenContract = ERC20Mock__factory.connect(tokenInfo.address, adapter.provider);
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
  const faucetLock = createFaucetLock();

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
    await faucetLock.acquire();
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
      }

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
      const faucetAddress = await faucetWallet.getAddress();
      let nextNonce = await adapter.provider.getTransactionCount(faucetAddress, 'pending');

      console.log(`[EXT-FAUCET/ERC20 ${requestId}] transfer token=${tokenInfo.symbol} amountWei=${amountWei}`);
      const tokenContract = ERC20Mock__factory.connect(tokenInfo.address, faucetWallet);
      const transferTx = await tokenContract.transfer(userAddress, amountWei, { nonce: nextNonce });
      nextNonce += 1;
      console.log(`[EXT-FAUCET/ERC20 ${requestId}] transfer tx=${transferTx.hash} waiting`);
      await transferTx.wait();
      console.log(`[EXT-FAUCET/ERC20 ${requestId}] transfer mined`);

      if (userEth < minBalance) {
        console.log(`[EXT-FAUCET/ERC20 ${requestId}] topping up gas currentEth=${userEth}`);
        const topupTx = await faucetWallet.sendTransaction({
          to: userAddress,
          value: targetBalance - userEth,
          nonce: nextNonce,
        });
        nextNonce += 1;
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
    } finally {
      faucetLock.release();
    }
  };

  const handleGasFaucet = async (request: Request): Promise<Response> => {
    await faucetLock.acquire();
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
      const faucetWallet = await requireFaucetWalletBalances(context, adapter, [], {
        requiredEth: topupAmount + ethers.parseEther('0.01'),
      });
      const faucetAddress = await faucetWallet.getAddress();
      const nextNonce = await adapter.provider.getTransactionCount(faucetAddress, 'pending');
      console.log(`[EXT-FAUCET/GAS ${requestId}] sending topup wei=${topupAmount}`);
      const tx = await faucetWallet.sendTransaction({
        to: userAddress,
        value: topupAmount,
        nonce: nextNonce,
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[EXT-FAUCET/GAS] failed:', message);
      return createJsonResponse(context.jsonHeaders, { error: message }, 500);
    } finally {
      faucetLock.release();
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
