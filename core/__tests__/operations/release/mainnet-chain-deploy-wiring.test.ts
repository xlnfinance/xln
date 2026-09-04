import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const repoRoot = process.cwd();
const require = createRequire(import.meta.url);
const chainMatrix = require('../../../../jurisdictions/scripts/deploy-chain-matrix.cjs') as {
  evmStablecoinFor(chain: Record<string, unknown>, env?: Record<string, string | undefined>): {
    address: string;
    deployTestStablecoin: boolean;
  };
  preflightEvmStablecoin(
    chain: Record<string, unknown>,
    url: string,
    stablecoin: { address: string; deployTestStablecoin: boolean },
    rpcCall: (url: string, method: string, params: unknown[]) => Promise<unknown>,
  ): Promise<void>;
  preflightTronStablecoin(
    chain: Record<string, unknown>,
    tronWeb: { address: { toHex(value: string): string; fromHex(value: string): string } },
    stablecoin: { base58: string; hex41: string; evm: string },
    reader: {
      getContract(address: string): Promise<Record<string, unknown>>;
      readDecimals(address: string): Promise<Record<string, unknown>>;
    },
  ): Promise<void>;
  profiles: { mainnet: { ethereum: Record<string, unknown>; tron: Record<string, unknown> & {
    id: string;
    usdtAddress: { base58: string; hex41: string; evm: string };
  } } };
};
const readRpcAdapterSource = (): string => [
  'chain-ids.ts',
  'rpc-public.ts',
  'rpc/rpc-adapter.ts',
  'rpc/rpc-lifecycle.ts',
  'rpc/rpc-chain-io.ts',
  'rpc/rpc-finality.ts',
  'rpc/rpc-reads.ts',
  'rpc/wallet/rpc-wallet-writes.ts',
].map(file => readFileSync(join(repoRoot, 'core/jurisdiction/adapter', file), 'utf8')).join('\n');

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

  test('canonical EVM deploy pins the configured stablecoin to tokenId 1 before publishing', () => {
    const script = readFileSync(join(repoRoot, 'jurisdictions/scripts/deploy-stack.cjs'), 'utf8');
    expect(script).not.toContain('ID will be assigned on first use');
    expect(script).toMatch(/getTokensLength\s*\(/);
    expect(script).toMatch(/stablecoinTokenId\s*!==\s*1n/);
    expect(script).toContain('await stablecoin.decimals()');
    expect(script).toContain('STABLECOIN_DECIMALS_MISMATCH');
  });

  test('mainnet stablecoin is validated before the first deployment command', async () => {
    const script = readFileSync(join(repoRoot, 'jurisdictions/scripts/deploy-chain-matrix.cjs'), 'utf8');
    const chain = chainMatrix.profiles.mainnet.ethereum;
    const stablecoin = chainMatrix.evmStablecoinFor(chain, {});
    expect(stablecoin).toEqual({
      address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      deployTestStablecoin: false,
    });

    const calls: Array<{ method: string; params: unknown[] }> = [];
    await chainMatrix.preflightEvmStablecoin(chain, 'https://rpc.invalid', stablecoin, async (_url, method, params) => {
      calls.push({ method, params });
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_call') return `0x${'6'.padStart(64, '0')}`;
      throw new Error(`unexpected method ${method}`);
    });
    expect(calls).toEqual([
      { method: 'eth_getCode', params: [stablecoin.address, 'latest'] },
      { method: 'eth_call', params: [{ to: stablecoin.address, data: '0x313ce567' }, 'latest'] },
    ]);
    expect(script.indexOf('await preflightEvmStablecoin(chain, preflight.url, stablecoin);'))
      .toBeLessThan(script.indexOf("run('bunx', ['--bun', 'hardhat', 'compile'])"));
    expect(script).toContain('XLN_STABLECOIN_ADDRESS: stablecoin.address');

    const missingCodeCalls: string[] = [];
    await expect(chainMatrix.preflightEvmStablecoin(
      chain,
      'https://rpc.invalid',
      stablecoin,
      async (_url, method) => {
        missingCodeCalls.push(method);
        return '0x';
      },
    )).rejects.toThrow(`EVM_STABLECOIN_CODE_MISSING:ethereum-mainnet:${stablecoin.address}`);
    expect(missingCodeCalls).toEqual(['eth_getCode']);

    const invalid = { ...chain, usdtAddress: 'not-an-address' };
    expect(() => chainMatrix.evmStablecoinFor(invalid, {}))
      .toThrow('EVM_STABLECOIN_ADDRESS_INVALID:ethereum-mainnet:not-an-address');
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
    expect(matrix).toContain("XLN_DEPLOY_TEST_STABLECOIN: stablecoin.deployTestStablecoin ? '1' : '0'");
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

  test('hardhat 3 TypeScript tests use the ESM loader', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'jurisdictions/package.json'), 'utf8')) as {
      type?: string;
    };
    const tsconfig = JSON.parse(readFileSync(join(repoRoot, 'jurisdictions/tsconfig.json'), 'utf8')) as {
      compilerOptions: { module: string; moduleResolution: string };
    };
    expect(pkg.type).toBe('module');
    expect(tsconfig.compilerOptions.module).toBe('esnext');
    expect(tsconfig.compilerOptions.moduleResolution).toBe('bundler');
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
    expect(script).toContain('[entityProvider.base58, deltaTransformer.base58]');
    expect(script).not.toContain('disputeDelayBlocks');
    expect(script).not.toContain('TRON_DISPUTE_DELAY_MISMATCH');
    // USDT is listed through the Foundation lane; the deployer key holds no Depository listing power.
    expect(script).not.toContain('depositoryContract.registerExternalToken(');
    expect(script).toContain('entityProviderContract.foundationRegisterExternalToken(');
    expect(script).toContain("require('./foundation-hanko.cjs')");
    expect(script).toContain('TRON_USDT_REGISTRATION_MISMATCH');
    expect(script).toContain('Mainnet deployment requires --yes');
    expect(script).toContain('DEPLOYMENT_ALREADY_EXISTS');
    expect(script).toContain('without explicit --replace');
    expect(script).toContain('patchLinkReferences');
    expect(script).toContain('TRON bytecode still contains unresolved library link placeholders');
  });

  test('TRON stablecoin is read-only validated before dry-run, key access, compile, or broadcast', async () => {
    const script = readFileSync(join(repoRoot, 'jurisdictions/scripts/deploy-chain-matrix.cjs'), 'utf8');
    const chain = chainMatrix.profiles.mainnet.tron;
    const stablecoin = chain.usdtAddress;
    const tronWeb = {
      address: {
        toHex: (value: string) => value === stablecoin.base58
          ? stablecoin.hex41.slice(2)
          : value.replace(/^0x/, ''),
        fromHex: (value: string) => value.toLowerCase() === stablecoin.hex41.slice(2).toLowerCase()
          ? stablecoin.base58
          : `T-${value}`,
      },
    };
    const calls: string[] = [];
    const reader = {
      getContract: async (address: string) => {
        calls.push(`contract:${address}`);
        return { contract_address: stablecoin.hex41.slice(2), bytecode: '6000' };
      },
      readDecimals: async (address: string) => {
        calls.push(`decimals:${address}`);
        return {
          result: { result: true },
          constant_result: ['6'.padStart(64, '0')],
        };
      },
    };

    await chainMatrix.preflightTronStablecoin(chain, tronWeb, stablecoin, reader);
    expect(calls).toEqual([
      `contract:${stablecoin.base58}`,
      `decimals:${stablecoin.base58}`,
    ]);
    await expect(chainMatrix.preflightTronStablecoin(chain, tronWeb, stablecoin, {
      ...reader,
      getContract: async () => ({ contract_address: stablecoin.hex41.slice(2), bytecode: '' }),
    })).rejects.toThrow(`TRON_STABLECOIN_CODE_MISSING:${chain.id}:${stablecoin.base58}`);
    await expect(chainMatrix.preflightTronStablecoin(chain, tronWeb, stablecoin, {
      ...reader,
      getContract: async () => ({ contract_address: `41${'00'.repeat(20)}`, bytecode: '6000' }),
    })).rejects.toThrow(`TRON_STABLECOIN_CONTRACT_IDENTITY_MISMATCH:${chain.id}`);
    await expect(chainMatrix.preflightTronStablecoin(chain, tronWeb, stablecoin, {
      ...reader,
      readDecimals: async () => ({
        result: { result: true },
        constant_result: ['12'.padStart(64, '0')],
      }),
    })).rejects.toThrow(`TRON_STABLECOIN_DECIMALS_MISMATCH:${chain.id}:expected=6:actual=18`);
    await expect(chainMatrix.preflightTronStablecoin(chain, tronWeb, stablecoin, {
      ...reader,
      readDecimals: async () => ({
        result: { result: false },
        constant_result: [],
      }),
    })).rejects.toThrow(`TRON_STABLECOIN_DECIMALS_CALL_FAILED:${chain.id}:${stablecoin.base58}`);
    await expect(chainMatrix.preflightTronStablecoin(chain, tronWeb, stablecoin, {
      ...reader,
      readDecimals: async () => ({
        result: { result: true },
        constant_result: ['06'],
      }),
    })).rejects.toThrow(`TRON_STABLECOIN_DECIMALS_RESPONSE_INVALID:${chain.id}:${stablecoin.base58}`);

    const preflightIndex = script.indexOf('await preflightTronStablecoin(chain, readOnlyTronWeb, usdt);');
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeLessThan(script.indexOf('if (options.dryRun)', preflightIndex));
    expect(preflightIndex).toBeLessThan(script.indexOf('const privateKey = requireHexPrivateKey()', preflightIndex));
    expect(preflightIndex).toBeLessThan(script.indexOf("run('bun', ['scripts/compile-tron.cjs'", preflightIndex));
    expect(preflightIndex).toBeLessThan(script.indexOf("deployTronContract(tronWeb, 'Account')", preflightIndex));
  });

  test('TRON compiler uses pinned standard-json solc artifacts outside git', () => {
    const compile = readFileSync(join(repoRoot, 'jurisdictions/scripts/compile-tron.cjs'), 'utf8');
    const ignore = readFileSync(join(repoRoot, 'jurisdictions/.gitignore'), 'utf8');
    expect(compile).toContain("const expectedCompiler = '0.8.25'");
    expect(compile).toContain("[solcCli, '--standard-json']");
    expect(compile).toContain('TRON_SOLC_VERSION_MISMATCH');
    expect(compile).toContain("viaIR: true");
    expect(compile).toContain("evmVersion: 'cancun'");
    expect(ignore).toContain('/build-tron');
  });

  test('TRON RPC watcher reads the SolidityNode solidified head instead of guessing a depth', () => {
    const rpc = readRpcAdapterSource();
    expect(rpc).toContain('const TRON_CHAIN_IDS = new Set<number>([728126428, 3448148188])');
    expect(rpc).toContain('/walletsolidity/getnowblock');
    expect(rpc).toContain('TRON_CONFIRMATION_DEPTH_FORBIDDEN');
    expect(rpc).toContain('isTronChainId(config.chainId) ? readTronSolidifiedBlockNumber(config)');
    expect(rpc).not.toContain('TRON_FINALITY_DEPTH');
  });

  test('TRON Nile read smoke is watch-only and requires a key only for writes', () => {
    const smoke = readFileSync(join(repoRoot, 'core/scripts/operations/production/tron-nile-smoke.ts'), 'utf8');
    expect(smoke).toContain("!privateKey ? { watchOnly: true }");
    expect(smoke).toContain('TRON_NILE_PRIVATE_KEY_REQUIRED_FOR_WRITE');
    expect(smoke).not.toContain('DEFAULT_PRIVATE_KEY');
    expect(smoke).not.toContain('--use-public-dev-key');
  });
});
