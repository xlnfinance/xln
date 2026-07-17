import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createExternalWalletApi,
  type ExternalWalletApiContext,
} from '../api/external-wallet-api';
import { createXlnJsonRpcProvider } from '../jadapter';
import type { JAdapter } from '../jadapter/types';

const USER_ADDRESS = new ethers.Wallet(`0x${'22'.repeat(32)}`).address;
const USDC_ADDRESS = '0x1111111111111111111111111111111111111111';

const makeFaucetRequest = (): Request => new Request('http://localhost/api/faucet/erc20', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    userAddress: USER_ADDRESS,
    tokenSymbol: 'USDC',
    amount: '1',
  }),
});

const makeBrowserVmAdapter = (provider: ethers.JsonRpcProvider): JAdapter => ({
  mode: 'browservm',
  chainId: 31337,
  provider,
  signer: new ethers.Wallet(`0x${'11'.repeat(32)}`, provider),
  addresses: {
    account: '0x0000000000000000000000000000000000000001',
    depository: '0x0000000000000000000000000000000000000002',
    entityProvider: '0x0000000000000000000000000000000000000003',
    deltaTransformer: '0x0000000000000000000000000000000000000004',
  },
} as unknown as JAdapter);

const makeTestProvider = (): ethers.JsonRpcProvider =>
  createXlnJsonRpcProvider('http://127.0.0.1:0', 31337);

const makeContext = (
  adapter: JAdapter,
  fundBrowserVmWallet: ExternalWalletApiContext['fundBrowserVmWallet'],
): ExternalWalletApiContext => ({
  getJAdapter: () => adapter,
  getRuntimeId: () => 'runtime-test',
  getTokenCatalog: async () => [{
    tokenId: 1,
    symbol: 'USDC',
    name: 'USD Coin',
    address: USDC_ADDRESS,
    decimals: 6,
  }],
  jsonHeaders: { 'content-type': 'application/json' },
  faucetSeed: 'external-wallet-api-test-seed',
  faucetSignerLabel: 'faucet-1',
  faucetWalletEthTarget: 1n,
  faucetTokenTargetUnits: 1n,
  emitDebugEvent: () => {},
  fundBrowserVmWallet,
});

const createBlockingFaucetFund = () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  let resolveFirstStarted: (() => void) | null = null;
  let releaseFirst: (() => void) | null = null;
  const firstStarted = new Promise<void>((resolve) => {
    resolveFirstStarted = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const fundBrowserVmWallet: ExternalWalletApiContext['fundBrowserVmWallet'] = async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (calls === 1) {
        resolveFirstStarted?.();
        await firstRelease;
      }
      return true;
    } finally {
      active -= 1;
    }
  };

  return {
    fundBrowserVmWallet,
    firstStarted,
    releaseFirst: () => releaseFirst?.(),
    calls: () => calls,
    maxActive: () => maxActive,
  };
};

describe('external wallet API faucet transaction gate', () => {
  test('BrowserVM faucet targets only the requested token in its trusted raw units', async () => {
    const provider = makeTestProvider();
    const adapter = makeBrowserVmAdapter(provider);
    const calls: Array<{ address: string; amount: bigint; tokenSymbol?: string }> = [];
    try {
      const api = createExternalWalletApi(makeContext(adapter, async (address, amount, tokenSymbol) => {
        calls.push({ address, amount, ...(tokenSymbol ? { tokenSymbol } : {}) });
        return true;
      }));
      const response = await api.handleErc20Faucet(makeFaucetRequest());
      expect(response.status).toBe(200);
      expect(calls).toEqual([{
        address: USER_ADDRESS,
        amount: 10n ** 6n,
        tokenSymbol: 'USDC',
      }]);
    } finally {
      provider.destroy();
    }
  });

  test('external wallet API uses structured logging instead of raw console output', () => {
    const source = readFileSync(join(process.cwd(), 'runtime/api/external-wallet-api.ts'), 'utf8');
    expect(source).toContain("createStructuredLogger('server.external_wallet')");
    expect(source).toContain("externalWalletLog.debug('faucet.provision.token_balance'");
    expect(source).toContain("externalWalletLog.error('faucet.erc20.failed'");
    expect(source).toContain("externalWalletLog.error('snapshot.failed'");
    expect(source).toContain("externalWalletLog.error('faucet.gas.failed'");
    expect(source).toContain("waitForFaucetTx(transferTx, 'user-token-transfer'");
    expect(source).toContain("waitForFaucetTx(topupTx, 'user-gas-topup'");
    expect(source.indexOf("externalWalletLog.debug('faucet.erc20.gas_topup_tx'")).toBeLessThan(
      source.indexOf("waitForFaucetTx(transferTx, 'user-token-transfer'"),
    );
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.warn');
    expect(source).not.toContain('console.error');
  });

  test('serializes faucet funding across API instances sharing one faucet signer', async () => {
    const provider = makeTestProvider();
    const adapter = makeBrowserVmAdapter(provider);
    const blockingFund = createBlockingFaucetFund();

    try {
      const apiA = createExternalWalletApi(makeContext(adapter, blockingFund.fundBrowserVmWallet));
      const apiB = createExternalWalletApi(makeContext(adapter, blockingFund.fundBrowserVmWallet));

      const first = apiA.handleErc20Faucet(makeFaucetRequest());
      await blockingFund.firstStarted;
      const second = apiB.handleErc20Faucet(makeFaucetRequest());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(blockingFund.calls()).toBe(1);
      expect(blockingFund.maxActive()).toBe(1);

      blockingFund.releaseFirst();
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(blockingFund.calls()).toBe(2);
      expect(blockingFund.maxActive()).toBe(1);
    } finally {
      provider.destroy();
    }
  });

  test('serializes startup provision and user faucet through the same gate', async () => {
    const provider = makeTestProvider();
    const adapter = makeBrowserVmAdapter(provider);
    const blockingFund = createBlockingFaucetFund();

    try {
      const provisionApi = createExternalWalletApi(makeContext(adapter, blockingFund.fundBrowserVmWallet));
      const userApi = createExternalWalletApi(makeContext(adapter, blockingFund.fundBrowserVmWallet));

      const provision = provisionApi.provisionFaucetWallet();
      await blockingFund.firstStarted;
      const userFunding = userApi.handleErc20Faucet(makeFaucetRequest());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(blockingFund.calls()).toBe(1);
      expect(blockingFund.maxActive()).toBe(1);

      blockingFund.releaseFirst();
      const [, response] = await Promise.all([provision, userFunding]);
      expect(response.status).toBe(200);
      expect(blockingFund.calls()).toBe(2);
      expect(blockingFund.maxActive()).toBe(1);
    } finally {
      provider.destroy();
    }
  });

  test('wallet snapshot endpoint stays read-only and does not mutate the canonical J-prefix', async () => {
    const provider = makeTestProvider();
    Object.assign(provider, {
      getBlockNumber: async () => 77,
      getBlock: async (blockTag: number) => {
        expect(blockTag).toBe(76);
        return { hash: `0x${'76'.repeat(32)}` };
      },
    });
    const adapter = {
      ...makeBrowserVmAdapter(provider),
      getFinalityDepth: () => 1,
      readWalletSnapshot: async (request: {
        owner: string;
        tokenAddresses: string[];
        allowances?: Array<{ tokenAddress: string; spender: string }>;
        blockTag?: number | string;
      }) => {
        expect(request.owner).toBe(USER_ADDRESS.toLowerCase());
        expect(request.tokenAddresses).toEqual(['0x1111111111111111111111111111111111111111']);
        expect(request.allowances).toEqual([{
          tokenAddress: '0x1111111111111111111111111111111111111111',
          spender: '0x0000000000000000000000000000000000000002',
        }]);
        expect(request.blockTag).toBe(76);
        return {
          nativeBalance: 5n,
          tokenBalances: [9n],
          allowances: [7n],
        };
      },
    } as unknown as JAdapter;
    const api = createExternalWalletApi({
      ...makeContext(adapter, async () => false),
      getTokenCatalog: async () => [{
        symbol: 'USDC',
        address: '0x1111111111111111111111111111111111111111',
        decimals: 18,
        tokenId: 3,
      }],
    });

    try {
      const response = await api.handleWalletSnapshot(new Request('http://localhost/api/external-wallet/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entityId: `0x${'44'.repeat(32)}`,
          owner: USER_ADDRESS,
          allowances: [{
            tokenAddress: '0x1111111111111111111111111111111111111111',
            spender: '0x0000000000000000000000000000000000000002',
          }],
        }),
      }));
      const body = await response.json() as {
        success?: boolean;
        tokenBalances?: Array<{ balance?: string }>;
        sourceHeight?: number;
        sourceHash?: string;
        finalityDepth?: number;
      };
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.tokenBalances?.[0]?.balance).toBe('9');
      expect(body.sourceHeight).toBe(76);
      expect(body.sourceHash).toBe(`0x${'76'.repeat(32)}`);
      expect(body.finalityDepth).toBe(1);
    } finally {
      provider.destroy();
    }
  });

  test('wallet snapshot endpoint rejects incomplete adapter snapshots instead of zero-filling', async () => {
    const provider = makeTestProvider();
    Object.assign(provider, {
      getBlockNumber: async () => 88,
      getBlock: async () => ({ hash: `0x${'88'.repeat(32)}` }),
    });
    const makeApi = (snapshot: { nativeBalance: bigint | null; tokenBalances: bigint[]; allowances: bigint[] }) => {
      const adapter = {
        ...makeBrowserVmAdapter(provider),
        readWalletSnapshot: async () => snapshot,
      } as unknown as JAdapter;
      return createExternalWalletApi({
        ...makeContext(adapter, async () => false),
        getTokenCatalog: async () => [{
          symbol: 'USDC',
          address: '0x1111111111111111111111111111111111111111',
          decimals: 18,
          tokenId: 3,
        }],
      });
    };
    const request = () => new Request('http://localhost/api/external-wallet/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entityId: `0x${'44'.repeat(32)}`,
        owner: USER_ADDRESS,
        allowances: [{
          tokenAddress: '0x1111111111111111111111111111111111111111',
          spender: '0x0000000000000000000000000000000000000002',
        }],
      }),
    });

    try {
      const shortArrayResponse = await makeApi({
        nativeBalance: 5n,
        tokenBalances: [],
        allowances: [7n],
      }).handleWalletSnapshot(request());
      const shortArrayBody = await shortArrayResponse.json() as { error?: string };
      expect(shortArrayResponse.status).toBe(500);
      expect(shortArrayBody.error).toContain('EXTERNAL_WALLET_SNAPSHOT_FIELD_COUNT_MISMATCH:tokenBalances');

      const missingNativeResponse = await makeApi({
        nativeBalance: null,
        tokenBalances: [9n],
        allowances: [7n],
      }).handleWalletSnapshot(request());
      const missingNativeBody = await missingNativeResponse.json() as { error?: string };
      expect(missingNativeResponse.status).toBe(500);
      expect(missingNativeBody.error).toContain('EXTERNAL_WALLET_SNAPSHOT_FIELD_MISSING:nativeBalance');
    } finally {
      provider.destroy();
    }
  });

  test('wallet snapshot endpoint returns structured token errors without applying fake zero balances', async () => {
    const provider = makeTestProvider();
    Object.assign(provider, {
      getBlockNumber: async () => 99,
      getBlock: async () => ({ hash: `0x${'99'.repeat(32)}` }),
    });
    const badToken = '0x2222222222222222222222222222222222222222';
    const adapter = {
      ...makeBrowserVmAdapter(provider),
      readWalletSnapshot: async () => ({
        nativeBalance: 5n,
        tokenBalances: [9n, 0n],
        allowances: [],
        tokenErrors: [{
          tokenAddress: badToken,
          error: 'EXTERNAL_WALLET_SNAPSHOT_RPC_INVALID_BIGINT:balance',
        }],
      }),
    } as unknown as JAdapter;
    const api = createExternalWalletApi({
      ...makeContext(adapter, async () => false),
      getTokenCatalog: async () => [
        {
          symbol: 'USDC',
          address: '0x1111111111111111111111111111111111111111',
          decimals: 18,
          tokenId: 3,
        },
        {
          symbol: 'BAD',
          address: badToken,
          decimals: 18,
          tokenId: 4,
        },
      ],
    });

    try {
      const response = await api.handleWalletSnapshot(new Request('http://localhost/api/external-wallet/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entityId: `0x${'44'.repeat(32)}`,
          owner: USER_ADDRESS,
        }),
      }));
      const body = await response.json() as {
        success?: boolean;
        tokenBalances?: Array<{ tokenAddress?: string; balance?: string; error?: string }>;
        tokenErrors?: Array<{ tokenAddress?: string; error?: string }>;
      };
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.tokenErrors?.[0]?.tokenAddress).toBe(badToken);
      expect(body.tokenBalances?.find((entry) => entry.tokenAddress === badToken)?.error)
        .toContain('EXTERNAL_WALLET_SNAPSHOT_RPC_INVALID_BIGINT');
    } finally {
      provider.destroy();
    }
  });
});
