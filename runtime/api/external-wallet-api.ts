import { ethers } from 'ethers';
import { ERC20Mock__factory } from '../../jurisdictions/typechain-types/index.ts';
import { deriveSignerKeySync } from '../account-crypto';
import type { JAdapter, JEvent, JTokenInfo, JWalletAllowanceRead } from '../jadapter/types';
import { createStructuredLogger } from '../logger';
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
  observeExternalWalletSnapshot?: (events: JEvent[], label: string) => void;
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

type WalletSnapshotRequestBody = {
  entityId: string;
  owner: string;
  tokenAddresses?: string[];
  allowances?: JWalletAllowanceRead[];
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
const FAUCET_REFILL_THRESHOLD_BPS = Math.min(
  10_000,
  readPositiveIntEnv('XLN_FAUCET_REFILL_THRESHOLD_BPS', 5_000),
);
const externalWalletLog = createStructuredLogger('server.external_wallet');

const createJsonResponse = (
  headers: Record<string, string>,
  payload: unknown,
  status = 200,
): Response =>
  new Response(safeStringify(payload), {
    status,
    headers,
  });

const requireSnapshotBigInt = (value: unknown, label: string): bigint => {
  if (typeof value !== 'bigint') {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_FIELD_MISSING:${label}`);
  }
  return value;
};

const assertSnapshotArrayLength = (values: unknown, expected: number, label: string): void => {
  if (!Array.isArray(values) || values.length !== expected) {
    throw new Error(
      `EXTERNAL_WALLET_SNAPSHOT_FIELD_COUNT_MISMATCH:${label}:expected=${expected}:actual=${
        Array.isArray(values) ? values.length : 'non-array'
      }`,
    );
  }
};

const resolveSnapshotFinalityDepth = (adapter: JAdapter): number => {
  const rawDepth = Number(adapter.getFinalityDepth?.() ?? 0);
  if (!Number.isFinite(rawDepth) || rawDepth < 0) {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_FINALITY_INVALID:${String(rawDepth)}`);
  }
  return Math.floor(rawDepth);
};

const readExternalWalletSnapshotSource = async (
  adapter: JAdapter,
): Promise<{
  headBlockNumber: number;
  sourceHeight: number;
  sourceHash: string;
  finalityDepth: number;
}> => {
  const headBlockNumber = Number(await (adapter.getCurrentBlockNumber?.() ?? adapter.provider.getBlockNumber()));
  if (!Number.isFinite(headBlockNumber) || !Number.isInteger(headBlockNumber) || headBlockNumber < 0) {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_HEAD_INVALID:${String(headBlockNumber)}`);
  }
  const finalityDepth = resolveSnapshotFinalityDepth(adapter);
  const sourceHeight = headBlockNumber - finalityDepth;
  if (sourceHeight < 0) {
    throw new Error(
      `EXTERNAL_WALLET_SNAPSHOT_FINALITY_UNAVAILABLE:head=${headBlockNumber}:depth=${finalityDepth}`,
    );
  }
  const block = await adapter.provider.getBlock(sourceHeight);
  if (!block?.hash) {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_BLOCK_HASH_MISSING:${sourceHeight}`);
  }
  return {
    headBlockNumber,
    sourceHeight,
    sourceHash: block.hash,
    finalityDepth,
  };
};

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

const readWalletSnapshotBody = async (request: Request): Promise<WalletSnapshotRequestBody> => {
  const body = await request.json() as Record<string, unknown>;
  const entityId = String(body['entityId'] || '').trim().toLowerCase();
  const owner = String(body['owner'] || '').trim();
  const tokenAddresses = Array.isArray(body['tokenAddresses'])
    ? body['tokenAddresses'].map((value) => String(value || '').trim()).filter(Boolean)
    : undefined;
  const allowances = Array.isArray(body['allowances'])
    ? body['allowances'].map((value) => {
        const entry = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          tokenAddress: String(entry['tokenAddress'] || '').trim(),
          spender: String(entry['spender'] || '').trim(),
        };
      }).filter((entry) => ethers.isAddress(entry.tokenAddress) && ethers.isAddress(entry.spender))
    : undefined;
  return {
    entityId,
    owner,
    ...(tokenAddresses !== undefined ? { tokenAddresses } : {}),
    ...(allowances !== undefined ? { allowances } : {}),
  };
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

const refillThresholdFor = (target: bigint): bigint => {
  if (target <= 0n) return 0n;
  const threshold = target * BigInt(FAUCET_REFILL_THRESHOLD_BPS) / 10_000n;
  return threshold > 0n ? threshold : 1n;
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
        const refillThreshold = refillThresholdFor(targetBalance);
        externalWalletLog.debug('faucet.provision.token_balance', {
          token: token.symbol,
          faucetAddress,
          currentBalance: currentBalance.toString(),
          refillThreshold: refillThreshold.toString(),
          targetBalance: targetBalance.toString(),
        });
        if (currentBalance >= refillThreshold) continue;
        externalWalletLog.debug('faucet.provision.token_transfer_start', {
          token: token.symbol,
          deployerAddress: deployerAddress || 'unknown',
        });
        const refillTx = await tokenContract.transfer(
          faucetAddress,
          targetBalance - currentBalance,
        );
        externalWalletLog.debug('faucet.provision.token_transfer_tx', {
          token: token.symbol,
          txHash: refillTx.hash,
        });
        await waitForFaucetProvisionTx(refillTx, 'token-transfer', {
          token: token.symbol,
          tokenAddress: token.address,
          faucetAddress,
          deployerAddress,
          currentBalance: currentBalance.toString(),
          refillThreshold: refillThreshold.toString(),
          targetBalance: targetBalance.toString(),
        });
        externalWalletLog.debug('faucet.provision.token_transfer_mined', {
          token: token.symbol,
          txHash: refillTx.hash,
        });
      }
    }

    if (options.ensureEth) {
      const currentEth = await adapter.provider.getBalance(faucetAddress);
      const refillThreshold = refillThresholdFor(context.faucetWalletEthTarget);
      externalWalletLog.debug('faucet.provision.eth_balance', {
        faucetAddress,
        currentEth: currentEth.toString(),
        refillThreshold: refillThreshold.toString(),
        targetEth: context.faucetWalletEthTarget.toString(),
      });
      if (currentEth < refillThreshold) {
        externalWalletLog.debug('faucet.provision.eth_topup_start', {
          deployerAddress: deployerAddress || 'unknown',
        });
        const topupTx = await adapter.signer.sendTransaction({
          to: faucetAddress,
          value: context.faucetWalletEthTarget - currentEth,
        });
        externalWalletLog.debug('faucet.provision.eth_topup_tx', { txHash: topupTx.hash });
        await waitForFaucetProvisionTx(topupTx, 'eth-topup', {
          faucetAddress,
          deployerAddress,
          currentEth: currentEth.toString(),
          refillThreshold: refillThreshold.toString(),
          targetEth: context.faucetWalletEthTarget.toString(),
        });
        externalWalletLog.debug('faucet.provision.eth_topup_mined', { txHash: topupTx.hash });
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
      externalWalletLog.debug('faucet.erc20.request', { requestId, userAddress, tokenSymbol, amount });
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
          externalWalletLog.debug('faucet.erc20.browservm_fund', {
            requestId,
            amountWei: amountWei.toString(),
          });
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
        externalWalletLog.debug('faucet.erc20.token_catalog', { requestId, tokenCount: tokens.length });
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

        externalWalletLog.debug('faucet.erc20.balance_check', { requestId });
        const faucetWallet = await requireFaucetWalletBalances(context, adapter, tokens, {
          requiredEth: ethers.parseEther('0.02') + userTopupAmount,
          requiredTokenAddress: tokenInfo.address,
          requiredTokenAmount: amountWei,
        });
        externalWalletLog.debug('faucet.erc20.transfer_start', {
          requestId,
          token: tokenInfo.symbol,
          amountWei: amountWei.toString(),
        });
        const tokenContract = ERC20Mock__factory.connect(
          tokenInfo.address,
          toErc20ContractRunner(faucetWallet, 'faucetWallet'),
        );
        const transferTx = await tokenContract.transfer(userAddress, amountWei);
        externalWalletLog.debug('faucet.erc20.transfer_tx', { requestId, txHash: transferTx.hash });
        await transferTx.wait();
        externalWalletLog.debug('faucet.erc20.transfer_mined', { requestId, txHash: transferTx.hash });

        if (userEth < minBalance) {
          externalWalletLog.debug('faucet.erc20.gas_topup_start', {
            requestId,
            currentEth: userEth.toString(),
          });
          const topupTx = await faucetWallet.sendTransaction({
            to: userAddress,
            value: targetBalance - userEth,
          });
          externalWalletLog.debug('faucet.erc20.gas_topup_tx', { requestId, txHash: topupTx.hash });
          await topupTx.wait();
          ethTxHash = topupTx.hash;
          externalWalletLog.debug('faucet.erc20.gas_topup_mined', { requestId, txHash: topupTx.hash });
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

  const handleWalletSnapshot = async (request: Request): Promise<Response> => {
    try {
      const adapter = context.getJAdapter();
      if (!adapter) {
        return createJsonResponse(context.jsonHeaders, { error: 'J-adapter not initialized' }, 503);
      }

      const { entityId, owner, tokenAddresses, allowances } = await readWalletSnapshotBody(request);
      if (!entityId.startsWith('0x') || entityId.length !== 66) {
        return createJsonResponse(context.jsonHeaders, { error: 'Invalid entityId' }, 400);
      }
      if (!ethers.isAddress(owner)) {
        return createJsonResponse(context.jsonHeaders, { error: 'Invalid owner' }, 400);
      }

      const tokenCatalog = await context.getTokenCatalog();
      const requestedTokenAddresses = (tokenAddresses && tokenAddresses.length > 0
        ? tokenAddresses
        : tokenCatalog.map((token) => token.address)
      ).filter((address) => ethers.isAddress(address));
      const normalizedOwner = ethers.getAddress(owner).toLowerCase();
      const source = await readExternalWalletSnapshotSource(adapter);
      const snapshot = await adapter.readWalletSnapshot({
        owner: normalizedOwner,
        tokenAddresses: requestedTokenAddresses,
        allowances: allowances ?? [],
        includeNativeBalance: true,
        blockTag: source.sourceHeight,
      });
      assertSnapshotArrayLength(snapshot.tokenBalances, requestedTokenAddresses.length, 'tokenBalances');
      assertSnapshotArrayLength(snapshot.allowances, (allowances ?? []).length, 'allowances');
      const nativeBalance = requireSnapshotBigInt(snapshot.nativeBalance, 'nativeBalance');
      const transactionHash = [
        'external-wallet-snapshot',
        source.sourceHeight,
        entityId,
        normalizedOwner,
      ].join(':');
      const tokenIdByAddress = new Map(
        tokenCatalog
          .filter((token) => ethers.isAddress(token.address))
          .map((token) => [token.address.toLowerCase(), token.tokenId]),
      );
      const tokenErrorByAddress = new Map(
        (snapshot.tokenErrors ?? []).map((entry) => [
          String(entry.tokenAddress || '').trim().toLowerCase(),
          String(entry.error || 'EXTERNAL_WALLET_SNAPSHOT_TOKEN_READ_FAILED'),
        ]),
      );
      const allowanceErrorByKey = new Map(
        (snapshot.allowanceErrors ?? []).map((entry) => [
          `${String(entry.tokenAddress || '').trim().toLowerCase()}:${String(entry.spender || '').trim().toLowerCase()}`,
          String(entry.error || 'EXTERNAL_WALLET_SNAPSHOT_ALLOWANCE_READ_FAILED'),
        ]),
      );
      const tokenBalances = requestedTokenAddresses.map((tokenAddress, index) => {
        const normalizedAddress = ethers.getAddress(tokenAddress).toLowerCase();
        const tokenId = tokenIdByAddress.get(normalizedAddress);
        const tokenError = tokenErrorByAddress.get(normalizedAddress);
        return {
          tokenAddress: normalizedAddress,
          ...(typeof tokenId === 'number' ? { tokenId } : {}),
          balance: requireSnapshotBigInt(snapshot.tokenBalances[index], `tokenBalance:${normalizedAddress}`).toString(),
          ...(tokenError ? { error: tokenError } : {}),
        };
      });
      const allowancePayload = (allowances ?? []).map((entry, index) => {
        const tokenAddress = ethers.getAddress(entry.tokenAddress).toLowerCase();
        const spender = ethers.getAddress(entry.spender).toLowerCase();
        const allowanceError = allowanceErrorByKey.get(`${tokenAddress}:${spender}`);
        return {
          tokenAddress,
          spender,
          allowance: requireSnapshotBigInt(
            snapshot.allowances[index],
            `allowance:${entry.tokenAddress}:${entry.spender}`,
          ).toString(),
          ...(allowanceError ? { error: allowanceError } : {}),
        };
      });
      const validTokenBalances = tokenBalances.filter((entry) => !entry.error);
      const validAllowances = allowancePayload.filter((entry) => !entry.error);
      const jEvent: JEvent = {
        name: 'ExternalWalletSnapshot',
        args: {
          entityId,
          owner: normalizedOwner,
          sourceHeight: source.sourceHeight,
          sourceHash: source.sourceHash,
          finalityDepth: source.finalityDepth,
          nativeBalance: nativeBalance.toString(),
          tokenBalances: validTokenBalances,
          allowances: validAllowances,
        },
        blockNumber: source.sourceHeight,
        blockHash: source.sourceHash,
        transactionHash,
      };
      context.observeExternalWalletSnapshot?.([jEvent], 'external-wallet-snapshot');
      return createJsonResponse(context.jsonHeaders, {
        success: true,
        entityId,
        owner: normalizedOwner,
        blockNumber: source.sourceHeight,
        blockHash: source.sourceHash,
        headBlockNumber: source.headBlockNumber,
        sourceHeight: source.sourceHeight,
        sourceHash: source.sourceHash,
        finalityDepth: source.finalityDepth,
        transactionHash,
        nativeBalance: nativeBalance.toString(),
        tokenBalances,
        allowances: allowancePayload,
        ...(snapshot.tokenErrors?.length ? { tokenErrors: snapshot.tokenErrors } : {}),
        ...(snapshot.allowanceErrors?.length ? { allowanceErrors: snapshot.allowanceErrors } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      externalWalletLog.error('snapshot.failed', { error: message });
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
      externalWalletLog.debug('faucet.gas.request', { requestId, userAddress, amount });
      if (!ethers.isAddress(userAddress)) {
        return createJsonResponse(context.jsonHeaders, { error: 'Invalid userAddress' }, 400);
      }

      const topupAmount = ethers.parseEther(amount);
      return await withFaucetWalletLock(context, adapter, async () => {
        const faucetWallet = await requireFaucetWalletBalances(context, adapter, [], {
          requiredEth: topupAmount + ethers.parseEther('0.01'),
        });
        externalWalletLog.debug('faucet.gas.topup_start', {
          requestId,
          topupWei: topupAmount.toString(),
        });
        const tx = await faucetWallet.sendTransaction({
          to: userAddress,
          value: topupAmount,
        });
        externalWalletLog.debug('faucet.gas.topup_tx', { requestId, txHash: tx.hash });
        await tx.wait();
        externalWalletLog.debug('faucet.gas.topup_mined', { requestId, txHash: tx.hash });
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
    handleWalletSnapshot,
    handleErc20Faucet,
    handleGasFaucet,
  };
};
