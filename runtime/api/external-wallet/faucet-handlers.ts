import { ethers } from 'ethers';
import { ERC20Mock__factory } from '../../../jurisdictions/typechain-types/index.ts';
import type { JAdapter, JTokenInfo } from '../../jurisdiction/adapter/types';
import type { ExternalWalletApiContext } from './context';
import {
  requireFaucetWalletBalances,
  toErc20ContractRunner,
  waitForFaucetTx,
  type WaitableTransaction,
  withFaucetWalletLock,
} from './faucet-wallet';
import { createJsonResponse, externalWalletLog, readFaucetBody, readGasFaucetBody } from './http';

interface Erc20FaucetRequest {
  requestId: string;
  userAddress: string;
  tokenSymbol: string;
  amount: string;
  amountWei: bigint;
  token: JTokenInfo;
}

const emitErc20Delivered = (
  context: ExternalWalletApiContext,
  request: Erc20FaucetRequest,
  details: Record<string, unknown>,
): void => {
  context.emitDebugEvent({
    event: 'debug_event',
    runtimeId: context.getRuntimeId(),
    status: 'delivered',
    reason: 'FAUCET_ERC20_OK',
    details: {
      requestId: request.requestId,
      userAddress: request.userAddress,
      tokenSymbol: request.tokenSymbol,
      amount: request.amount,
      ...details,
    },
  });
};

const handleBrowserVmErc20Faucet = (
  context: ExternalWalletApiContext,
  adapter: JAdapter,
  request: Erc20FaucetRequest,
): Promise<Response> =>
  withFaucetWalletLock(context, adapter, async () => {
    const funded = await context.fundBrowserVmWallet(request.userAddress, request.amountWei, request.token.symbol);
    if (!funded) {
      return createJsonResponse(context.jsonHeaders, { error: 'BrowserVM faucet unavailable' }, 503);
    }
    emitErc20Delivered(context, request, { transport: 'browservm' });
    return createJsonResponse(context.jsonHeaders, {
      success: true,
      type: 'erc20',
      amount: request.amount,
      tokenSymbol: request.tokenSymbol,
      userAddress: request.userAddress,
      requestId: request.requestId,
    });
  });

const transferErc20AndGas = async (
  context: ExternalWalletApiContext,
  adapter: JAdapter,
  tokens: JTokenInfo[],
  request: Erc20FaucetRequest,
): Promise<Response> =>
  withFaucetWalletLock(context, adapter, async () => {
    const userEth = await adapter.provider.getBalance(request.userAddress);
    const minBalance = ethers.parseEther('0.01');
    const targetBalance = ethers.parseEther('0.1');
    const userTopup = userEth < minBalance ? targetBalance - userEth : 0n;
    const wallet = await requireFaucetWalletBalances(context, adapter, tokens, {
      requiredEth: ethers.parseEther('0.02') + userTopup,
      requiredTokenAddress: request.token.address,
      requiredTokenAmount: request.amountWei,
    });
    const contract = ERC20Mock__factory.connect(request.token.address, toErc20ContractRunner(wallet, 'faucetWallet'));
    const transferTx = await contract.transfer(request.userAddress, request.amountWei);
    const topupTx: WaitableTransaction | null =
      userTopup > 0n ? await wallet.sendTransaction({ to: request.userAddress, value: userTopup }) : null;
    if (topupTx) {
      externalWalletLog.debug('faucet.erc20.gas_topup_tx', {
        requestId: request.requestId,
        txHash: topupTx.hash,
      });
    }
    await Promise.all([
      waitForFaucetTx(transferTx, 'user-token-transfer', {
        requestId: request.requestId,
        userAddress: request.userAddress,
        tokenSymbol: request.tokenSymbol,
      }),
      ...(topupTx
        ? [
            waitForFaucetTx(topupTx, 'user-gas-topup', {
              requestId: request.requestId,
              userAddress: request.userAddress,
            }),
          ]
        : []),
    ]);
    const ethTxHash = topupTx?.hash ?? '';
    emitErc20Delivered(context, request, { txHash: transferTx.hash, ethTxHash });
    return createJsonResponse(context.jsonHeaders, {
      success: true,
      type: 'erc20',
      amount: request.amount,
      tokenSymbol: request.tokenSymbol,
      userAddress: request.userAddress,
      txHash: transferTx.hash,
      ethTxHash,
      requestId: request.requestId,
    });
  });

const parseErc20FaucetRequest = async (
  context: ExternalWalletApiContext,
  request: Request,
): Promise<{ tokens: JTokenInfo[]; request: Erc20FaucetRequest } | Response> => {
  const body = await readFaucetBody(request);
  if (!ethers.isAddress(body.userAddress)) {
    return createJsonResponse(context.jsonHeaders, { error: 'Invalid userAddress' }, 400);
  }
  const tokens = await context.getTokenCatalog();
  const token = tokens.find(item => item.symbol.toUpperCase() === body.tokenSymbol);
  if (!token) {
    return createJsonResponse(context.jsonHeaders, { error: `Token ${body.tokenSymbol} not found` }, 404);
  }
  if (!Number.isSafeInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) {
    throw new Error(`FAUCET_TOKEN_DECIMALS_INVALID:${token.symbol}:${String(token.decimals)}`);
  }
  return {
    tokens,
    request: {
      ...body,
      requestId: crypto.randomUUID(),
      amountWei: ethers.parseUnits(body.amount, token.decimals),
      token,
    },
  };
};

export const handleErc20Faucet = async (context: ExternalWalletApiContext, request: Request): Promise<Response> => {
  try {
    const adapter = context.getJAdapter();
    if (!adapter) {
      return createJsonResponse(context.jsonHeaders, { error: 'J-adapter not initialized' }, 503);
    }
    const parsed = await parseErc20FaucetRequest(context, request);
    if (parsed instanceof Response) return parsed;
    context.emitDebugEvent({
      event: 'debug_event',
      runtimeId: context.getRuntimeId(),
      status: 'info',
      reason: 'FAUCET_ERC20_REQUEST',
      details: {
        requestId: parsed.request.requestId,
        userAddress: parsed.request.userAddress,
        tokenSymbol: parsed.request.tokenSymbol,
        amount: parsed.request.amount,
      },
    });
    return adapter.mode === 'browservm'
      ? handleBrowserVmErc20Faucet(context, adapter, parsed.request)
      : transferErc20AndGas(context, adapter, parsed.tokens, parsed.request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    externalWalletLog.error('faucet.erc20.failed', { error: message });
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

export const handleGasFaucet = async (context: ExternalWalletApiContext, request: Request): Promise<Response> => {
  try {
    const adapter = context.getJAdapter();
    if (!adapter) {
      return createJsonResponse(context.jsonHeaders, { error: 'J-adapter not initialized' }, 503);
    }
    const { userAddress, amount } = await readGasFaucetBody(request);
    if (!ethers.isAddress(userAddress)) {
      return createJsonResponse(context.jsonHeaders, { error: 'Invalid userAddress' }, 400);
    }
    const requestId = crypto.randomUUID();
    const topupAmount = ethers.parseEther(amount);
    return await withFaucetWalletLock(context, adapter, async () => {
      const wallet = await requireFaucetWalletBalances(context, adapter, [], {
        requiredEth: topupAmount + ethers.parseEther('0.01'),
      });
      const tx = await wallet.sendTransaction({ to: userAddress, value: topupAmount });
      await tx.wait();
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
    externalWalletLog.error('faucet.gas.failed', { error: message });
    return createJsonResponse(context.jsonHeaders, { error: message }, 500);
  }
};
