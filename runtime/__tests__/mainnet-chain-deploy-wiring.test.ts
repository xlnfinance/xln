import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

describe('mainnet chain deployment wiring', () => {
  test('root scripts expose one-click testnet and mainnet chain deploy commands', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['contracts:tron:compile']).toContain('bun scripts/compile-tron.cjs --all');
    expect(pkg.scripts['deploy:chains:testnet']).toContain('deploy-chain-matrix.cjs --profile=testnet');
    expect(pkg.scripts['deploy:chains:mainnet']).toContain('deploy-chain-matrix.cjs --profile=mainnet --yes');
    expect(pkg.scripts['deploy:mainnets']).toBe('bun run deploy:chains:mainnet');
  });

  test('Base deploy pins configured USDC to tokenId 1 before publishing the stack', () => {
    const script = readFileSync(join(repoRoot, 'jurisdictions/scripts/deploy-base.cjs'), 'utf8');
    expect(script).not.toContain('ID will be assigned on first use');
    expect(script).toMatch(/tokenToId\s*\(/);
    expect(script).toMatch(/(?:usdc|token).*Id\s*!==\s*1n/i);
    expect(script).toContain('await usdc.decimals()');
    expect(script).toContain('USDC_DECIMALS_MISMATCH');
  });

  test('EVM deployment evidence retains every linked contract receipt and watcher start block', () => {
    const stack = readFileSync(join(repoRoot, 'jurisdictions/scripts/deploy-stack.cjs'), 'utf8');
    const matrix = readFileSync(join(repoRoot, 'jurisdictions/scripts/deploy-chain-matrix.cjs'), 'utf8');
    expect(stack).toContain('deploymentEvidence');
    expect(stack).toContain('hankoVerifier: hankoVerifierAddr');
    expect(stack).toContain('entityProviderDeploymentBlock: entityProviderDeployment.deploymentBlock');
    expect(stack).toContain('evmContracts:');
    expect(stack).toContain('transactionHash: transaction.hash');
    expect(stack).toContain('STABLECOIN_TOKEN_ID_MISMATCH');
    expect(stack).toContain('registeredTokens:');
    expect(matrix).toContain('result.evmContracts ? { evmContracts: result.evmContracts }');
    expect(matrix).toContain("XLN_DEPLOY_TEST_STABLECOIN: chain.id === 'ethereum-sepolia'");
    expect(matrix).toContain('...existingDeployments');
    expect(matrix).toContain("run('bunx', ['--bun', 'hardhat', 'compile'])");
    expect(matrix).toContain("run('bunx', ['--bun', 'hardhat', 'run'");
  });

  test('hardhat has explicit Ethereum testnet and mainnet networks', () => {
    const config = readFileSync(join(repoRoot, 'jurisdictions/hardhat.config.ts'), 'utf8');
    expect(config).toContain('"ethereum-sepolia"');
    expect(config).toContain('requiredRpcPlaceholder("ETH_SEPOLIA_RPC")');
    expect(config).toContain('chainId: 11155111');
    expect(config).toContain('"ethereum-mainnet"');
    expect(config).toContain('requiredRpcPlaceholder("ETH_MAINNET_RPC")');
    expect(config).toContain('chainId: 1');
    expect(config).toContain('DEPLOYER_PRIVATE_KEY');
    expect(config).toContain('key.startsWith("0x") ? key : `0x${key}`');
  });

  test('hardhat TypeScript tests use the Node 20 compatible CommonJS loader', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'jurisdictions/package.json'), 'utf8')) as {
      type?: string;
    };
    const tsconfig = JSON.parse(readFileSync(join(repoRoot, 'jurisdictions/tsconfig.json'), 'utf8')) as {
      compilerOptions: { module: string };
      'ts-node': { esm: boolean; moduleTypes: Record<string, string> };
    };
    expect(pkg.type).toBeUndefined();
    expect(tsconfig.compilerOptions.module).toBe('commonjs');
    expect(tsconfig['ts-node'].esm).toBe(false);
    expect(tsconfig['ts-node'].moduleTypes['../runtime/**/*.ts']).toBe('cjs');
    expect(tsconfig['ts-node'].moduleTypes['../frontend/**/*.ts']).toBe('cjs');
  });

  test('chain matrix deploys real TRON profile through TronWeb and public TRON chain IDs', () => {
    const script = readFileSync(join(repoRoot, 'jurisdictions/scripts/deploy-chain-matrix.cjs'), 'utf8');
    expect(script).toContain("const { TronWeb } = require('tronweb');");
    expect(script).toContain("chainId: 728126428");
    expect(script).toContain("chainId: 3448148188");
    expect(script).toContain("TRON_MAINNET_RPC");
    expect(script).toContain("TRON_NILE_RPC");
    expect(script).toContain("TRONGRID_API_KEY");
    expect(script).toContain("TRON_MAINNET_USDT");
    expect(script).toContain("base58: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'");
    expect(script).toContain("base58: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'");
    expect(script).toContain(
      "const hankoVerifier = await deployTronContract(tronWeb, 'HankoVerifier');",
    );
    expect(script).toContain('{ HankoVerifier: hankoVerifier }');
    expect(script).toContain('hankoVerifier: hankoVerifier.evm');
    expect(script).toContain('hankoVerifier,');
    expect(script).toContain('[entityProvider.base58, chain.disputeDelayBlocks]');
    expect(script).toContain('disputeDelayBlocks: 28_800');
    expect(script).toContain('TRON_DISPUTE_DELAY_MISMATCH');
    expect(script).toContain('registerExternalToken(0, usdt.base58, 0)');
    expect(script).toContain('TRON_USDT_REGISTRATION_MISMATCH');
    expect(script).toContain('Mainnet deployment requires --yes');
    expect(script).toContain('DEPLOYMENT_ALREADY_EXISTS');
    expect(script).toContain('without explicit --replace');
    expect(script).toContain('patchLinkReferences');
    expect(script).toContain('TRON bytecode still contains unresolved library link placeholders');
  });

  test('TRON compiler uses pinned standard-json solc artifacts outside git', () => {
    const compile = readFileSync(join(repoRoot, 'jurisdictions/scripts/compile-tron.cjs'), 'utf8');
    const ignore = readFileSync(join(repoRoot, 'jurisdictions/.gitignore'), 'utf8');
    expect(compile).toContain("const expectedCompiler = '0.8.25'");
    expect(compile).toContain("[solcCli, '--standard-json']");
    expect(compile).toContain('TRON_SOLC_VERSION_MISMATCH');
    expect(compile).toContain("viaIR: true");
    expect(compile).toContain("evmVersion: 'shanghai'");
    expect(ignore).toContain('/build-tron');
  });

  test('TRON RPC watcher reads the SolidityNode solidified head instead of guessing a depth', () => {
    const rpc = readFileSync(join(repoRoot, 'runtime/jadapter/rpc.ts'), 'utf8');
    expect(rpc).toContain('const TRON_CHAIN_IDS = new Set<number>([728126428, 3448148188])');
    expect(rpc).toContain('/walletsolidity/getnowblock');
    expect(rpc).toContain('TRON_CONFIRMATION_DEPTH_FORBIDDEN');
    expect(rpc).toContain('isTronChainId(config.chainId) ? readTronSolidifiedBlockNumber()');
    expect(rpc).not.toContain('TRON_FINALITY_DEPTH');
  });

  test('TRON Nile read smoke is watch-only and requires a key only for writes', () => {
    const smoke = readFileSync(join(repoRoot, 'runtime/scripts/tron-nile-smoke.ts'), 'utf8');
    expect(smoke).toContain("!privateKey ? { watchOnly: true }");
    expect(smoke).toContain('TRON_NILE_PRIVATE_KEY_REQUIRED_FOR_WRITE');
    expect(smoke).not.toContain('DEFAULT_PRIVATE_KEY');
    expect(smoke).not.toContain('--use-public-dev-key');
  });
});
