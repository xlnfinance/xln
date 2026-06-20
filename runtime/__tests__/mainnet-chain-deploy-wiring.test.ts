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

  test('hardhat has explicit Ethereum testnet and mainnet networks', () => {
    const config = readFileSync(join(repoRoot, 'jurisdictions/hardhat.config.cjs'), 'utf8');
    expect(config).toContain('"ethereum-sepolia"');
    expect(config).toContain('requiredRpcPlaceholder("ETH_SEPOLIA_RPC")');
    expect(config).toContain('chainId: 11155111');
    expect(config).toContain('"ethereum-mainnet"');
    expect(config).toContain('requiredRpcPlaceholder("ETH_MAINNET_RPC")');
    expect(config).toContain('chainId: 1');
    expect(config).toContain('DEPLOYER_PRIVATE_KEY');
    expect(config).toContain('key.startsWith("0x") ? key : `0x${key}`');
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
    expect(script).toContain('Mainnet deployment requires --yes');
    expect(script).toContain('patchLinkReferences');
    expect(script).toContain('TRON bytecode still contains unresolved library link placeholders');
  });

  test('TRON compiler wrapper uses TronBox solc artifacts outside git', () => {
    const compile = readFileSync(join(repoRoot, 'jurisdictions/scripts/compile-tron.cjs'), 'utf8');
    const ignore = readFileSync(join(repoRoot, 'jurisdictions/.gitignore'), 'utf8');
    expect(compile).toContain("require('tronbox/build/components/WorkflowCompile')");
    expect(compile).toContain("version: compilerVersion");
    expect(compile).toContain("viaIR: true");
    expect(ignore).toContain('/build-tron');
  });

  test('TRON RPC watcher requires solidified finality depth instead of EVM fallback', () => {
    const rpc = readFileSync(join(repoRoot, 'runtime/jadapter/rpc.ts'), 'utf8');
    expect(rpc).toContain('const TRON_CHAIN_IDS = new Set<number>([728126428, 3448148188])');
    expect(rpc).toContain('const TRON_FINALITY_DEPTH = 19');
    expect(rpc).toContain('if (isTronChainId(config.chainId) && configuredDepth < TRON_FINALITY_DEPTH)');
    expect(rpc).toContain('if (isTronChainId(config.chainId)) return TRON_FINALITY_DEPTH;');
    expect(rpc.indexOf('if (isTronChainId(config.chainId)) return TRON_FINALITY_DEPTH;')).toBeLessThan(
      rpc.indexOf('return 2;'),
    );
  });
});
