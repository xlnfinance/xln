import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';

import { registerSignerKey, signAccountFrame } from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import { buildSingleSignerHanko } from '../hanko/batch';
import {
  hashBoardProposalCancelHankoPayload,
  hashBoardProposalHankoPayload,
  hashCancelEntityProviderActionHankoPayload,
  hashEntityTransferHankoPayload,
} from '../hanko/onchain-domain';
import { buildQuorumHanko } from '../hanko/signing';
import { createJAdapter, createXlnJsonRpcProvider, type JAdapter } from '../jadapter';
import { computeBatchHankoHash, createEmptyBatch, encodeJBatch } from '../jurisdiction/batch';
import { createSettlementHashWithNonce } from '../protocol/dispute/proof-builder';
import { createEmptyEnv } from '../runtime';

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

describe('On-chain Hanko cross-chain replay protection', () => {
  test('rejects chain-A Account and EntityProvider Hankos on chain B at identical addresses', async () => {
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
      return { address, privateKey, entityId: generateLazyEntityId([address], 1n).toLowerCase() };
    }).sort((left, right) => left.entityId.localeCompare(right.entityId));
    const initiator = parties[0]!;
    const counterparty = parties[1]!;
    const account = { leftEntity: initiator.entityId, rightEntity: counterparty.entityId };
    const domainA = { chainId: CHAIN_A, depositoryAddress: adapterA.addresses.depository };
    const domainB = { chainId: CHAIN_B, depositoryAddress: adapterB.addresses.depository };
    // Pure forgiveness is a valid observable settlement even with no existing
    // debt. An empty settlement is rejected before Hanko verification and
    // therefore cannot prove the cross-chain/address(this) domain invariant.
    const forgivenessTokenIds = [1];
    const hashA = createSettlementHashWithNonce(account, [], forgivenessTokenIds, domainA, 1);
    const hashB = createSettlementHashWithNonce(account, [], forgivenessTokenIds, domainB, 1);
    expect(hashA).not.toBe(hashB);

    // A linked Account function executes by DELEGATECALL. This negative vector
    // proves Solidity sees the Depository as address(this), not the library's
    // own deterministic address.
    const libraryAddressHash = createSettlementHashWithNonce(
      account,
      [],
      forgivenessTokenIds,
      { chainId: CHAIN_A, depositoryAddress: adapterA.addresses.account },
      1,
    );
    const libraryAddressBatch = createEmptyBatch();
    libraryAddressBatch.settlements.push({
      leftEntity: initiator.entityId,
      rightEntity: counterparty.entityId,
      diffs: [],
      forgiveDebtsInTokenIds: forgivenessTokenIds,
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
      forgiveDebtsInTokenIds: forgivenessTokenIds,
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

    const actionEntityId = generateLazyEntityId([initiator.address], 1n).toLowerCase();
    await Promise.all([
      adapterA.entityProvider.registerNumberedEntity(actionEntityId).then((tx) => tx.wait()),
      adapterB.entityProvider.registerNumberedEntity(actionEntityId).then((tx) => tx.wait()),
    ]);
    const numberedEntityId = ethers.zeroPadValue(ethers.toBeHex(2n), 32);
    const actionEntityAddress = ethers.getAddress(`0x${actionEntityId.slice(-40)}`);
    const fundingAuthorization = {
      entityNumber: 2n,
      to: actionEntityAddress,
      tokenId: 2n,
      amount: 100n,
      actionNonce: 1n,
    };
    const fundingHashA = hashEntityTransferHankoPayload({
      chainId: CHAIN_A,
      entityProviderAddress: adapterA.addresses.entityProvider,
      boardEpoch: 0n,
    }, fundingAuthorization);
    const fundingHashB = hashEntityTransferHankoPayload({
      chainId: CHAIN_B,
      entityProviderAddress: adapterB.addresses.entityProvider,
      boardEpoch: 0n,
    }, fundingAuthorization);
    await Promise.all([
      adapterA.entityProvider.entityTransferTokens(
        fundingAuthorization.entityNumber,
        fundingAuthorization.to,
        fundingAuthorization.tokenId,
        fundingAuthorization.amount,
        buildSingleSignerHanko(numberedEntityId, fundingHashA, initiator.privateKey),
      ).then((tx) => tx.wait()),
      adapterB.entityProvider.entityTransferTokens(
        fundingAuthorization.entityNumber,
        fundingAuthorization.to,
        fundingAuthorization.tokenId,
        fundingAuthorization.amount,
        buildSingleSignerHanko(numberedEntityId, fundingHashB, initiator.privateKey),
      ).then((tx) => tx.wait()),
    ]);
    expect(await adapterA.entityProvider.balanceOf(actionEntityAddress, 2n)).toBe(100n);
    expect(await adapterB.entityProvider.balanceOf(actionEntityAddress, 2n)).toBe(100n);

    const entityNumber = BigInt(actionEntityId);
    const transferAuthorization = {
      entityNumber,
      to: counterparty.address,
      tokenId: 2n,
      amount: 100n,
      actionNonce: 1n,
    };
    const actionHashA = hashEntityTransferHankoPayload({
      chainId: CHAIN_A,
      entityProviderAddress: adapterA.addresses.entityProvider,
      boardEpoch: 0n,
    }, transferAuthorization);
    const actionHashB = hashEntityTransferHankoPayload({
      chainId: CHAIN_B,
      entityProviderAddress: adapterB.addresses.entityProvider,
      boardEpoch: 0n,
    }, transferAuthorization);
    expect(actionHashA).not.toBe(actionHashB);
    const actionEnv = createEmptyEnv('two-anvil-entityprovider-quorum');
    const actionSigner = initiator.address.toLowerCase();
    registerSignerKey(actionEnv, actionSigner, ethers.getBytes(initiator.privateKey));
    const actionConfig = {
      mode: 'proposer-based' as const,
      threshold: 1n,
      validators: [actionSigner],
      shares: { [actionSigner]: 1n },
    };
    const buildActionQuorumHanko = async (hash: string): Promise<string> => buildQuorumHanko(
      actionEnv,
      actionEntityId,
      hash,
      [{ signerId: actionSigner, signature: signAccountFrame(actionEnv, actionSigner, hash) }],
      actionConfig,
    );
    const actionHankoA = await buildActionQuorumHanko(actionHashA);
    await (await adapterA.entityProvider.entityTransferTokens(
      entityNumber,
      transferAuthorization.to,
      transferAuthorization.tokenId,
      transferAuthorization.amount,
      actionHankoA,
    )).wait();
    expect(await adapterA.entityProvider.entityActionNonces(actionEntityId)).toBe(1n);
    expect(await adapterA.entityProvider.balanceOf(actionEntityAddress, 2n)).toBe(0n);
    expect(await adapterA.entityProvider.balanceOf(counterparty.address, 2n)).toBe(100n);

    const actionReplayFailure = await adapterB.entityProvider.entityTransferTokens.staticCall(
      entityNumber,
      transferAuthorization.to,
      transferAuthorization.tokenId,
      transferAuthorization.amount,
      actionHankoA,
    ).then(() => null, (error: unknown) => error);
    expect(actionReplayFailure).toBeInstanceOf(Error);
    expect(actionReplayFailure instanceof Error ? actionReplayFailure.message : '')
      .toContain('Invalid entity signature');
    expect(await adapterB.entityProvider.entityActionNonces(actionEntityId)).toBe(0n);
    expect(await adapterB.entityProvider.balanceOf(actionEntityAddress, 2n)).toBe(100n);
    expect(await adapterB.entityProvider.balanceOf(counterparty.address, 2n)).toBe(0n);

    const actionHankoB = await buildActionQuorumHanko(actionHashB);
    await (await adapterB.entityProvider.entityTransferTokens(
      entityNumber,
      transferAuthorization.to,
      transferAuthorization.tokenId,
      transferAuthorization.amount,
      actionHankoB,
    )).wait();
    expect(await adapterB.entityProvider.entityActionNonces(actionEntityId)).toBe(1n);
    expect(await adapterB.entityProvider.balanceOf(actionEntityAddress, 2n)).toBe(0n);
    expect(await adapterB.entityProvider.balanceOf(counterparty.address, 2n)).toBe(100n);

    const cancelAuthorization = {
      entityNumber,
      actionNonce: 2n,
      cancelledActionHash: `0x${'77'.repeat(32)}`,
      cancelledActionKind: 0 as const,
    };
    const cancelHashA = hashCancelEntityProviderActionHankoPayload({
      chainId: CHAIN_A,
      entityProviderAddress: adapterA.addresses.entityProvider,
      boardEpoch: 0n,
    }, cancelAuthorization);
    const cancelHashB = hashCancelEntityProviderActionHankoPayload({
      chainId: CHAIN_B,
      entityProviderAddress: adapterB.addresses.entityProvider,
      boardEpoch: 0n,
    }, cancelAuthorization);
    expect(cancelHashA).not.toBe(cancelHashB);
    const cancelHankoA = await buildActionQuorumHanko(cancelHashA);
    const cancelIntentA = {
      version: 1 as const,
      entityId: actionEntityId,
      entityNumber,
      chainId: BigInt(CHAIN_A),
      entityProviderAddress: adapterA.addresses.entityProvider,
      boardEpoch: 0n,
      actionNonce: cancelAuthorization.actionNonce,
      actionHash: cancelHashA,
      generation: 2,
      createdAt: 1,
      payload: {
        kind: 'cancelPendingAction' as const,
        cancel: {
          cancelledActionHash: cancelAuthorization.cancelledActionHash,
          cancelledActionKind: cancelAuthorization.cancelledActionKind,
        },
      },
    };
    const cancelSubmittedA = await adapterA.submitTx({
      type: 'entityProviderCancelAction',
      entityId: actionEntityId,
      data: { intent: cancelIntentA, signerId: actionSigner, hankoSignature: cancelHankoA },
      timestamp: 1,
    }, { env: actionEnv, signerId: actionSigner, timestamp: 1 });
    expect(cancelSubmittedA.success).toBe(true);
    expect(cancelSubmittedA.events?.filter((event) => event.name === 'EntityProviderActionCancelled'))
      .toHaveLength(1);
    expect(await adapterA.entityProvider.entityActionNonces(actionEntityId)).toBe(2n);

    const cancelReconciledA = await adapterA.submitTx({
      type: 'entityProviderCancelAction',
      entityId: actionEntityId,
      data: { intent: cancelIntentA, signerId: actionSigner, hankoSignature: cancelHankoA },
      timestamp: 2,
    }, { env: actionEnv, signerId: actionSigner, timestamp: 2 });
    expect(cancelReconciledA.success).toBe(true);
    expect(cancelReconciledA.events?.filter((event) => event.name === 'EntityProviderActionCancelled'))
      .toHaveLength(1);

    const cancelReplayFailure = await adapterB.entityProvider.cancelEntityProviderAction.staticCall(
      entityNumber,
      cancelAuthorization.cancelledActionHash,
      cancelAuthorization.cancelledActionKind,
      cancelHankoA,
    ).then(() => null, (error: unknown) => error);
    expect(cancelReplayFailure).toBeInstanceOf(Error);
    expect(cancelReplayFailure instanceof Error ? cancelReplayFailure.message : '')
      .toContain('Invalid entity signature');
    expect(await adapterB.entityProvider.entityActionNonces(actionEntityId)).toBe(1n);

    const cancelHankoB = await buildActionQuorumHanko(cancelHashB);
    const cancelIntentB = {
      ...cancelIntentA,
      chainId: BigInt(CHAIN_B),
      entityProviderAddress: adapterB.addresses.entityProvider,
      actionHash: cancelHashB,
    };
    const cancelSubmittedB = await adapterB.submitTx({
      type: 'entityProviderCancelAction',
      entityId: actionEntityId,
      data: { intent: cancelIntentB, signerId: actionSigner, hankoSignature: cancelHankoB },
      timestamp: 3,
    }, { env: actionEnv, signerId: actionSigner, timestamp: 3 });
    expect(cancelSubmittedB.success).toBe(true);
    expect(await adapterB.entityProvider.entityActionNonces(actionEntityId)).toBe(2n);

    const unusedBoardSigner = new ethers.Wallet(ethers.zeroPadValue('0x03', 32));
    const proposedBoardHash = generateLazyEntityId([unusedBoardSigner.address], 1n).toLowerCase();
    const proposalAuthorization = {
      entityId: numberedEntityId,
      newBoardHash: proposedBoardHash,
      authority: 3,
      actionNonce: 1n,
    };
    const proposalHashA = hashBoardProposalHankoPayload({
      chainId: CHAIN_A,
      entityProviderAddress: adapterA.addresses.entityProvider,
      boardEpoch: 0n,
    }, proposalAuthorization);
    const proposalHashB = hashBoardProposalHankoPayload({
      chainId: CHAIN_B,
      entityProviderAddress: adapterB.addresses.entityProvider,
      boardEpoch: 0n,
    }, proposalAuthorization);
    expect(proposalHashA).not.toBe(proposalHashB);
    const foundationId = ethers.zeroPadValue(ethers.toBeHex(1n), 32);
    const proposalHankoA = buildSingleSignerHanko(foundationId, proposalHashA, PRIVATE_KEYS[0]);
    await (await adapterA.entityProvider.proposeBoard(
      numberedEntityId,
      proposedBoardHash,
      proposalAuthorization.authority,
      [proposalHankoA],
    )).wait();
    expect(await adapterA.entityProvider.boardActionNonces(numberedEntityId)).toBe(1n);

    const proposalReplayFailure = await adapterB.entityProvider.proposeBoard.staticCall(
      numberedEntityId,
      proposedBoardHash,
      proposalAuthorization.authority,
      [proposalHankoA],
    ).then(() => null, (error: unknown) => error);
    expect(proposalReplayFailure).toBeInstanceOf(Error);
    expect(proposalReplayFailure instanceof Error ? proposalReplayFailure.message : '')
      .toContain('InvalidAuthorityAuthorization');
    expect(await adapterB.entityProvider.boardActionNonces(numberedEntityId)).toBe(0n);

    const proposalHankoB = buildSingleSignerHanko(foundationId, proposalHashB, PRIVATE_KEYS[0]);
    await (await adapterB.entityProvider.proposeBoard(
      numberedEntityId,
      proposedBoardHash,
      proposalAuthorization.authority,
      [proposalHankoB],
    )).wait();
    expect(await adapterB.entityProvider.boardActionNonces(numberedEntityId)).toBe(1n);

    const proposalCancelAuthorization = {
      entityId: numberedEntityId,
      proposedBoardHash,
      proposedBy: 3,
      cancelledBy: 0,
      actionNonce: 1n,
    };
    const proposalCancelHashA = hashBoardProposalCancelHankoPayload({
      chainId: CHAIN_A,
      entityProviderAddress: adapterA.addresses.entityProvider,
      boardEpoch: 0n,
    }, proposalCancelAuthorization);
    const proposalCancelHashB = hashBoardProposalCancelHankoPayload({
      chainId: CHAIN_B,
      entityProviderAddress: adapterB.addresses.entityProvider,
      boardEpoch: 0n,
    }, proposalCancelAuthorization);
    expect(proposalCancelHashA).not.toBe(proposalCancelHashB);
    const proposalCancelHankoA = buildSingleSignerHanko(
      numberedEntityId,
      proposalCancelHashA,
      initiator.privateKey,
    );
    await (await adapterA.entityProvider.cancelBoardProposal(
      numberedEntityId,
      proposalCancelAuthorization.cancelledBy,
      [proposalCancelHankoA],
    )).wait();
    expect((await adapterA.entityProvider.entities(numberedEntityId)).proposedBoardHash)
      .toBe(ethers.ZeroHash);

    const proposalCancelReplayFailure = await adapterB.entityProvider.cancelBoardProposal.staticCall(
      numberedEntityId,
      proposalCancelAuthorization.cancelledBy,
      [proposalCancelHankoA],
    ).then(() => null, (error: unknown) => error);
    expect(proposalCancelReplayFailure).toBeInstanceOf(Error);
    expect(proposalCancelReplayFailure instanceof Error ? proposalCancelReplayFailure.message : '')
      .toContain('InvalidAuthorityAuthorization');
    expect((await adapterB.entityProvider.entities(numberedEntityId)).proposedBoardHash)
      .toBe(proposedBoardHash);

    const proposalCancelHankoB = buildSingleSignerHanko(
      numberedEntityId,
      proposalCancelHashB,
      initiator.privateKey,
    );
    await (await adapterB.entityProvider.cancelBoardProposal(
      numberedEntityId,
      proposalCancelAuthorization.cancelledBy,
      [proposalCancelHankoB],
    )).wait();
    expect((await adapterB.entityProvider.entities(numberedEntityId)).proposedBoardHash)
      .toBe(ethers.ZeroHash);
  }, 120_000);
});
