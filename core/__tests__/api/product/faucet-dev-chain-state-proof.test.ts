import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { ethers } from 'ethers';

import { deriveSignerKeySync } from '../../../account/crypto';
import type { ExternalWalletApiContext } from '../../../api/public/external-wallet/context';
import { provisionFaucetWalletFunding } from '../../../api/public/external-wallet/faucet-wallet';
import { createJAdapter } from '../../../jurisdiction/adapter';
import { verifyGetProofResponse, type GetProofResponse } from '../../../jurisdiction/adapter/rpc/state-anchor/rpc-state-proof';
import type { JAdapter } from '../../../jurisdiction/adapter/types';

const FAUCET_TARGET = ethers.parseEther('1');

const reservePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      server.close(error => (error ? reject(error) : resolve(address.port)));
    });
  });

let anvil: ChildProcess | null = null;
let provider: ethers.JsonRpcProvider;
let adapter: JAdapter;
let context: ExternalWalletApiContext;
let faucetAddress = '';

const blockAt = async (height: number): Promise<{ stateRoot: string }> =>
  (await provider.send('eth_getBlockByNumber', [ethers.toQuantity(height), false])) as { stateRoot: string };

// The watcher authenticates header.stateRoot by hash and then verifies
// eth_getProof against it. Every sealed height must keep that pair consistent.
const expectProofMatchesHeader = async (address: string, height: number): Promise<void> => {
  const tag = ethers.toQuantity(height);
  const { stateRoot } = await blockAt(height);
  const proof = (await provider.send('eth_getProof', [address, [], tag])) as GetProofResponse;
  expect(ethers.keccak256(proof.accountProof[0] ?? '0x')).toBe(stateRoot);
  const verified = verifyGetProofResponse(stateRoot, address, [], proof);
  expect(verified.account?.balance ?? 0n).toBe(await provider.getBalance(address, height));
};

beforeAll(async () => {
  const port = await reservePort();
  // Production Anvil flags (scripts/operations/start-anvil.sh).
  anvil = spawn('anvil', [
    '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent',
    '--mixed-mining', '--block-time', '10', '--prune-history', '128',
  ], { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  // cacheTimeout -1: a cached eth_blockNumber would point the checks at genesis.
  provider = new ethers.JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await provider.getBlockNumber();
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  adapter = await createJAdapter({ mode: 'rpc', chainId: 31337, rpcUrl });
  context = {
    getJAdapter: () => adapter,
    getRuntimeId: () => 'faucet-state-proof',
    getTokenCatalog: async () => [],
    jsonHeaders: {},
    faucetSeed: 'faucet-state-proof-seed',
    faucetSignerLabel: 'faucet-1',
    faucetWalletEthTarget: FAUCET_TARGET,
    faucetTokenTargetUnits: 1n,
    emitDebugEvent: () => {},
    fundBrowserVmWallet: async () => false,
  };
  faucetAddress = new ethers.Wallet(ethers.hexlify(deriveSignerKeySync(context.faucetSeed, context.faucetSignerLabel)))
    .address;
}, 30_000);

afterAll(async () => {
  await adapter?.close?.();
  anvil?.kill('SIGKILL');
});

describe('dev-chain faucet funding keeps sealed state proofs valid', () => {
  test('funds by a mined transfer; every height before and after verifies against its header', async () => {
    await provider.send('evm_mine', []);
    const before = await provider.getBlockNumber();
    expect(before).toBeGreaterThan(0);
    const funder = await adapter.signer.getAddress();
    await expectProofMatchesHeader(faucetAddress, before);
    await expectProofMatchesHeader(funder, before);
    const funderNonceBefore = await provider.getTransactionCount(funder, 'latest');

    await provisionFaucetWalletFunding(context, adapter, [], { ensureEth: true, ensureTokens: false });
    const funded = await provider.getBlockNumber();

    // Seal one more block: every height, including the funded one, must stay
    // provable against its own header after later blocks exist.
    await provider.send('evm_mine', []);
    const after = await provider.getBlockNumber();
    for (let height = before; height <= after; height += 1) {
      await expectProofMatchesHeader(faucetAddress, height);
      await expectProofMatchesHeader(funder, height);
    }

    expect(funded).toBe(before + 1);
    expect(await provider.getBalance(faucetAddress, funded)).toBe(FAUCET_TARGET);
    expect(await provider.getTransactionCount(funder, 'latest')).toBe(funderNonceBefore + 1);

    // Above the refill threshold nothing is sent.
    await provisionFaucetWalletFunding(context, adapter, [], { ensureEth: true, ensureTokens: false });
    expect(await provider.getTransactionCount(funder, 'latest')).toBe(funderNonceBefore + 1);
    expect(await provider.getBlockNumber()).toBe(after);
  });
});
