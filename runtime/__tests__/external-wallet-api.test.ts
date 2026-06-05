import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import {
  createExternalWalletApi,
  type ExternalWalletApiContext,
} from '../api/external-wallet-api';
import type { JAdapter } from '../jadapter/types';

const USER_ADDRESS = new ethers.Wallet(`0x${'22'.repeat(32)}`).address;

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

const makeContext = (
  adapter: JAdapter,
  fundBrowserVmWallet: ExternalWalletApiContext['fundBrowserVmWallet'],
): ExternalWalletApiContext => ({
  getJAdapter: () => adapter,
  getRuntimeId: () => 'runtime-test',
  getTokenCatalog: async () => [],
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
  test('serializes faucet funding across API instances sharing one faucet signer', async () => {
    const provider = new ethers.JsonRpcProvider('http://127.0.0.1:0', 31337, { staticNetwork: true });
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
    const provider = new ethers.JsonRpcProvider('http://127.0.0.1:0', 31337, { staticNetwork: true });
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
});
