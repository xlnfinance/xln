import { expect, test } from 'bun:test';
import { JsonRpcProvider, Wallet } from 'ethers';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERC20Mock__factory } from '../../../jurisdictions/typechain-types/factories/ERC20Mock__factory';
import { buildStackManagerChildEnv } from '../../jurisdiction/adapter/stack-manager/deploy';
import { decodeJurisdictionStackManifest } from '../../jurisdiction/adapter/stack-manager/validation';
import { STACK_ARTIFACTS } from '../../jurisdiction/adapter/stack-manager/verification';
import { safeStringify } from '../../protocol/serialization';
import { waitForRpcReady } from '../../scripts/operations/settlement/rpc-settlement-anvil';
import { requireBoundaryRecord } from '../../protocol/boundary-validation';

const ANVIL_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

test('reserves each script output before spending and keeps same-directory deployments independent', async () => {
  const anvil = Bun.which('anvil');
  if (!anvil) throw new Error('ANVIL_BINARY_REQUIRED');
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
  const port = reservation.port;
  await reservation.stop(true);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const node = Bun.spawn(
    [
      anvil,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--chain-id',
      '31337',
      '--block-time',
      '0.1',
      '--block-gas-limit',
      '60000000',
      '--code-size-limit',
      '65536',
      '--silent',
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  const provider = new JsonRpcProvider(rpcUrl);
  const directory = await mkdtemp(join(tmpdir(), 'xln-stack-script-evidence-'));
  try {
    await waitForRpcReady(rpcUrl, 5_000);
    const wallet = new Wallet(ANVIL_PRIVATE_KEY, provider);
    const token = await new ERC20Mock__factory(wallet).deploy('USD Coin Test', 'USDC', 6, 1_000_000n);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();
    const runDeployment = async (outputPath: string) => {
      const child = Bun.spawn(['bunx', 'hardhat', 'xln-chain-stack', '--network', 'stack-manager'], {
        cwd: new URL('../../../jurisdictions', import.meta.url).pathname,
        env: buildStackManagerChildEnv({
          rpcUrl,
          chainId: 31337,
          signerPrivateKeyHex: ANVIL_PRIVATE_KEY,
          foundationRecipient: wallet.address,
          stablecoinAddress: tokenAddress,
          deployTestStablecoin: false,
          outputPath,
          deploymentId: outputPath.endsWith('arbitrum-sepolia.json') ? 'arbitrum-proof' : 'ethereum-proof',
          mode: 'new',
        }),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    const existingPath = join(directory, 'already-deployed.json');
    const existingManifest = '{"operatorEvidence":"must remain untouched"}\n';
    await writeFile(existingPath, existingManifest, { mode: 0o600 });
    const nonceBefore = await provider.send('eth_getTransactionCount', [wallet.address, 'pending']);
    const rejected = await runDeployment(existingPath);
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain('EEXIST');
    expect(await provider.send('eth_getTransactionCount', [wallet.address, 'pending'])).toBe(nonceBefore);
    expect(await readFile(existingPath, 'utf8')).toBe(existingManifest);

    const paths = [join(directory, 'ethereum-sepolia.json'), join(directory, 'arbitrum-sepolia.json')];
    const nonceBeforeDeployments = BigInt(await provider.send('eth_getTransactionCount', [wallet.address, 'pending']));
    for (const path of paths) {
      const outcome = await runDeployment(path);
      if (outcome.code !== 0) throw new Error(`TEST_SCRIPT_DEPLOY_FAILED:${outcome.stderr}:${outcome.stdout}`);
      const manifest = decodeJurisdictionStackManifest(JSON.parse(await readFile(path, 'utf8')));
      expect(await provider.getCode(manifest.contracts.depository)).not.toBe('0x');
      const entries: unknown = await Bun.file(`${path}.transactions.json`).json();
      if (!Array.isArray(entries)) throw new Error('TEST_SCRIPT_TRANSACTIONS_INVALID');
      expect(entries).toHaveLength(11);
      expect(
        entries.every(entry => {
          const transaction = requireBoundaryRecord(entry, 'TEST_SCRIPT_TRANSACTION_INVALID');
          const receipt = requireBoundaryRecord(transaction['receipt'], 'TEST_SCRIPT_RECEIPT_INVALID');
          return transaction['status'] === 'SUCCESS' && receipt['status'] === 1;
        }),
      ).toBeTrue();
    }
    expect(
      BigInt(await provider.send('eth_getTransactionCount', [wallet.address, 'pending'])) - nonceBeforeDeployments,
    ).toBe(22n);
    expect(await readFile(existingPath, 'utf8')).toBe(existingManifest);
  } finally {
    provider.destroy();
    node.kill('SIGTERM');
    await node.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

test.each([
  { kind: 'missing', error: 'HHE1000', contract: 'EntityProvider' },
  { kind: 'mismatched', error: 'STACK_MANAGER_ARTIFACT_BUILD_MISMATCH', contract: 'EntityProvider' },
  { kind: 'default-settings', error: 'STACK_MANAGER_COMPILER_SETTINGS_MISMATCH', contract: 'Account' },
  { kind: 'source-override', error: 'STACK_MANAGER_COMPILER_SETTINGS_MISMATCH', contract: 'EntityProvider' },
  { kind: 'compiler-path', error: 'STACK_MANAGER_COMPILER_IDENTITY_MISMATCH', contract: 'Account' },
])(
  'rejects a $kind artifact candidate before any deployment transaction is broadcast',
  async ({ kind, error, contract }) => {
    const anvil = Bun.which('anvil');
    if (!anvil) throw new Error('ANVIL_BINARY_REQUIRED');
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
    const port = reservation.port;
    await reservation.stop(true);
    const rpcUrl = `http://127.0.0.1:${port}`;
    const node = Bun.spawn(
      [
        anvil,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--chain-id',
        '31337',
        '--block-time',
        '0.1',
        '--block-gas-limit',
        '60000000',
        '--code-size-limit',
        '65536',
        '--silent',
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    const provider = new JsonRpcProvider(rpcUrl);
    const directory = await mkdtemp(join(tmpdir(), 'xln-stack-artifact-preflight-'));
    const artifacts = join(directory, 'artifacts');
    const outputPath = join(directory, 'manifest.json');
    const fixtureConfig = join(directory, 'hardhat.config.ts');
    const jurisdictionDirectory = new URL('../../../jurisdictions/', import.meta.url);
    try {
      await waitForRpcReady(rpcUrl, 5_000);
      // Keep the real plugins and ArtifactManager, overriding only their filesystem input.
      await writeFile(join(directory, 'package.json'), safeStringify({ private: true, type: 'module' }));
      await symlink(new URL('../../../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir');
      await cp(new URL('artifacts/', jurisdictionDirectory), artifacts, { recursive: true });
      const artifactPath = join(artifacts, STACK_ARTIFACTS.entityProvider.path);
      if (kind === 'missing') await rm(artifactPath);
      else if (kind === 'mismatched') {
        const value = await Bun.file(artifactPath).json();
        await writeFile(artifactPath, safeStringify({ ...value, bytecode: '0x6000' }));
      }
      await writeFile(
        fixtureConfig,
        [
          `import config from ${safeStringify(new URL('hardhat.config.ts', jurisdictionDirectory).href)};`,
          `const compiler = config.solidity;`,
          `const changed = { ...compiler, settings: { ...compiler.settings, optimizer: { enabled: true, runs: 200 } } };`,
          `const solidity = ${
            kind === 'default-settings'
              ? 'changed'
              : kind === 'source-override'
                ? "{ compilers: [compiler], overrides: { 'contracts/EntityProvider.sol': changed } }"
                : kind === 'compiler-path'
                  ? "{ ...compiler, path: '../node_modules/solc/other-soljson.js' }"
                  : 'compiler'
          };`,
          `export default { ...config, solidity, paths: { ...config.paths, artifacts: ${safeStringify(artifacts)} } };`,
        ].join('\n'),
      );
      const wallet = new Wallet(ANVIL_PRIVATE_KEY);
      const nonceBefore = await provider.send('eth_getTransactionCount', [wallet.address, 'pending']);
      const child = Bun.spawn(
        ['bunx', 'hardhat', '--config', fixtureConfig, 'xln-chain-stack', '--network', 'stack-manager'],
        {
          cwd: jurisdictionDirectory.pathname,
          env: buildStackManagerChildEnv({
            rpcUrl,
            chainId: 31337,
            signerPrivateKeyHex: ANVIL_PRIVATE_KEY,
            foundationRecipient: wallet.address,
            stablecoinAddress: '',
            deployTestStablecoin: true,
            outputPath,
            deploymentId: 'missing-artifact',
            mode: 'new',
          }),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const diagnostic = `${stderr}\n${stdout}`;
      expect(code).not.toBe(0);
      expect(diagnostic).toContain(error);
      expect(diagnostic).toContain(contract);
      expect(await provider.send('eth_getTransactionCount', [wallet.address, 'pending'])).toBe(nonceBefore);
      expect(await Bun.file(`${outputPath}.transactions.json`).exists()).toBeFalse();
      expect(await Bun.file(outputPath).exists()).toBeFalse();
      expect(await Bun.file(artifactPath).exists()).toBe(kind !== 'missing');
      expect(
        await Bun.file(new URL(`artifacts/${STACK_ARTIFACTS.entityProvider.path}`, jurisdictionDirectory)).exists(),
      ).toBeTrue();
    } finally {
      provider.destroy();
      node.kill('SIGTERM');
      await node.exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
  180_000,
);
