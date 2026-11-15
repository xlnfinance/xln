import { safeStringify } from '../../protocol/serialization';
import { expect, test } from 'bun:test';
import { JsonRpcProvider, Wallet, getBytes, toBeHex, zeroPadValue } from 'ethers';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { allocateDeploymentTestFixture } from '../../../tools/deployment/test-evidence';
import { deployJurisdictionStack } from '../../jurisdiction/adapter/stack-manager/deploy';
import { decodeDeployJurisdictionStackRequest } from '../../jurisdiction/adapter/stack-manager/validation';
import { verifyJurisdictionStack } from '../../jurisdiction/adapter/stack-manager/verification';
import { waitForRpcReady } from '../../scripts/operations/settlement/rpc-settlement-anvil';
import { ERC20Mock__factory } from '../../../jurisdictions/typechain-types/factories/ERC20Mock__factory';
import { EntityProvider__factory } from '../../../jurisdictions/typechain-types/factories/EntityProvider__factory';

const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

test('fresh existing-USDC stack admits eleven Ignition operations only at depth twelve', async () => {
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
  const port = reservation.port;
  await reservation.stop(true);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const directory = allocateDeploymentTestFixture('fresh-');
  const node = Bun.spawn(['anvil', '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337',
    '--hardfork', 'osaka', '--block-gas-limit', '60000000', '--silent'], { stdout: 'ignore', stderr: 'inherit' });
  const provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 100 });
  const previous = process.env['XLN_JURISDICTIONS_PATH'];
  const catalog = join(directory, 'jurisdictions.json');
  process.env['XLN_JURISDICTIONS_PATH'] = catalog;
  try {
    await waitForRpcReady(rpcUrl, 5_000);
    const signer = new Wallet(key, provider);
    const token = await new ERC20Mock__factory(signer).deploy('USD Coin Test', 'USDC', 6, 1_000_000n);
    await token.waitForDeployment();
    const initialNonce = BigInt(await provider.send('eth_getTransactionCount', [signer.address, 'latest']));
    expect(initialNonce).toBe(1n);
    const initialBalance = await provider.getBalance(signer.address);
    const request = decodeDeployJurisdictionStackRequest({
      name: 'Fresh USDC', key: 'local-usdc',
      rpcUrl, expectedChainId: 31337, blockTimeMs: 250, currency: 'ETH', explorer: '',
      signerId: signer.address, foundationRecipient: signer.address,
      stablecoin: { kind: 'existing', address: await token.getAddress() }, publication: 'local', confirmations: 12,
    });
    let verifying = false;
    const deployment = deployJurisdictionStack(request, {
      deploymentId: 'fresh-usdc', mode: 'new', signerPrivateKey: getBytes(key), evidenceDirectory: directory,
      onPhase: phase => { if (phase === 'verifying') verifying = true; },
    });
    let settled = false;
    const observed = deployment.then(result => { settled = true; return result; });
    // An unhandled deployment failure is surfaced immediately while waiting for admission.
    const untilVerifying = async () => {
      const deadline = Date.now() + 55_000;
      while (!verifying) {
        if (Date.now() > deadline) throw new Error('TEST_VERIFICATION_TIMEOUT');
        await Bun.sleep(25);
      }
      return undefined;
    };
    await Promise.race([untilVerifying(), observed.then(() => { throw new Error('TEST_EARLY_ADMISSION'); })]);
    await provider.send('anvil_mine', ['0xa']);
    await Bun.sleep(5_000);
    expect(settled).toBeFalse();
    expect(await Bun.file(catalog).exists()).toBeFalse();
    await provider.send('anvil_mine', ['0x1']);
    const result = await observed;
    expect(result.manifest.deploymentId).toBe('fresh-usdc');
    expect(BigInt(await provider.send('eth_getTransactionCount', [signer.address, 'latest'])) - initialNonce).toBe(11n);
    expect(result.manifest.registeredTokens).toEqual({ USDC: { address: await token.getAddress(), tokenId: 1, decimals: 6 } });
    const ep = EntityProvider__factory.connect(result.manifest.contracts.entityProvider, provider);
    expect(await ep.entityActionNonces(zeroPadValue(toBeHex(1), 32))).toBe(1n);
    const journal = await readFile(join(directory, 'fresh-usdc/journal.jsonl'), 'utf8');
    expect(journal).toContain('XlnStack_66726573682d75736463#bindTransformer');
    expect(journal).toContain('XlnStack_66726573682d75736463#bindShares');
    expect(journal).toContain('XlnListing_66726573682d75736463#registerStablecoin');
    const audit = await Bun.file(join(directory, 'fresh-usdc/manifest.json.transactions.json')).json();
    expect(audit).toHaveLength(11);
    for (const entry of audit) {
      expect(entry.receipt.status).toBe(1);
      expect((await provider.getBlock(entry.receipt.blockNumber))!.hash).toBe(entry.receipt.blockHash);
    }
    const gasUsed = audit.reduce((sum: bigint, entry: { receipt: { gasUsed: string } }) => sum + BigInt(entry.receipt.gasUsed), 0n);
    const nativeCostWei = audit.reduce((sum: bigint, entry: { receipt: { gasUsed: string; gasPrice: string } }) => sum + BigInt(entry.receipt.gasUsed) * BigInt(entry.receipt.gasPrice), 0n);
    const balanceDelta = initialBalance - await provider.getBalance(signer.address);
    expect(balanceDelta).toBe(nativeCostWei);
    await writeFile(join(directory, 'financial-proof.json'), safeStringify({ initialNonce: String(initialNonce),
      operations: 11, foundationNonce: 1, gasUsed: String(gasUsed), nativeCostWei: String(nativeCostWei),
      balanceDeltaWei: String(balanceDelta), executionConfirmations: 1, admissionConfirmations: 12 }, 2));
    expect(await Bun.file(catalog).json()).toHaveProperty('jurisdictions.local-usdc');
    const nonce = await provider.send('eth_getTransactionCount', [signer.address, 'latest']);
    await expect(deployJurisdictionStack({ ...request, key: 'other-key' }, {
      deploymentId: 'fresh-usdc', mode: 'new', signerPrivateKey: getBytes(key), evidenceDirectory: directory,
    })).rejects.toThrow('STACK_MANAGER_DEPLOYMENT_ATTEMPT_EXISTS');
    const resumed = await deployJurisdictionStack(request, {
      deploymentId: 'fresh-usdc', mode: 'resume', signerPrivateKey: getBytes(key), evidenceDirectory: directory,
    });
    expect(resumed).toEqual(result);
    const wrong = { ...result.manifest, evmContracts: { ...result.manifest.evmContracts,
      deltaTransformerBinding: result.manifest.evmContracts.stablecoinRegistration } };
    await expect(verifyJurisdictionStack(provider, wrong, 12)).rejects.toThrow('STACK_MANAGER_BINDING');
    expect(await provider.send('eth_getTransactionCount', [signer.address, 'latest'])).toBe(nonce);
    console.log(`IGNITION_FRESH_EVIDENCE:${directory}:operations=11:foundationNonce=1:admissionDepth=12`);
  } finally {
    provider.destroy();
    node.kill('SIGTERM');
    await node.exited;
    if (previous === undefined) delete process.env['XLN_JURISDICTIONS_PATH'];
    else process.env['XLN_JURISDICTIONS_PATH'] = previous;
  }
}, 180_000);
