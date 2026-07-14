import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';

import { generateLazyEntityId } from '../entity/factory';
import { buildSingleSignerHanko } from '../hanko/batch';
import { createJAdapter, createXlnJsonRpcProvider, type JAdapter } from '../jadapter';
import { computeBatchHankoHash, createEmptyBatch, encodeJBatch } from '../jurisdiction/batch';
import { createSettlementHashWithNonce } from '../protocol/dispute/proof-builder';

const CHAIN_A = 31_337;
const CHAIN_B = 31_338;
const PRIVATE_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
] as const;

type ManagedAnvil = {
  child: ChildProcessWithoutNullStreams;
  rpcUrl: string;
  tmpRoot: string;
  stderr: string;
};

const managedAnvils: ManagedAnvil[] = [];
const adapters: JAdapter[] = [];

const reservePort = async (): Promise<number> => await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      reject(new Error('TWO_ANVIL_PORT_RESERVATION_FAILED'));
      return;
    }
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const waitForRpc = async (rpcUrl: string, expectedChainId: number): Promise<void> => {
  const provider = createXlnJsonRpcProvider(rpcUrl);
  let lastError = 'not ready';
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const network = await provider.getNetwork();
      if (network.chainId === BigInt(expectedChainId)) {
        await provider.destroy();
        return;
      }
      lastError = `chainId=${network.chainId}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  await provider.destroy();
  throw new Error(`TWO_ANVIL_RPC_NOT_READY:${rpcUrl}:${lastError}`);
};

const startAnvil = async (chainId: number): Promise<ManagedAnvil> => {
  const port = await reservePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const tmpRoot = await mkdtemp(join(tmpdir(), `xln-hanko-domain-${chainId}-`));
  const child = spawn('anvil', [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--chain-id', String(chainId),
    '--block-gas-limit', '60000000',
    '--prune-history', '256',
    '--state', join(tmpRoot, 'state.json'),
  ], { env: { ...process.env, TMPDIR: tmpRoot } });
  const managed: ManagedAnvil = { child, rpcUrl, tmpRoot, stderr: '' };
  child.stderr.on('data', (chunk) => {
    managed.stderr += chunk.toString();
  });
  managedAnvils.push(managed);
  try {
    await waitForRpc(rpcUrl, chainId);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nanvil=${managed.stderr}`);
  }
  return managed;
};

const stopAnvil = async (managed: ManagedAnvil): Promise<void> => {
  if (managed.child.exitCode === null && managed.child.signalCode === null) {
    managed.child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => managed.child.once('exit', () => resolve())),
      Bun.sleep(3_000).then(() => {
        if (managed.child.exitCode === null && managed.child.signalCode === null) {
          managed.child.kill('SIGKILL');
        }
      }),
    ]);
  }
  await rm(managed.tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
};

afterAll(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(managedAnvils.splice(0).map(stopAnvil));
});

describe('Account Hanko cross-chain replay protection', () => {
  test('rejects a chain-A bilateral Hanko on chain B at identical contract addresses', async () => {
    const [anvilA, anvilB] = await Promise.all([startAnvil(CHAIN_A), startAnvil(CHAIN_B)]);
    const [adapterA, adapterB] = await Promise.all([
      createJAdapter({ mode: 'rpc', chainId: CHAIN_A, rpcUrl: anvilA.rpcUrl }),
      createJAdapter({ mode: 'rpc', chainId: CHAIN_B, rpcUrl: anvilB.rpcUrl }),
    ]);
    adapters.push(adapterA, adapterB);
    await Promise.all([adapterA.deployStack(), adapterB.deployStack()]);

    expect(adapterA.addresses).toEqual(adapterB.addresses);
    expect(adapterA.addresses.account).not.toBe(adapterA.addresses.depository);
    const parties = PRIVATE_KEYS.map((privateKey) => {
      const address = new ethers.Wallet(privateKey).address;
      return { privateKey, entityId: generateLazyEntityId([address], 1n).toLowerCase() };
    }).sort((left, right) => left.entityId.localeCompare(right.entityId));
    const initiator = parties[0]!;
    const counterparty = parties[1]!;
    const account = { leftEntity: initiator.entityId, rightEntity: counterparty.entityId };
    const domainA = { chainId: CHAIN_A, depositoryAddress: adapterA.addresses.depository };
    const domainB = { chainId: CHAIN_B, depositoryAddress: adapterB.addresses.depository };
    const hashA = createSettlementHashWithNonce(account, [], [], domainA, 1);
    const hashB = createSettlementHashWithNonce(account, [], [], domainB, 1);
    expect(hashA).not.toBe(hashB);

    // A linked Account function executes by DELEGATECALL. This negative vector
    // proves Solidity sees the Depository as address(this), not the library's
    // own deterministic address.
    const libraryAddressHash = createSettlementHashWithNonce(
      account,
      [],
      [],
      { chainId: CHAIN_A, depositoryAddress: adapterA.addresses.account },
      1,
    );
    const libraryAddressBatch = createEmptyBatch();
    libraryAddressBatch.settlements.push({
      leftEntity: initiator.entityId,
      rightEntity: counterparty.entityId,
      diffs: [],
      forgiveDebtsInTokenIds: [],
      sig: buildSingleSignerHanko(counterparty.entityId, libraryAddressHash, counterparty.privateKey),
      entityProvider: adapterA.addresses.entityProvider,
      hankoData: '0x',
      nonce: 1,
    });
    const encodedLibraryAddressBatch = encodeJBatch(libraryAddressBatch);
    const libraryAddressOuter = buildSingleSignerHanko(
      initiator.entityId,
      computeBatchHankoHash(BigInt(CHAIN_A), adapterA.addresses.depository, encodedLibraryAddressBatch, 1n),
      initiator.privateKey,
    );
    const libraryContextFailure = await adapterA.depository.processBatch.staticCall(
      encodedLibraryAddressBatch,
      libraryAddressOuter,
      1n,
    ).then(() => null, (error: unknown) => error);
    expect(libraryContextFailure instanceof Error ? libraryContextFailure.message : '').toContain('E4');

    const batchA = createEmptyBatch();
    batchA.settlements.push({
      leftEntity: initiator.entityId,
      rightEntity: counterparty.entityId,
      diffs: [],
      forgiveDebtsInTokenIds: [],
      sig: buildSingleSignerHanko(counterparty.entityId, hashA, counterparty.privateKey),
      entityProvider: adapterA.addresses.entityProvider,
      hankoData: '0x',
      nonce: 1,
    });
    const encodedBatchA = encodeJBatch(batchA);
    const outerA = buildSingleSignerHanko(
      initiator.entityId,
      computeBatchHankoHash(BigInt(CHAIN_A), adapterA.addresses.depository, encodedBatchA, 1n),
      initiator.privateKey,
    );
    await adapterA.processBatch(encodedBatchA, outerA, 1n);
    expect((await adapterA.getAccountInfo(initiator.entityId, counterparty.entityId)).nonce).toBe(1n);

    const outerReplayFailure = await adapterB.depository.processBatch.staticCall(
      encodedBatchA,
      outerA,
      1n,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outerReplayFailure).toBeInstanceOf(Error);
    expect(outerReplayFailure instanceof Error ? outerReplayFailure.message : '').toContain('E4');
    expect(await adapterB.getEntityNonce(initiator.entityId)).toBe(0n);
    expect((await adapterB.getAccountInfo(initiator.entityId, counterparty.entityId)).nonce).toBe(0n);

    const freshOuterB = buildSingleSignerHanko(
      initiator.entityId,
      computeBatchHankoHash(BigInt(CHAIN_B), adapterB.addresses.depository, encodedBatchA, 1n),
      initiator.privateKey,
    );
    const replayFailure = await adapterB.depository.processBatch.staticCall(
      encodedBatchA,
      freshOuterB,
      1n,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(replayFailure).toBeInstanceOf(Error);
    expect(replayFailure instanceof Error ? replayFailure.message : '').toContain('E4');
    expect(await adapterB.getEntityNonce(initiator.entityId)).toBe(0n);
    expect((await adapterB.getAccountInfo(initiator.entityId, counterparty.entityId)).nonce).toBe(0n);

    const batchB = createEmptyBatch();
    batchB.settlements.push({
      ...batchA.settlements[0]!,
      sig: buildSingleSignerHanko(counterparty.entityId, hashB, counterparty.privateKey),
    });
    const encodedBatchB = encodeJBatch(batchB);
    const correctOuterB = buildSingleSignerHanko(
      initiator.entityId,
      computeBatchHankoHash(BigInt(CHAIN_B), adapterB.addresses.depository, encodedBatchB, 1n),
      initiator.privateKey,
    );
    expect(await adapterB.depository.processBatch.staticCall(encodedBatchB, correctOuterB, 1n)).toBe(true);
    await adapterB.processBatch(encodedBatchB, correctOuterB, 1n);
    expect((await adapterB.getAccountInfo(initiator.entityId, counterparty.entityId)).nonce).toBe(1n);
  }, 120_000);
});
