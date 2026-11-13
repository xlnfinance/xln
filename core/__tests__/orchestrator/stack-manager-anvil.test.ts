import { afterEach, describe, expect, test } from 'bun:test';
import { JsonRpcProvider, Wallet, getBytes } from 'ethers';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ERC20Mock__factory } from '../../../jurisdictions/typechain-types/factories/ERC20Mock__factory';
import { Depository__factory } from '../../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { deployJurisdictionStack } from '../../jurisdiction/adapter/stack-manager/deploy';
import { decodeDeployJurisdictionStackRequest } from '../../jurisdiction/adapter/stack-manager/validation';
import { validateJurisdictionsDataValue } from '../../jurisdiction/adapter/kernel/jurisdiction-loader';
import { readCompilerBytecodeEvidence } from '../../jurisdiction/adapter/stack-manager/compiler-bytecode';
import { safeStringify } from '../../protocol/serialization';
import { requireBoundaryRecord } from '../../protocol/boundary-validation';
import { decodeJurisdictionGossipAnnouncement } from '../../jurisdiction/gossip/announcement';

const ANVIL_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const anvilProcesses: Bun.Subprocess[] = [];

const reservePort = async (): Promise<number> => {
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
  const port = reservation.port;
  await reservation.stop(true);
  return port;
};

const waitForAnvil = async (rpcUrl: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
      });
      if (response.ok) return;
    } catch {
      // The isolated node has not opened its socket yet.
    }
    await Bun.sleep(25);
  }
  throw new Error('STACK_MANAGER_ANVIL_START_TIMEOUT');
};

afterEach(async () => {
  for (const child of anvilProcesses.splice(0)) {
    child.kill('SIGTERM');
    await child.exited;
  }
});

describe('Stack Manager real Anvil deployment', () => {
  test('binds Hardhat compiler output to its input before trusting immutable slots', async () => {
    const source = new URL('../../../jurisdictions/artifacts/build-info/', import.meta.url);
    const directory = await mkdtemp(join(tmpdir(), 'xln-compiler-binding-'));
    const target = pathToFileURL(`${directory}/`);
    try {
      for (const file of await readdir(source)) {
        if (file.endsWith('.json')) await copyFile(new URL(file, source), new URL(file, target));
      }
      const evidence = await readCompilerBytecodeEvidence(target, 'contracts/Depository.sol', 'Depository');
      expect(Object.keys(evidence.immutableReferences).sort()).toEqual(['admin', 'deltaTransformer', 'entityProvider']);
      for (const file of await readdir(target)) {
        if (!file.endsWith('.output.json')) continue;
        const output: unknown = JSON.parse(await readFile(new URL(file, target), 'utf8'));
        if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('TEST_BUILD_OUTPUT_INVALID');
        await writeFile(new URL(file, target), safeStringify({ ...output, id: 'different-compiler-input' }));
      }
      await expect(readCompilerBytecodeEvidence(target, 'contracts/Depository.sol', 'Depository'))
        .rejects.toThrow('STACK_MANAGER_BUILD_OUTPUT_BINDING_INVALID');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects a mismatched Foundation recipient before local or community deployment spending', async () => {
    const anvil = Bun.which('anvil');
    if (!anvil) throw new Error('ANVIL_BINARY_REQUIRED');
    const port = await reservePort();
    const rpcUrl = `http://127.0.0.1:${port}`;
    const child = Bun.spawn([
      anvil, '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337',
      '--block-time', '0.1', '--block-gas-limit', '60000000', '--code-size-limit', '65536', '--silent',
    ], { stdout: 'ignore', stderr: 'pipe' });
    anvilProcesses.push(child);
    await waitForAnvil(rpcUrl);

    const directory = await mkdtemp(join(tmpdir(), 'xln-stack-manager-preflight-'));
    const previous = process.env['XLN_JURISDICTIONS_PATH'];
    process.env['XLN_JURISDICTIONS_PATH'] = join(directory, 'jurisdictions.json');
    const wallet = new Wallet(ANVIL_PRIVATE_KEY);
    const provider = new JsonRpcProvider(rpcUrl);
    try {
      for (const publication of ['local', 'community'] as const) {
        const phases: string[] = [];
        const nonceBefore = await provider.getTransactionCount(wallet.address, 'pending');
        const request = decodeDeployJurisdictionStackRequest({
          stackVersion: 'V1',
          name: 'Rejected Foundation recipient',
          key: `anvil-preflight-${publication}-${port}`,
          rpcUrl,
          expectedChainId: 31337,
          blockTimeMs: 250,
          currency: 'ETH',
          explorer: '',
          signerId: wallet.address,
          foundationRecipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          stablecoin: { kind: 'test' },
          publication,
          confirmations: 12,
        });
        await expect(deployJurisdictionStack(request, {
          deploymentId: request.key, mode: 'new', signerPrivateKey: getBytes(ANVIL_PRIVATE_KEY),
          evidenceDirectory: join(directory, 'evidence'),
          onPhase: phase => phases.push(phase),
        })).rejects.toThrow('FOUNDATION_LISTING_SIGNER_MISMATCH');
        expect(await provider.getTransactionCount(wallet.address, 'pending')).toBe(nonceBefore);
        expect(phases).toEqual(['preflight']);
      }
    } finally {
      provider.destroy();
      if (previous === undefined) delete process.env['XLN_JURISDICTIONS_PATH'];
      else process.env['XLN_JURISDICTIONS_PATH'] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);

  test('preserves existing USDC identity through verified deployment and discovery', async () => {
    const anvil = Bun.which('anvil');
    if (!anvil) throw new Error('ANVIL_BINARY_REQUIRED');
    const port = await reservePort();
    const rpcUrl = `http://127.0.0.1:${port}`;
    const child = Bun.spawn([
      anvil, '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337',
      '--block-time', '0.1', '--block-gas-limit', '60000000', '--code-size-limit', '65536', '--silent',
    ], { stdout: 'ignore', stderr: 'pipe' });
    anvilProcesses.push(child);
    await waitForAnvil(rpcUrl);

    const directory = await mkdtemp(join(tmpdir(), 'xln-stack-manager-usdc-'));
    const path = join(directory, 'jurisdictions.json');
    const previous = process.env['XLN_JURISDICTIONS_PATH'];
    process.env['XLN_JURISDICTIONS_PATH'] = path;
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(ANVIL_PRIVATE_KEY, provider);
    const phases: string[] = [];
    try {
      const stablecoin = await new ERC20Mock__factory(wallet).deploy('USD Coin Test', 'USDC', 6, 1_000_000n);
      await stablecoin.waitForDeployment();
      const address = await stablecoin.getAddress();
      expect(await stablecoin.symbol()).toBe('USDC');
      const request = decodeDeployJurisdictionStackRequest({
        stackVersion: 'V1',
        name: 'Existing USDC Anvil V1',
        key: `anvil-usdc-${port}`,
        rpcUrl,
        expectedChainId: 31337,
        blockTimeMs: 250,
        currency: 'ETH',
        explorer: '',
        signerId: wallet.address,
        foundationRecipient: wallet.address,
        stablecoin: { kind: 'existing', address },
        publication: 'community',
        confirmations: 12,
      });
      const result = await deployJurisdictionStack(request, {
        deploymentId: request.key, mode: 'new', signerPrivateKey: getBytes(ANVIL_PRIVATE_KEY),
        evidenceDirectory: join(directory, 'evidence'),
        onPhase: phase => phases.push(phase),
      });
      const expectedToken = { address, tokenId: 1, decimals: 6 };
      expect(result.manifest.registeredTokens).toEqual({ USDC: expectedToken });
      expect(result.manifest.evmContracts.stablecoin).toBeUndefined();
      expect(phases).toEqual(['preflight', 'deploying', 'verifying', 'persisting', 'complete']);
      const registryToken = await Depository__factory.connect(result.manifest.contracts.depository, provider)._tokens(1);
      expect(registryToken.contractAddress).toBe(address);
      expect(registryToken.tokenType).toBe(0n);
      expect(registryToken.externalTokenId).toBe(0n);

      const persisted = validateJurisdictionsDataValue(JSON.parse(await readFile(path, 'utf8')));
      const jurisdictions = requireBoundaryRecord(persisted['jurisdictions'], 'TEST_JURISDICTIONS_INVALID');
      const jurisdiction = requireBoundaryRecord(jurisdictions[request.key], 'TEST_JURISDICTION_MISSING');
      expect(jurisdiction['tokens']).toEqual({ USDC: { symbol: 'USDC', ...expectedToken } });
      if (result.publication.scope !== 'community') throw new Error('TEST_COMMUNITY_PUBLICATION_MISSING');
      const announcement = decodeJurisdictionGossipAnnouncement(result.publication.announcement);
      expect(announcement.stablecoin).toEqual({ symbol: 'USDC', ...expectedToken, address: address.toLowerCase() });
      expect(persisted['jurisdictionAnnouncements']).toEqual([announcement]);
      expect(() => decodeJurisdictionGossipAnnouncement({
        ...announcement,
        stablecoin: { ...announcement.stablecoin, symbol: 'USDT' },
      })).toThrow('JURISDICTION_GOSSIP_SIGNATURE_INVALID');
    } finally {
      provider.destroy();
      if (previous === undefined) delete process.env['XLN_JURISDICTIONS_PATH'];
      else process.env['XLN_JURISDICTIONS_PATH'] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);

  test('deploys, verifies, and persists the canonical V1 stack', async () => {
    const anvil = Bun.which('anvil');
    if (!anvil) throw new Error('ANVIL_BINARY_REQUIRED');
    const port = await reservePort();
    const rpcUrl = `http://127.0.0.1:${port}`;
    const child = Bun.spawn([
      anvil, '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337',
      '--block-time', '0.1', '--block-gas-limit', '60000000', '--code-size-limit', '65536', '--silent',
    ], { stdout: 'ignore', stderr: 'pipe' });
    anvilProcesses.push(child);
    await waitForAnvil(rpcUrl);

    const directory = await mkdtemp(join(tmpdir(), 'xln-stack-manager-anvil-'));
    const path = join(directory, 'jurisdictions.json');
    const previous = process.env['XLN_JURISDICTIONS_PATH'];
    process.env['XLN_JURISDICTIONS_PATH'] = path;
    const wallet = new Wallet(ANVIL_PRIVATE_KEY);
    const phases: string[] = [];
    try {
      const request = decodeDeployJurisdictionStackRequest({
        stackVersion: 'V1',
        name: 'Local Anvil V1',
        key: `anvil-${port}`,
        rpcUrl,
        expectedChainId: 31337,
        blockTimeMs: 250,
        currency: 'ETH',
        explorer: '',
        description: 'Isolated Stack Manager integration proof',
        signerId: wallet.address,
        foundationRecipient: wallet.address,
        stablecoin: { kind: 'test' },
        publication: 'community',
        confirmations: 12,
      });
      const result = await deployJurisdictionStack(request, {
        deploymentId: request.key, mode: 'new', signerPrivateKey: getBytes(ANVIL_PRIVATE_KEY),
        evidenceDirectory: join(directory, 'evidence'),
        onPhase: phase => phases.push(phase),
      });
      expect(phases).toEqual(['preflight', 'deploying', 'verifying', 'persisting', 'complete']);
      expect(result.publication.status).toBe('queued');
      expect(result.publication.scope).toBe('community');
      const persisted = validateJurisdictionsDataValue(JSON.parse(await readFile(path, 'utf8')));
      const jurisdictions = persisted['jurisdictions'];
      expect(jurisdictions && typeof jurisdictions === 'object').toBeTrue();
      expect(persisted['jurisdictionAnnouncements']).toHaveLength(1);

      const provider = new JsonRpcProvider(rpcUrl);
      try {
        for (const address of Object.values(result.manifest.contracts)) {
          expect(await provider.getCode(address)).not.toBe('0x');
        }
      } finally {
        provider.destroy();
      }
    } finally {
      if (previous === undefined) delete process.env['XLN_JURISDICTIONS_PATH'];
      else process.env['XLN_JURISDICTIONS_PATH'] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
