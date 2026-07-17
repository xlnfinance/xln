import { expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';

import {
  EntityProvider__factory,
  ERC721Mock__factory,
  SupplyLivenessHarness__factory,
} from '../../jurisdictions/typechain-types/index.ts';
import { createJAdapter, createXlnJsonRpcProvider, type JAdapter } from '../jadapter';
import { createEmptyEnv } from '../runtime';
import { createTokenCatalogController } from '../server/token-catalog';
import type { JReplica } from '../types';

const CHAIN_ID = 31_337;

type ManagedAnvil = {
  child: ChildProcessWithoutNullStreams;
  rpcUrl: string;
  tmpRoot: string;
  stderr: string;
};

const reservePort = async (): Promise<number> => await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      reject(new Error('J_STACK_BINDING_PORT_RESERVATION_FAILED'));
      return;
    }
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const startAnvil = async (): Promise<ManagedAnvil> => {
  const port = await reservePort();
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xln-j-stack-binding-'));
  const managed: ManagedAnvil = {
    child: spawn('anvil', [
      '--host', '127.0.0.1',
      '--port', String(port),
      '--chain-id', String(CHAIN_ID),
      '--block-gas-limit', '60000000',
      '--prune-history', '256',
      '--silent',
      '--state', join(tmpRoot, 'state.json'),
    ], { env: { ...process.env, TMPDIR: tmpRoot } }),
    rpcUrl: `http://127.0.0.1:${port}`,
    tmpRoot,
    stderr: '',
  };
  managed.child.stderr.on('data', (chunk) => { managed.stderr += chunk.toString(); });
  const provider = createXlnJsonRpcProvider(managed.rpcUrl);
  try {
    let lastError = 'not ready';
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        if ((await provider.getNetwork()).chainId === BigInt(CHAIN_ID)) return managed;
        lastError = 'wrong chain';
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await Bun.sleep(50);
    }
    throw new Error(`J_STACK_BINDING_RPC_NOT_READY:${lastError}:${managed.stderr}`);
  } finally {
    await provider.destroy();
  }
};

const stopAnvil = async (managed: ManagedAnvil): Promise<void> => {
  if (managed.child.exitCode === null && managed.child.signalCode === null) {
    managed.child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => managed.child.once('exit', () => resolve())),
      Bun.sleep(3_000).then(() => managed.child.kill('SIGKILL')),
    ]);
  }
  await rm(managed.tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
};

const replicaForAddresses = (
  adapter: JAdapter,
  entityProvider: string,
): JReplica => ({
  chainId: CHAIN_ID,
  depositoryAddress: adapter.addresses.depository,
  entityProviderAddress: entityProvider,
  entityProviderDeploymentBlock: adapter.entityProviderDeploymentBlock,
  contracts: { ...adapter.addresses, entityProvider },
  jadapter: {
    chainId: CHAIN_ID,
    addresses: { ...adapter.addresses, entityProvider },
  },
}) as JReplica;

test('RPC fromReplica rejects a live EntityProvider not bound to the Depository', async () => {
  const anvil = await startAnvil();
  let deployed: JAdapter | null = null;
  try {
    deployed = await createJAdapter({ mode: 'rpc', chainId: CHAIN_ID, rpcUrl: anvil.rpcUrl });
    expect(() => deployed?.startWatching(createEmptyEnv('unverified-rpc-stack'))).toThrow(
      'J_STACK_BINDING_UNVERIFIED',
    );
    await deployed.deployStack();
    await expect(deployed.revert('0xdeadbeef')).rejects.toThrow('RPC_REVERT_REJECTED');
    expect(() => deployed?.startWatching(createEmptyEnv('failed-rpc-revert'))).toThrow(
      'J_STACK_BINDING_UNVERIFIED',
    );
    await deployed.deployStack();

    const secondProvider = await new ethers.ContractFactory(
      EntityProvider__factory.abi,
      EntityProvider__factory.bytecode,
      deployed.signer,
    ).deploy(await deployed.signer.getAddress());
    await secondProvider.waitForDeployment();
    const secondProviderAddress = await secondProvider.getAddress();
    expect(await deployed.provider.getCode(secondProviderAddress)).not.toBe('0x');
    expect((await deployed.depository.entityProvider()).toLowerCase()).toBe(
      deployed.addresses.entityProvider.toLowerCase(),
    );

    const result = await createJAdapter({
      mode: 'rpc',
      chainId: CHAIN_ID,
      rpcUrl: anvil.rpcUrl,
      fromReplica: replicaForAddresses(deployed, secondProviderAddress),
    }).then(async (adapter) => {
      await adapter.close();
      return 'accepted';
    }, (error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    expect(result instanceof Error ? result.message : '').toContain('J_STACK_ENTITY_PROVIDER_MISMATCH');
  } finally {
    await deployed?.close();
    await stopAnvil(anvil);
  }
}, 120_000);

test('RPC token registry fails loud when canonical ERC20 metadata is unavailable', async () => {
  const anvil = await startAnvil();
  let adapter: JAdapter | null = null;
  try {
    adapter = await createJAdapter({ mode: 'rpc', chainId: CHAIN_ID, rpcUrl: anvil.rpcUrl });
    await adapter.deployStack();

    const signerAddress = await adapter.signer.getAddress();
    const malformedErc20 = await new ethers.ContractFactory(
      ERC721Mock__factory.abi,
      ERC721Mock__factory.bytecode,
      adapter.signer,
    ).deploy('Missing Decimals', 'NODEC');
    await malformedErc20.waitForDeployment();
    const malformedAddress = await malformedErc20.getAddress();
    await (await malformedErc20.mint(signerAddress, 1n)).wait();
    await (await malformedErc20.setApprovalForAll(adapter.addresses.depository, true)).wait();
    await (await adapter.depository.adminRegisterExternalToken({
      entity: ethers.ZeroHash,
      contractAddress: malformedAddress,
      externalTokenId: 1,
      tokenType: 1,
      internalTokenId: 0,
      amount: 1n,
    })).wait();
    expect((await adapter.getTokenRegistry()).some((token) => token.symbol === 'NODEC')).toBe(false);

    // Registration now rejects ERC20s without a bounded fixed supply before
    // catalog reads. This existing harness has a valid fixed supply but no
    // ERC20 display metadata, so the real RPC path still reaches the metadata
    // boundary without weakening the on-chain token admission fence.
    const missingMetadata = await new ethers.ContractFactory(
      SupplyLivenessHarness__factory.abi,
      SupplyLivenessHarness__factory.bytecode,
      adapter.signer,
    ).deploy(2n);
    await missingMetadata.waitForDeployment();
    await (await adapter.depository.registerExternalToken(
      0,
      await missingMetadata.getAddress(),
      0,
    )).wait();

    await expect(adapter.getTokenRegistry()).rejects.toThrow('TOKEN_METADATA_UNAVAILABLE');
  } finally {
    await adapter?.close();
    await stopAnvil(anvil);
  }
}, 120_000);

test('RPC token registry transport failure rejects instead of returning an empty catalog', async () => {
  const anvil = await startAnvil();
  let adapter: JAdapter | null = null;
  let anvilStopped = false;
  try {
    adapter = await createJAdapter({ mode: 'rpc', chainId: CHAIN_ID, rpcUrl: anvil.rpcUrl });
    await adapter.deployStack();
    const catalog = createTokenCatalogController({ getAdapter: () => adapter });
    await stopAnvil(anvil);
    anvilStopped = true;

    await expect(adapter.getTokenRegistry()).rejects.toThrow('TOKEN_REGISTRY_FETCH_FAILED');
    await expect(catalog.ensureTokenCatalog()).rejects.toThrow('TOKEN_CATALOG_READ_FAILED');
  } finally {
    await adapter?.close();
    if (!anvilStopped) await stopAnvil(anvil);
  }
}, 120_000);

test('BrowserVM restore rejects state metadata pointing at a second live EntityProvider', async () => {
  const source = await createJAdapter({ mode: 'browservm', chainId: CHAIN_ID });
  try {
    await source.deployStack();
    const secondProvider = await new ethers.ContractFactory(
      EntityProvider__factory.abi,
      EntityProvider__factory.bytecode,
      source.signer,
    ).deploy(await source.signer.getAddress(), { gasLimit: 100_000_000n });
    await secondProvider.waitForDeployment();
    const secondProviderAddress = await secondProvider.getAddress();
    expect(await source.provider.getCode(secondProviderAddress)).not.toBe('0x');
    expect((await source.depository.entityProvider()).toLowerCase()).toBe(
      source.addresses.entityProvider.toLowerCase(),
    );

    const state = await source.dumpState();
    if (typeof state === 'string') throw new Error('BROWSERVM_STATE_OBJECT_REQUIRED');
    const mismatchedState = {
      ...state,
      addresses: { ...state.addresses, entityProvider: secondProviderAddress },
    };
    await expect(source.loadState(mismatchedState)).rejects.toThrow('J_STACK_CONNECTED_ADDRESS_MISMATCH');
    expect(() => source.startWatching(createEmptyEnv('invalid-browservm-stack'))).toThrow(
      'J_STACK_BINDING_UNVERIFIED',
    );
    const result = await createJAdapter({
      mode: 'browservm',
      chainId: CHAIN_ID,
      browserVMState: mismatchedState,
    }).then(async (adapter) => {
      await adapter.close();
      return 'accepted';
    }, (error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    expect(result instanceof Error ? result.message : '').toContain('J_STACK_ENTITY_PROVIDER_MISMATCH');
  } finally {
    await source.close();
  }
}, 120_000);
