import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContractFactory, HDNodeWallet, JsonRpcProvider, Wallet, ethers } from 'ethers';

import { buildSingleSignerHanko } from '../hanko/batch';
import { computeBatchHankoHash, createEmptyBatch, encodeJBatch, type JBatch } from '../j-batch';
import { linkArtifactBytecode } from '../jadapter/rpc-utils';
import {
  buildTowerAppointmentOwnerMessage,
  deriveRuntimeRecoveryActionLookupKey,
  encryptTowerPayloadForPublicKey,
  getTowerPayloadEncryptionPublicKey,
} from '../recovery/crypto';
import type { TowerActivePayloadV1, TowerAppointmentV1, TowerCounterDisputeRemedyV1 } from '../recovery/types';
import { generateLazyEntityId } from '../entity-factory';
import { encodeTowerCounterDisputeRemedy, runWatchtowerSweep } from '../watchtower/action';
import { startStandaloneWatchtowerServer, type StandaloneWatchtowerServer } from '../watchtower/standalone-server';
import type { StoredTowerActionReceipt } from '../watchtower/store';

const DEFAULT_HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
const DISPUTE_PROOF = 1;
const PROOF_BODY_ABI =
  'tuple(int256[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)';

const tempRoots: string[] = [];
const servers: StandaloneWatchtowerServer[] = [];
const anvilChildren: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
  while (anvilChildren.length > 0) {
    const child = anvilChildren.pop();
    if (!child || child.exitCode !== null) continue;
    child.kill('SIGTERM');
  }
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) continue;
    await rm(root, { recursive: true, force: true });
  }
});

const abiCoder = ethers.AbiCoder.defaultAbiCoder();

const derivePrivateKey = (index: number): string =>
  HDNodeWallet.fromPhrase(DEFAULT_HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).privateKey;

const proofBodyHash = (proofbody: Record<string, unknown>): string =>
  ethers.keccak256(abiCoder.encode([PROOF_BODY_ABI], [proofbody]));

const proofBody = (offdeltas: bigint[], tokenIds: bigint[], transformers: unknown[] = []): Record<string, unknown> => ({
  offdeltas,
  tokenIds,
  transformers,
});

const signEntityHash = (entityId: string, hash: string, privateKey: string): string =>
  buildSingleSignerHanko(entityId, hash, privateKey);

const createNonceManager = (provider: JsonRpcProvider) => {
  const nextByAddress = new Map<string, number>();
  return async (wallet: Wallet): Promise<number> => {
    const address = wallet.address.toLowerCase();
    const current = nextByAddress.get(address);
    if (current !== undefined) {
      nextByAddress.set(address, current + 1);
      return current;
    }
    const nonce = await provider.getTransactionCount(address, 'pending');
    nextByAddress.set(address, nonce + 1);
    return nonce;
  };
};

const waitForRpcReady = async (rpcUrl: string): Promise<void> => {
  const provider = new JsonRpcProvider(rpcUrl);
  let lastError = 'unknown';
  try {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      try {
        await provider.getBlockNumber();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await Bun.sleep(200);
      }
    }
  } finally {
    await provider.destroy();
  }
  throw new Error(`RPC not ready at ${rpcUrl}: ${lastError}`);
};

const startAnvil = async (port: number): Promise<{ child: ChildProcessWithoutNullStreams; rpcUrl: string }> => {
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = spawn('anvil', [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--chain-id', '31337',
    '--block-gas-limit', '60000000',
    '--code-size-limit', '65536',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  anvilChildren.push(child);
  child.stderr.on('data', chunk => process.stderr.write(`[anvil] ${chunk.toString()}`));
  await waitForRpcReady(rpcUrl);
  return { child, rpcUrl };
};

const loadArtifact = async (artifactPath: string): Promise<{
  abi: unknown[];
  bytecode: string;
}> => JSON.parse(await readFile(artifactPath, 'utf8')) as { abi: unknown[]; bytecode: string };

const signDepositoryBatch = async (
  depository: Contract,
  entityId: string,
  privateKey: string,
  batch: JBatch,
): Promise<{ encodedBatch: string; hankoData: string; nonce: bigint }> => {
  const encodedBatch = encodeJBatch(batch);
  const nextNonce = BigInt(await depository.entityNonces(entityId)) + 1n;
  const network = await depository.runner!.provider!.getNetwork();
  const batchHash = computeBatchHankoHash(
    BigInt(network.chainId),
    await depository.getAddress(),
    encodedBatch,
    nextNonce,
  );
  return {
    encodedBatch,
    hankoData: buildSingleSignerHanko(entityId, batchHash, privateKey),
    nonce: nextNonce,
  };
};

const disputeProofHash = async (
  depository: Contract,
  accountKey: string,
  nonce: bigint,
  proofbodyHashValue: string,
): Promise<string> => ethers.keccak256(abiCoder.encode(
  ['uint8', 'address', 'bytes', 'uint256', 'bytes32'],
  [DISPUTE_PROOF, await depository.getAddress(), accountKey, nonce, proofbodyHashValue],
));

describe('watchtower rpc last-resort integration', () => {
  test('standalone tower skips early and submits a real on-chain counter-dispute in the last-resort window', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'xln-watchtower-rpc-'));
    tempRoots.push(tempRoot);

    const anvilPort = 8654 + Math.floor(Math.random() * 1000);
    const { rpcUrl } = await startAnvil(anvilPort);
    const provider = new JsonRpcProvider(rpcUrl, 31337);
    const nextNonce = createNonceManager(provider);

    const left = new Wallet(derivePrivateKey(0), provider);
    const right = new Wallet(derivePrivateKey(1), provider);
    const tower = new Wallet(derivePrivateKey(2), provider);
    const [watched, counterparty] = BigInt(generateLazyEntityId([left.address], 1n)) < BigInt(generateLazyEntityId([right.address], 1n))
      ? [
          { wallet: left, entityId: generateLazyEntityId([left.address], 1n).toLowerCase(), privateKey: derivePrivateKey(0) },
          { wallet: right, entityId: generateLazyEntityId([right.address], 1n).toLowerCase(), privateKey: derivePrivateKey(1) },
        ]
      : [
          { wallet: right, entityId: generateLazyEntityId([right.address], 1n).toLowerCase(), privateKey: derivePrivateKey(1) },
          { wallet: left, entityId: generateLazyEntityId([left.address], 1n).toLowerCase(), privateKey: derivePrivateKey(0) },
        ];

    const accountArtifact = await loadArtifact(join(process.cwd(), 'jurisdictions/artifacts/contracts/Account.sol/Account.json'));
    const entityProviderArtifact = await loadArtifact(join(process.cwd(), 'jurisdictions/artifacts/contracts/EntityProvider.sol/EntityProvider.json'));
    const depositoryArtifact = await loadArtifact(join(process.cwd(), 'jurisdictions/artifacts/contracts/Depository.sol/Depository.json'));

    const accountFactory = new ContractFactory(accountArtifact.abi, accountArtifact.bytecode, left);
    const account = await accountFactory.deploy({ nonce: await nextNonce(left) });
    await account.waitForDeployment();

    const entityProviderFactory = new ContractFactory(entityProviderArtifact.abi, entityProviderArtifact.bytecode, left);
    const entityProvider = await entityProviderFactory.deploy({ nonce: await nextNonce(left) });
    await entityProvider.waitForDeployment();

    const linkedDepositoryBytecode = linkArtifactBytecode(depositoryArtifact.bytecode, {
      'contracts/Account.sol:Account': await account.getAddress(),
    });
    const depositoryFactory = new ContractFactory(depositoryArtifact.abi, linkedDepositoryBytecode, left);
    const depository = await depositoryFactory.deploy(await entityProvider.getAddress(), {
      gasLimit: 60_000_000n,
      nonce: await nextNonce(left),
    });
    await depository.waitForDeployment();

    const tokenId = 1n;
    const disputeNonce = 1n;
    const finalNonce = 2n;
    const appointmentSequence = 5;
    const lastResortWindowBlocks = 16;
    const initialArguments = '0x';

    await (await depository.mintToReserve(watched.entityId, tokenId, 1_000n, {
      nonce: await nextNonce(left),
    })).wait();

    const collateralBatch = createEmptyBatch();
    collateralBatch.reserveToCollateral.push({
      tokenId,
      receivingEntity: watched.entityId,
      pairs: [{ entity: counterparty.entityId, amount: 300n }],
    });
    const collateralSigned = await signDepositoryBatch(depository, watched.entityId, watched.privateKey, collateralBatch);
    await (await depository.connect(watched.wallet).processBatch(
      collateralSigned.encodedBatch,
      collateralSigned.hankoData,
      collateralSigned.nonce,
      { nonce: await nextNonce(watched.wallet) },
    )).wait();

    const accountKey = await depository.accountKey(watched.entityId, counterparty.entityId);
    const initialProofbody = proofBody([0n], [tokenId]);
    const initialProofbodyHash = proofBodyHash(initialProofbody);
    const startHash = await disputeProofHash(depository, accountKey, disputeNonce, initialProofbodyHash);
    const startSig = signEntityHash(counterparty.entityId, startHash, counterparty.privateKey);
    const disputeStartBatch = createEmptyBatch();
    disputeStartBatch.disputeStarts.push({
      counterentity: counterparty.entityId,
      nonce: disputeNonce,
      proofbodyHash: initialProofbodyHash,
      sig: startSig,
      initialArguments,
    });
    const disputeStartSigned = await signDepositoryBatch(depository, watched.entityId, watched.privateKey, disputeStartBatch);
    await (await depository.connect(watched.wallet).processBatch(
      disputeStartSigned.encodedBatch,
      disputeStartSigned.hankoData,
      disputeStartSigned.nonce,
      { nonce: await nextNonce(watched.wallet) },
    )).wait();

    const finalProofbody = proofBody([-200n], [tokenId]);
    const finalProofbodyHash = proofBodyHash(finalProofbody);
    const finalHash = await disputeProofHash(depository, accountKey, finalNonce, finalProofbodyHash);
    const finalSig = signEntityHash(counterparty.entityId, finalHash, counterparty.privateKey);
    const ownerAuthHash = await depository.computeWatchtowerCounterDisputeHash(
      tower.address,
      watched.entityId,
      counterparty.entityId,
      finalNonce,
      finalProofbodyHash,
      BigInt(lastResortWindowBlocks),
      BigInt(appointmentSequence),
    );
    const ownerAuthorizationHanko = signEntityHash(watched.entityId, ownerAuthHash, watched.privateKey);

    const runtimeId = watched.wallet.address.toLowerCase();
    const runtimeSeed = 'watchtower-rpc-last-resort-test';
    const lookupKey = deriveRuntimeRecoveryActionLookupKey(runtimeId, runtimeSeed, watched.entityId, counterparty.entityId);
    const remedy: TowerCounterDisputeRemedyV1 = {
      version: 1,
      type: 'counter_dispute_remedy',
      rpcUrl,
      chainId: 31337,
      depositoryAddress: await depository.getAddress(),
      watchedEntityId: watched.entityId,
      towerAddress: tower.address.toLowerCase(),
      lastResortWindowBlocks,
      appointmentSequence,
      ownerAuthorizationHanko,
      latestProof: {
        counterentity: counterparty.entityId,
        finalNonce: Number(finalNonce),
        finalProofbody,
        finalArguments: '0x',
        sig: finalSig,
      },
    };
    const activePayload: TowerActivePayloadV1 = {
      triggerHint: `${watched.entityId}:${counterparty.entityId}`,
      encryptedRemedy: await encryptTowerPayloadForPublicKey(
        encodeTowerCounterDisputeRemedy(remedy),
        getTowerPayloadEncryptionPublicKey(tower.privateKey),
      ),
      actionKind: 'counter_dispute_only',
      appointmentSequence,
      proofNonce: Number(finalNonce),
      proofBodyHash: finalProofbodyHash,
      responseMode: 'last_resort',
      lastResortWindowBlocks,
      safetyMarginBlocks: 0,
    };
    const bundle = {
      version: 1 as const,
      runtimeId,
      lookupKey,
      height: 9,
      createdAt: Date.now(),
      bundleHash: ethers.keccak256(ethers.toUtf8Bytes('rpc-last-resort-bundle')),
      iv: '0x1234',
      ciphertext: '0xabcd',
    };
    const signedAt = Date.now();
    const appointment: TowerAppointmentV1 = {
      type: 'tower_appointment',
      version: 1,
      towerMode: 'delayed_last_resort',
      lookupKey,
      slot: 0,
      bundle,
      activePayload,
      ownerProof: {
        runtimeId,
        signedAt,
        signature: await watched.wallet.signMessage(
          buildTowerAppointmentOwnerMessage(
            runtimeId,
            'delayed_last_resort',
            lookupKey,
            0,
            bundle.bundleHash,
            bundle.height,
            signedAt,
            activePayload,
          ),
        ),
      },
    };

    const towerServer = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'rpc-last-resort',
      dbPath: join(tempRoot, 'tower.level'),
      towerPrivateKey: tower.privateKey,
      maxStoredBytesPerLookupKey: 64 * 1024,
    });
    servers.push(towerServer);

    const upload = await fetch(`http://127.0.0.1:${towerServer.server.port}/api/tower/appointment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(appointment),
    });
    expect(upload.ok).toBe(true);

    const liveContract = depository.connect(tower);
    const liveSweepOptions = {
      lookupKey,
      towerPrivateKey: tower.privateKey,
      providerFactory: () => provider,
      contractFactory: () => ({
        accountKey: (entityId: string, counterentity: string) => liveContract.accountKey(entityId, counterentity),
        _accounts: (acctKey: string) => liveContract._accounts(acctKey),
        watchtowerCounterDispute: (
          entityId: string,
          finalization: Parameters<typeof liveContract.watchtowerCounterDispute>[1],
          lastResortBlocks: number,
          sequence: number,
          ownerHanko: string,
        ) => liveContract.watchtowerCounterDispute(
          entityId,
          finalization,
          BigInt(lastResortBlocks),
          BigInt(sequence),
          ownerHanko,
        ),
      }),
    } as const;

    expect(await runWatchtowerSweep(towerServer.store, {
      ...liveSweepOptions,
    })).toEqual({
      scanned: 1,
      submitted: 0,
      skipped: 1,
      errors: 0,
    });
    expect((await depository._accounts(accountKey)).nonce).toBe(disputeNonce);

    const disputeTimeout = BigInt((await depository._accounts(accountKey)).disputeTimeout);
    const currentBlock = BigInt(await provider.getBlockNumber());
    const lastResortStartBlock = disputeTimeout - BigInt(lastResortWindowBlocks);
    if (lastResortStartBlock > currentBlock) {
      const blocksToMine = Number(lastResortStartBlock - currentBlock);
      if (Number.isFinite(blocksToMine) && blocksToMine > 0) {
        await provider.send('anvil_mine', [blocksToMine]);
      } else {
        for (let remaining = lastResortStartBlock - currentBlock; remaining > 0n; remaining -= 1n) {
          await provider.send('evm_mine', []);
        }
      }
    }

    const liveSweepResult = await runWatchtowerSweep(towerServer.store, {
      ...liveSweepOptions,
    });
    expect(liveSweepResult).toEqual({
      scanned: 1,
      submitted: 1,
      skipped: 0,
      errors: 0,
    });

    const finalizedAccount = await depository._accounts(accountKey);
    const collateralAfter = await depository._collaterals(accountKey, tokenId);
    expect(finalizedAccount.nonce).toBe(finalNonce);
    expect(finalizedAccount.disputeHash).toBe(ethers.ZeroHash);
    expect(collateralAfter.collateral).toBe(0n);
    expect(collateralAfter.ondelta).toBe(0n);
    expect(await depository._reserves(watched.entityId, tokenId)).toBe(800n);
    expect(await depository._reserves(counterparty.entityId, tokenId)).toBe(200n);

    const actionResponse = await fetch(`http://127.0.0.1:${towerServer.server.port}/api/watchtower/actions/${lookupKey}`);
    expect(actionResponse.ok).toBe(true);
    const actionPayload = await actionResponse.json() as { ok: boolean; receipts?: StoredTowerActionReceipt[] };
    expect(actionPayload.ok).toBe(true);
    expect(actionPayload.receipts?.map((receipt) => receipt.status)).toContain('skipped');
    expect(actionPayload.receipts?.map((receipt) => receipt.status)).toContain('submitted');
    expect(actionPayload.receipts?.find((receipt) => receipt.status === 'submitted')?.txHash).toMatch(/^0x[0-9a-f]+$/);

    await provider.destroy();
  }, 60_000);

  test('stale tower remedy cannot override a newer user-submitted counter-dispute', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'xln-watchtower-rpc-stale-'));
    tempRoots.push(tempRoot);

    const anvilPort = 9654 + Math.floor(Math.random() * 1000);
    const { rpcUrl } = await startAnvil(anvilPort);
    const provider = new JsonRpcProvider(rpcUrl, 31337);
    const nextNonce = createNonceManager(provider);

    const left = new Wallet(derivePrivateKey(0), provider);
    const right = new Wallet(derivePrivateKey(1), provider);
    const tower = new Wallet(derivePrivateKey(2), provider);
    const [watched, counterparty] = BigInt(generateLazyEntityId([left.address], 1n)) < BigInt(generateLazyEntityId([right.address], 1n))
      ? [
          { wallet: left, entityId: generateLazyEntityId([left.address], 1n).toLowerCase(), privateKey: derivePrivateKey(0) },
          { wallet: right, entityId: generateLazyEntityId([right.address], 1n).toLowerCase(), privateKey: derivePrivateKey(1) },
        ]
      : [
          { wallet: right, entityId: generateLazyEntityId([right.address], 1n).toLowerCase(), privateKey: derivePrivateKey(1) },
          { wallet: left, entityId: generateLazyEntityId([left.address], 1n).toLowerCase(), privateKey: derivePrivateKey(0) },
        ];

    const accountArtifact = await loadArtifact(join(process.cwd(), 'jurisdictions/artifacts/contracts/Account.sol/Account.json'));
    const entityProviderArtifact = await loadArtifact(join(process.cwd(), 'jurisdictions/artifacts/contracts/EntityProvider.sol/EntityProvider.json'));
    const depositoryArtifact = await loadArtifact(join(process.cwd(), 'jurisdictions/artifacts/contracts/Depository.sol/Depository.json'));

    const accountFactory = new ContractFactory(accountArtifact.abi, accountArtifact.bytecode, left);
    const account = await accountFactory.deploy({ nonce: await nextNonce(left) });
    await account.waitForDeployment();

    const entityProviderFactory = new ContractFactory(entityProviderArtifact.abi, entityProviderArtifact.bytecode, left);
    const entityProvider = await entityProviderFactory.deploy({ nonce: await nextNonce(left) });
    await entityProvider.waitForDeployment();

    const linkedDepositoryBytecode = linkArtifactBytecode(depositoryArtifact.bytecode, {
      'contracts/Account.sol:Account': await account.getAddress(),
    });
    const depositoryFactory = new ContractFactory(depositoryArtifact.abi, linkedDepositoryBytecode, left);
    const depository = await depositoryFactory.deploy(await entityProvider.getAddress(), {
      gasLimit: 60_000_000n,
      nonce: await nextNonce(left),
    });
    await depository.waitForDeployment();

    const tokenId = 1n;
    const disputeNonce = 1n;
    const towerFinalNonce = 2n;
    const userFinalNonce = 3n;
    const appointmentSequence = 6;
    const lastResortWindowBlocks = 16;
    const initialArguments = '0x';

    await (await depository.mintToReserve(watched.entityId, tokenId, 1_000n, {
      nonce: await nextNonce(left),
    })).wait();

    const collateralBatch = createEmptyBatch();
    collateralBatch.reserveToCollateral.push({
      tokenId,
      receivingEntity: watched.entityId,
      pairs: [{ entity: counterparty.entityId, amount: 300n }],
    });
    const collateralSigned = await signDepositoryBatch(depository, watched.entityId, watched.privateKey, collateralBatch);
    await (await depository.connect(watched.wallet).processBatch(
      collateralSigned.encodedBatch,
      collateralSigned.hankoData,
      collateralSigned.nonce,
      { nonce: await nextNonce(watched.wallet) },
    )).wait();

    const accountKey = await depository.accountKey(watched.entityId, counterparty.entityId);
    const initialProofbody = proofBody([0n], [tokenId]);
    const initialProofbodyHash = proofBodyHash(initialProofbody);
    const startHash = await disputeProofHash(depository, accountKey, disputeNonce, initialProofbodyHash);
    const startSig = signEntityHash(counterparty.entityId, startHash, counterparty.privateKey);
    const disputeStartBatch = createEmptyBatch();
    disputeStartBatch.disputeStarts.push({
      counterentity: counterparty.entityId,
      nonce: disputeNonce,
      proofbodyHash: initialProofbodyHash,
      sig: startSig,
      initialArguments,
    });
    const disputeStartSigned = await signDepositoryBatch(depository, watched.entityId, watched.privateKey, disputeStartBatch);
    await (await depository.connect(watched.wallet).processBatch(
      disputeStartSigned.encodedBatch,
      disputeStartSigned.hankoData,
      disputeStartSigned.nonce,
      { nonce: await nextNonce(watched.wallet) },
    )).wait();

    const towerProofbody = proofBody([-200n], [tokenId]);
    const towerProofbodyHash = proofBodyHash(towerProofbody);
    const towerFinalHash = await disputeProofHash(depository, accountKey, towerFinalNonce, towerProofbodyHash);
    const towerFinalSig = signEntityHash(counterparty.entityId, towerFinalHash, counterparty.privateKey);
    const ownerAuthHash = await depository.computeWatchtowerCounterDisputeHash(
      tower.address,
      watched.entityId,
      counterparty.entityId,
      towerFinalNonce,
      towerProofbodyHash,
      BigInt(lastResortWindowBlocks),
      BigInt(appointmentSequence),
    );
    const ownerAuthorizationHanko = signEntityHash(watched.entityId, ownerAuthHash, watched.privateKey);

    const runtimeId = watched.wallet.address.toLowerCase();
    const runtimeSeed = 'watchtower-rpc-stale-last-resort-test';
    const lookupKey = deriveRuntimeRecoveryActionLookupKey(runtimeId, runtimeSeed, watched.entityId, counterparty.entityId);
    const towerRemedy: TowerCounterDisputeRemedyV1 = {
      version: 1,
      type: 'counter_dispute_remedy',
      rpcUrl,
      chainId: 31337,
      depositoryAddress: await depository.getAddress(),
      watchedEntityId: watched.entityId,
      towerAddress: tower.address.toLowerCase(),
      lastResortWindowBlocks,
      appointmentSequence,
      ownerAuthorizationHanko,
      latestProof: {
        counterentity: counterparty.entityId,
        finalNonce: Number(towerFinalNonce),
        finalProofbody: towerProofbody,
        finalArguments: '0x',
        sig: towerFinalSig,
      },
    };
    const activePayload: TowerActivePayloadV1 = {
      triggerHint: `${watched.entityId}:${counterparty.entityId}`,
      encryptedRemedy: await encryptTowerPayloadForPublicKey(
        encodeTowerCounterDisputeRemedy(towerRemedy),
        getTowerPayloadEncryptionPublicKey(tower.privateKey),
      ),
      actionKind: 'counter_dispute_only',
      appointmentSequence,
      proofNonce: Number(towerFinalNonce),
      proofBodyHash: towerProofbodyHash,
      responseMode: 'last_resort',
      lastResortWindowBlocks,
      safetyMarginBlocks: 0,
    };
    const bundle = {
      version: 1 as const,
      runtimeId,
      lookupKey,
      height: 9,
      createdAt: Date.now(),
      bundleHash: ethers.keccak256(ethers.toUtf8Bytes('rpc-stale-last-resort-bundle')),
      iv: '0x1234',
      ciphertext: '0xabcd',
    };
    const signedAt = Date.now();
    const appointment: TowerAppointmentV1 = {
      type: 'tower_appointment',
      version: 1,
      towerMode: 'delayed_last_resort',
      lookupKey,
      slot: 0,
      bundle,
      activePayload,
      ownerProof: {
        runtimeId,
        signedAt,
        signature: await watched.wallet.signMessage(
          buildTowerAppointmentOwnerMessage(
            runtimeId,
            'delayed_last_resort',
            lookupKey,
            0,
            bundle.bundleHash,
            bundle.height,
            signedAt,
            activePayload,
          ),
        ),
      },
    };

    const towerServer = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'rpc-last-resort-stale',
      dbPath: join(tempRoot, 'tower.level'),
      towerPrivateKey: tower.privateKey,
      maxStoredBytesPerLookupKey: 64 * 1024,
    });
    servers.push(towerServer);

    const upload = await fetch(`http://127.0.0.1:${towerServer.server.port}/api/tower/appointment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(appointment),
    });
    expect(upload.ok).toBe(true);

    const userProofbody = proofBody([-150n], [tokenId]);
    const userProofbodyHash = proofBodyHash(userProofbody);
    const userFinalHash = await disputeProofHash(depository, accountKey, userFinalNonce, userProofbodyHash);
    const userFinalSig = signEntityHash(counterparty.entityId, userFinalHash, counterparty.privateKey);
    const userFinalizeBatch = createEmptyBatch();
    userFinalizeBatch.disputeFinalizations.push({
      counterentity: counterparty.entityId,
      initialNonce: disputeNonce,
      finalNonce: userFinalNonce,
      initialProofbodyHash,
      finalProofbody: userProofbody,
      finalArguments: '0x',
      initialArguments,
      sig: userFinalSig,
      startedByLeft: true,
      disputeUntilBlock: 0,
      cooperative: false,
    });
    const userFinalizeSigned = await signDepositoryBatch(depository, watched.entityId, watched.privateKey, userFinalizeBatch);
    await (await depository.connect(watched.wallet).processBatch(
      userFinalizeSigned.encodedBatch,
      userFinalizeSigned.hankoData,
      userFinalizeSigned.nonce,
      { nonce: await nextNonce(watched.wallet) },
    )).wait();

    const disputeAccount = await depository._accounts(accountKey);
    expect(disputeAccount.nonce).toBe(userFinalNonce);
    expect(disputeAccount.disputeHash).toBe(ethers.ZeroHash);

    const sweepResult = await runWatchtowerSweep(towerServer.store, {
      lookupKey,
      towerPrivateKey: tower.privateKey,
      providerFactory: () => provider,
      contractFactory: () => {
        const liveContract = depository.connect(tower);
        return {
          accountKey: (entityId: string, counterentity: string) => liveContract.accountKey(entityId, counterentity),
          _accounts: (acctKey: string) => liveContract._accounts(acctKey),
          watchtowerCounterDispute: (
            entityId: string,
            finalization: Parameters<typeof liveContract.watchtowerCounterDispute>[1],
            lastResortBlocks: number,
            sequence: number,
            ownerHanko: string,
          ) => liveContract.watchtowerCounterDispute(
            entityId,
            finalization,
            BigInt(lastResortBlocks),
            BigInt(sequence),
            ownerHanko,
          ),
        };
      },
    });
    expect(sweepResult).toEqual({
      scanned: 1,
      submitted: 0,
      skipped: 1,
      errors: 0,
    });

    const actionResponse = await fetch(`http://127.0.0.1:${towerServer.server.port}/api/watchtower/actions/${lookupKey}`);
    expect(actionResponse.ok).toBe(true);
    const actionPayload = await actionResponse.json() as { ok: boolean; receipts?: StoredTowerActionReceipt[] };
    expect(actionPayload.ok).toBe(true);
    expect(actionPayload.receipts?.at(-1)?.status).toBe('skipped');

    await provider.destroy();
  }, 60_000);
});
