import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { ethers, getIndexedAccountPath, HDNodeWallet, Mnemonic } from 'ethers';

import { deriveSignerKeySync } from '../../../account/crypto';
import type { ExternalWalletApiContext } from '../../../api/public/external-wallet/context';
import { provisionFaucetWalletFunding } from '../../../api/public/external-wallet/faucet-wallet';
import { createJAdapter } from '../../../jurisdiction/adapter';
import { verifyGetProofResponse, type GetProofResponse } from '../../../jurisdiction/adapter/rpc/state-anchor/rpc-state-proof';
import type { JAdapter } from '../../../jurisdiction/adapter/types';

const FAUCET_TARGET = ethers.parseEther('1');
const anvilDevKey = (index: number): string =>
  HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase('test test test test test test test test test test test junk'),
    getIndexedAccountPath(index)).privateKey;
// H1 signs as account 0 and its reserved faucet funder is account 9 (hub-node.ts).
const OPERATOR_KEY = anvilDevKey(0);
const FUNDER_KEY = anvilDevKey(9);
const OPERATOR_ADDRESS = new ethers.Wallet(OPERATOR_KEY).address;

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
let otherOwner: JAdapter;
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
  adapter = await createJAdapter({ mode: 'rpc', chainId: 31337, rpcUrl, privateKey: OPERATOR_KEY });
  // A second process signing as the same operator EOA (MM/custody use account 0).
  otherOwner = await createJAdapter({ mode: 'rpc', chainId: 31337, rpcUrl, privateKey: OPERATOR_KEY });
  context = {
    getJAdapter: () => adapter,
    getRuntimeId: () => 'faucet-state-proof',
    getTokenCatalog: async () => [],
    jsonHeaders: {},
    faucetSeed: 'faucet-state-proof-seed',
    faucetSignerLabel: 'faucet-1',
    devChainFaucetFunderKey: FUNDER_KEY,
    faucetWalletEthTarget: FAUCET_TARGET,
    faucetTokenTargetUnits: 1n,
    emitDebugEvent: () => {},
    fundBrowserVmWallet: async () => false,
  };
  faucetAddress = new ethers.Wallet(ethers.hexlify(deriveSignerKeySync(context.faucetSeed, context.faucetSignerLabel)))
    .address;
}, 30_000);

// The faucet spends its gas with its own key, leaving it below the refill line.
const spendFaucetBelowThreshold = async (): Promise<void> => {
  const faucet = new ethers.Wallet(ethers.hexlify(deriveSignerKeySync(context.faucetSeed, context.faucetSignerLabel)),
    provider);
  const balance = await provider.getBalance(faucetAddress);
  if (balance >= FAUCET_TARGET / 2n) {
    await (await faucet.sendTransaction({ to: ethers.ZeroAddress, value: balance - ethers.parseEther('0.01') })).wait();
  }
  expect(await provider.getBalance(faucetAddress)).toBeLessThan(FAUCET_TARGET / 2n);
};

afterAll(async () => {
  await adapter?.close?.();
  await otherOwner?.close?.();
  anvil?.kill('SIGKILL');
});

describe('dev-chain faucet funding keeps sealed state proofs valid', () => {
  test('funds by a mined transfer; every height before and after verifies against its header', async () => {
    await provider.send('evm_mine', []);
    const before = await provider.getBlockNumber();
    expect(before).toBeGreaterThan(0);
    const funder = new ethers.Wallet(FUNDER_KEY).address;
    const operator = await adapter.signer.getAddress();
    expect(funder).not.toBe(operator);
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

  test('a prepared operator transaction owned elsewhere keeps its nonce across faucet funding', async () => {
    const operator = await otherOwner.signer.getAddress();
    const operatorNonce = await provider.getTransactionCount(operator, 'pending');
    // The other owner durably accepts a signed wire and has not broadcast it.
    const prepared = await otherOwner.prepareDurableTransaction(ethers.getBytes(OPERATOR_KEY), {
      to: ethers.Wallet.createRandom().address, data: '0x', value: 0n,
    }, async () => 'accepted');
    expect(prepared.transactionNonce).toBe(operatorNonce);
    expect(await provider.getTransaction(prepared.transactionHash)).toBeNull();

    await spendFaucetBelowThreshold();
    const funderNonce = await provider.getTransactionCount(new ethers.Wallet(FUNDER_KEY).address, 'latest');

    await provisionFaucetWalletFunding(context, adapter, [], { ensureEth: true, ensureTokens: false });

    expect(await provider.getBalance(faucetAddress)).toBe(FAUCET_TARGET);
    // The original immutable wire still lands at its reserved nonce.
    expect(await otherOwner.broadcastPreparedTransaction(prepared.rawTransaction)).toBe(prepared.transactionHash);
    const receipt = await provider.waitForTransaction(prepared.transactionHash, 1, 20_000);
    expect(receipt?.status).toBe(1);
    expect(await provider.getTransactionCount(operator, 'latest')).toBe(operatorNonce + 1);
    expect(await provider.getTransactionCount(new ethers.Wallet(FUNDER_KEY).address, 'latest')).toBe(funderNonce + 1);
  });

  test('refuses an operator EOA or a missing funder', async () => {
    const operatorFunded = { ...context, devChainFaucetFunderKey: OPERATOR_KEY };
    const unfunded = { ...context, devChainFaucetFunderKey: null };
    await spendFaucetBelowThreshold();
    const operatorNonce = await provider.getTransactionCount(OPERATOR_ADDRESS, 'pending');
    await expect(provisionFaucetWalletFunding(operatorFunded, adapter, [], { ensureEth: true, ensureTokens: false }))
      .rejects.toThrow('DEV_CHAIN_FAUCET_FUNDER_IS_OPERATOR:chainId=31337');
    await expect(provisionFaucetWalletFunding(unfunded, adapter, [], { ensureEth: true, ensureTokens: false }))
      .rejects.toThrow('DEV_CHAIN_FAUCET_FUNDER_UNAVAILABLE:chainId=31337');
    expect(await provider.getTransactionCount(OPERATOR_ADDRESS, 'pending')).toBe(operatorNonce);
  });
});
