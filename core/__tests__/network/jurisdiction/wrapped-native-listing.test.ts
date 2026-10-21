import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractFactory, HDNodeWallet, JsonRpcProvider, NonceManager, Wallet, toBeHex, zeroPadValue } from 'ethers';
import weth9 from '../../../../jurisdictions/external/weth9.json';
import { Depository__factory, EntityProvider__factory } from '../../../../jurisdictions/typechain-types';
import { requireBoundaryRecord } from '../../../protocol/boundary-validation';
import { safeStringify } from '../../../protocol/serialization';
import { acquireLocalTestPortLease } from '../../../scripts/e2e/harness/local-test-port-lease';
import { waitForRpcReady } from '../../../scripts/operations/settlement/rpc-settlement-anvil';

const requireString = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
};

test('real WETH backing and Foundation listings retain exact assets and sequential authority', async () => {
  const work = await mkdtemp(join(tmpdir(), 'xln-wrapped-listing-'));
  const lease = await acquireLocalTestPortLease({ requiredOffsets: [0] });
  const rpc = `http://127.0.0.1:${lease.basePort}`;
  const key = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk').privateKey;
  const node = Bun.spawn(
    ['anvil', '--host', '127.0.0.1', '--port', String(lease.basePort), '--chain-id', '31337', '--block-time', '1'],
    { stdout: 'ignore', stderr: 'inherit' },
  );
  const provider = new JsonRpcProvider(rpc);
  try {
    await waitForRpcReady(rpc, 5_000);
    const signer = new NonceManager(new Wallet(key, provider));
    const owner = await signer.getAddress();
    const wrapped = await new ContractFactory(weth9.abi, weth9.bytecode, signer).deploy();
    await wrapped.waitForDeployment();
    const address = await wrapped.getAddress();
    expect(await provider.getCode(address)).toBe(weth9.deployedBytecode);
    const deposited = await (await wrapped.getFunction('deposit')({ value: 2n * 10n ** 18n })).wait();
    if (!deposited || deposited.status !== 1) throw new Error('WETH_DEPOSIT_FAILED');
    expect(await wrapped.getFunction('balanceOf')(owner)).toBe(2n * 10n ** 18n);
    expect(await wrapped.getFunction('totalSupply')()).toBe(2n * 10n ** 18n);
    expect(await provider.getBalance(address, deposited.blockNumber)).toBe(2n * 10n ** 18n);
    const nativeBefore = await provider.getBalance(owner, deposited.blockNumber);
    const withdrawn = await (await wrapped.getFunction('withdraw')(10n ** 18n)).wait();
    if (!withdrawn || withdrawn.status !== 1) throw new Error('WETH_WITHDRAWAL_FAILED');
    expect(await provider.getBalance(owner, withdrawn.blockNumber)).toBe(nativeBefore + 10n ** 18n - withdrawn.fee);
    expect(await provider.getBalance(address, withdrawn.blockNumber)).toBe(10n ** 18n);
    expect(await wrapped.getFunction('balanceOf')(owner)).toBe(10n ** 18n);
    expect(await wrapped.getFunction('totalSupply')()).toBe(10n ** 18n);

    const output = join(work, 'deployment.json');
    const child = Bun.spawn(
      ['bunx', 'hardhat', 'run', 'scripts/deploy-stack.cjs', '--network', 'stack-manager', '--no-compile'],
      {
        cwd: join(process.cwd(), 'jurisdictions'),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 50_000,
        env: {
          ...process.env,
          DEPLOYER_PRIVATE_KEY: key,
          XLN_FOUNDATION_ADDRESS: '',
          XLN_STABLECOIN_ADDRESS: '',
          XLN_WRAPPED_NATIVE_ADDRESS: address,
          XLN_STACK_MANAGER_RPC_URL: rpc,
          XLN_STACK_MANAGER_CHAIN_ID: '31337',
          XLN_DEPLOY_TEST_STABLECOIN: '1',
          XLN_DEPLOY_OUTPUT: output,
        },
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`WRAPPED_LISTING_DEPLOY_FAILED:${code}\n${stdout}\n${stderr}`);
    const deployment = requireBoundaryRecord(await Bun.file(output).json(), 'WRAPPED_DEPLOYMENT_INVALID');
    const registered = requireBoundaryRecord(deployment['registeredTokens'], 'WRAPPED_REGISTRY_MISSING');
    expect(registered['WETH']).toEqual({ address, tokenId: 2, decimals: 18 });
    const contracts = requireBoundaryRecord(deployment['contracts'], 'WRAPPED_CONTRACTS_MISSING');
    const ep = EntityProvider__factory.connect(requireString(contracts['entityProvider'], 'WRAPPED_EP'), provider);
    const dep = Depository__factory.connect(requireString(contracts['depository'], 'WRAPPED_DEP'), provider);
    expect(await ep.shareDepository()).toBe(await dep.getAddress());
    // Genesis authority lists USDT first and WETH second. A stale/replayed
    // Foundation Hanko cannot authorize another asset or consume a third nonce.
    expect(await ep.entityActionNonces(zeroPadValue(toBeHex(1), 32))).toBe(2n);
    expect(await dep.getTokensLength()).toBe(3n);
    for (const [symbol, tokenId] of [
      ['USDT', 1],
      ['WETH', 2],
    ] as const) {
      const metadata = requireBoundaryRecord(registered[symbol], `WRAPPED_${symbol}_MISSING`);
      const token = await dep._tokens(tokenId);
      expect(metadata['tokenId']).toBe(tokenId);
      expect(token.contractAddress).toBe(metadata['address']);
      expect(token.tokenType).toBe(0n);
      expect(token.externalTokenId).toBe(0n);
    }
    const evidence = requireBoundaryRecord(deployment['evmContracts'], 'WRAPPED_RECEIPTS_MISSING');
    for (const name of ['stablecoinRegistration', 'wrappedNativeRegistration']) {
      const entry = requireBoundaryRecord(evidence[name], `WRAPPED_${name}_MISSING`);
      const receipt = await provider.getTransactionReceipt(requireString(entry['transactionHash'], 'WRAPPED_TX'));
      if (!receipt) throw new Error(`WRAPPED_RECEIPT_MISSING:${name}`);
      expect(receipt.status).toBe(1);
      expect(receipt.blockNumber).toBe(entry['blockNumber']);
    }
    console.log(
      'WRAPPED_NATIVE_LISTING:' +
        safeStringify({
          address,
          deposited: deposited.hash,
          withdrawn: withdrawn.hash,
          retainedSupply: 10n ** 18n,
          registeredTokens: registered,
          foundationNonce: 2,
          evidence,
        }),
    );
  } finally {
    provider.destroy();
    node.kill('SIGTERM');
    await node.exited;
    lease.release();
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);
