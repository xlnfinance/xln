import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { createJAdapter } from '../jadapter';
import { verifyCanonicalReceiptProof } from '../jadapter/receipt-codec';
import { createEmptyEnv } from '../runtime';
import { bindScenarioJReplica, createJReplica, createJurisdictionConfig } from '../scenarios/boot';
import { buildCanonicalJReplicaSnapshot } from '../wal/snapshot';
import type { EntityReplica } from '../types';

const makeReplica = (entityId: string, signerId: string): EntityReplica =>
  ({
    entityId,
    signerId,
    mempool: [],
    isProposer: true,
    state: {
      entityId,
      height: 0,
      timestamp: 1,
      nonces: new Map(),
      messages: [],
      proposals: new Map(),
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [signerId],
        shares: { [signerId]: 1n },
      },
      reserves: new Map(),
      accounts: new Map(),
      deferredAccountProposals: new Map(),
      lastFinalizedJHeight: 0,
      jBlockChain: [],
      entityEncPubKey: `${'0x'}${'11'.repeat(32)}`,
      entityEncPrivKey: `${'0x'}${'22'.repeat(32)}`,
      profile: {
        name: 'BrowserVM Entity',
        isHub: false,
        avatar: '',
        bio: '',
        website: '',
      },
      htlcRoutes: new Map(),
      htlcFeesEarned: 0n,
      htlcNotes: new Map(),
      lockBook: new Map(),
      swapTradingPairs: [],
    },
  }) as EntityReplica;

describe('BrowserVM JAdapter boundary', () => {
  test('contract reads never mutate the BrowserVM state root', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31337 });
    try {
      const capture = adapter.captureStateRoot;
      if (!capture) throw new Error('BROWSERVM_STATE_ROOT_READER_MISSING');
      const before = ethers.hexlify(await capture());
      await adapter.depository.entityProvider();
      await adapter.depository.getTokensLength();
      await adapter.getReserves(ethers.ZeroHash, 1);
      await adapter.getErc20Balance(adapter.addresses.depository, ethers.ZeroAddress);
      expect(await adapter.getDebts?.(ethers.ZeroHash, 1)).toEqual([]);
      const after = ethers.hexlify(await capture());
      expect(after).toBe(before);
    } finally {
      await adapter.close();
    }
  });

  test('serializes a checkpointed read with a concurrent faucet write', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31337 });
    const browserVM = adapter.getBrowserVM();
    if (!browserVM) throw new Error('BROWSERVM_PROVIDER_MISSING');
    const vm = (browserVM as unknown as {
      vm: { evm: { runCall: (request: unknown) => Promise<unknown> } };
    }).vm;
    const originalRunCall = vm.evm.runCall.bind(vm.evm);
    let enterRead!: () => void;
    const readEntered = new Promise<void>((resolve) => { enterRead = resolve; });
    let releaseRead!: () => void;
    const readRelease = new Promise<void>((resolve) => { releaseRead = resolve; });
    let pauseFirstRead = true;
    vm.evm.runCall = async (request: unknown): Promise<unknown> => {
      if (pauseFirstRead) {
        pauseFirstRead = false;
        enterRead();
        await readRelease;
      }
      return originalRunCall(request);
    };
    const target = '0x000000000000000000000000000000000000dEaD';
    try {
      const beforeRoot = ethers.hexlify(await adapter.captureStateRoot!());
      const read = adapter.getReserves(ethers.ZeroHash, 1);
      await readEntered;
      if (!browserVM.fundSignerWallet) throw new Error('BROWSERVM_FAUCET_MISSING');
      const write = browserVM.fundSignerWallet(target);
      const writeState = await Promise.race([
        write.then(() => 'resolved' as const),
        Bun.sleep(25).then(() => 'blocked' as const),
      ]);
      expect(writeState).toBe('blocked');

      releaseRead();
      await read;
      await write;

      expect(await browserVM.getEthBalance?.(target)).toBe(1_000n * 10n ** 18n);
      expect(ethers.hexlify(await adapter.captureStateRoot!())).not.toBe(beforeRoot);
    } finally {
      releaseRead();
      vm.evm.runCall = originalRunCall;
      await adapter.close();
    }
  }, 30_000);

  test('allocates distinct nonces to concurrent public writes', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31337 });
    const browserVM = adapter.getBrowserVM();
    if (!browserVM) throw new Error('BROWSERVM_PROVIDER_MISSING');
    const provider = browserVM as unknown as {
      runTxWithNonce: (
        signer: unknown,
        buildTx: (nonce: bigint) => unknown,
      ) => Promise<unknown>;
    };
    const originalRunTxWithNonce = provider.runTxWithNonce.bind(provider);
    const allocatedNonces: bigint[] = [];
    provider.runTxWithNonce = async (signer, buildTx) => originalRunTxWithNonce(
      signer,
      (nonce) => {
        allocatedNonces.push(nonce);
        return buildTx(nonce);
      },
    );
    const deployerKey = ethers.getBytes(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const firstTarget = '0x000000000000000000000000000000000000dEaD';
    const secondTarget = '0x000000000000000000000000000000000000bEEF';
    try {
      const [firstHash, secondHash] = await Promise.all([
        browserVM.transferNative(deployerKey, firstTarget, 11n),
        browserVM.transferNative(deployerKey, secondTarget, 22n),
      ]);
      expect(allocatedNonces).toHaveLength(2);
      expect(allocatedNonces[1]).toBe(allocatedNonces[0]! + 1n);
      expect(firstHash).not.toBe(secondHash);
      expect(await browserVM.getEthBalance?.(firstTarget)).toBe(11n);
      expect(await browserVM.getEthBalance?.(secondTarget)).toBe(22n);
    } finally {
      provider.runTxWithNonce = originalRunTxWithNonce;
      await adapter.close();
    }
  }, 30_000);

  test('rejects replayed or stale signed nonces before mutating BrowserVM state', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31337 });
    const browserVM = adapter.getBrowserVM();
    if (!browserVM?.fundSignerWallet || !browserVM.getEthBalance) {
      throw new Error('BROWSERVM_SIGNED_TX_API_MISSING');
    }
    const wallet = new ethers.Wallet(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412d5f0e9e25b1c8b',
    );
    const firstTarget = '0x000000000000000000000000000000000000dEaD';
    const staleTarget = '0x000000000000000000000000000000000000bEEF';
    try {
      await browserVM.fundSignerWallet(wallet.address);
      const sign = (to: string, value: bigint) => wallet.signTransaction({
        chainId: 31337,
        nonce: 0,
        gasLimit: 21_000,
        gasPrice: 10,
        to,
        value,
      });
      const signed = await sign(firstTarget, 17n);
      await browserVM.executeSignedTx(signed);
      const committedRoot = ethers.hexlify(await adapter.captureStateRoot!());
      expect(await browserVM.getEthBalance(firstTarget)).toBe(17n);

      await expect(browserVM.executeSignedTx(signed))
        .rejects.toThrow('BROWSERVM_RECEIPT_DUPLICATE_TRANSACTION');
      expect(ethers.hexlify(await adapter.captureStateRoot!())).toBe(committedRoot);
      expect(await browserVM.getEthBalance(firstTarget)).toBe(17n);

      await expect(browserVM.executeSignedTx(await sign(staleTarget, 23n))).rejects.toThrow();
      expect(ethers.hexlify(await adapter.captureStateRoot!())).toBe(committedRoot);
      expect(await browserVM.getEthBalance(staleTarget)).toBe(0n);
    } finally {
      await adapter.close();
    }
  }, 30_000);

  test('proves EntityRegistered after an empty-log transaction in the same block', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31337 });
    try {
      await adapter.deployStack();
      const browserVM = adapter.getBrowserVM();
      if (!browserVM) throw new Error('BROWSERVM_PROVIDER_MISSING');

      browserVM.beginJurisdictionBlock(1_700_000_000_000);
      const transferHash = await browserVM.transferNative(
        ethers.getBytes('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
        '0x000000000000000000000000000000000000dEaD',
        1n,
      );
      const { txHash: registrationHash } = await browserVM.registerNumberedEntitiesBatch([
        `${'0x'}${'53'.repeat(32)}`,
      ]);
      const blockNumber = browserVM.getBlockHeight();
      browserVM.endJurisdictionBlock();

      const transferReceipt = browserVM.getTransactionReceipt(transferHash);
      const registrationReceipt = browserVM.getTransactionReceipt(registrationHash);
      expect(transferReceipt?.logs).toHaveLength(0);
      expect(transferReceipt?.transactionIndex).toBe(0);
      expect(registrationReceipt?.transactionIndex).toBe(1);
      expect(BigInt(registrationReceipt?.cumulativeGasUsed ?? 0n))
        .toBeGreaterThan(BigInt(transferReceipt?.cumulativeGasUsed ?? 0n));

      const logs = await browserVM.getAuthenticatedLogsForRange(
        blockNumber,
        blockNumber,
        [adapter.addresses.entityProvider],
      );
      const registrationLogs = logs.filter(log => (
        log.topics[0] === ethers.id('EntityRegistered(bytes32,uint256,bytes32)').toLowerCase()
      ));
      expect(registrationLogs).toHaveLength(1);
      expect(registrationLogs[0]?.transactionHash).toBe(registrationHash.toLowerCase());
      expect(registrationLogs[0]?.transactionIndex).toBe(1);
      await expect(verifyCanonicalReceiptProof(registrationLogs[0]!.receiptProof))
        .resolves.toBeUndefined();

      const checkpoint = browserVM.captureChainCheckpoint();
      const duplicateIndex = structuredClone(checkpoint);
      const sameBlockReceipts = duplicateIndex.txReceipts.filter(([, receipt]) => (
        receipt.blockNumber === blockNumber
      ));
      sameBlockReceipts[1]![1].transactionIndex = 0;
      await expect(browserVM.restoreChainCheckpoint(duplicateIndex))
        .rejects.toThrow('J_RECEIPT_TRANSACTION_INDEX_GAP');
      expect(browserVM.captureChainCheckpoint()).toEqual(checkpoint);

      const wrongRoot = structuredClone(checkpoint);
      const rootEntry = wrongRoot.blockReceiptRoots.find(([height]) => height === blockNumber);
      if (!rootEntry) throw new Error('BROWSERVM_TEST_RECEIPT_ROOT_MISSING');
      rootEntry[1] = `0x${'11'.repeat(32)}`;
      await expect(browserVM.restoreChainCheckpoint(wrongRoot))
        .rejects.toThrow('BROWSERVM_CHECKPOINT_RECEIPT_ROOT_MISMATCH');
      expect(browserVM.captureChainCheckpoint()).toEqual(checkpoint);
    } finally {
      await adapter.close();
    }
  });

  test('reset removes receipt commitments beyond the fresh chain head', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31337 });
    try {
      await adapter.deployStack();
      const browserVM = adapter.getBrowserVM();
      if (!browserVM) throw new Error('BROWSERVM_PROVIDER_MISSING');
      const registration = await adapter.entityProvider.registerNumberedEntity(`${'0x'}${'54'.repeat(32)}`);
      const staleHeight = Number((await registration.wait())?.blockNumber ?? 0);
      expect(browserVM.captureChainCheckpoint().blockReceiptRoots.some(([height]) => height === staleHeight))
        .toBe(true);

      await browserVM.reset();
      const fresh = browserVM.captureChainCheckpoint();
      expect(fresh.blockHeight).toBeLessThan(staleHeight);
      expect(fresh.blockReceiptRoots.every(([height]) => height <= fresh.blockHeight)).toBe(true);
      expect(fresh.blockReceiptRoots.some(([height]) => height === staleHeight)).toBe(false);
    } finally {
      await adapter.close();
    }
  });

  test('dump/load restores authenticated receipt and block-header history', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31337 });
    try {
      await adapter.deployStack();
      const browserVM = adapter.getBrowserVM();
      if (!browserVM) throw new Error('BROWSERVM_PROVIDER_MISSING');
      const first = await adapter.entityProvider.registerNumberedEntity(`${'0x'}${'51'.repeat(32)}`);
      const firstReceipt = await first.wait();
      const persistedHeight = Number(firstReceipt?.blockNumber ?? 0);
      const dumped = await adapter.dumpState();

      await (await adapter.entityProvider.registerNumberedEntity(`${'0x'}${'52'.repeat(32)}`)).wait();
      expect(await adapter.getCurrentBlockNumber?.()).toBeGreaterThan(persistedHeight);

      const { chain: _chain, ...missingChain } = dumped;
      await expect(adapter.loadState(missingChain as never)).rejects.toThrow('BROWSERVM_CHAIN_STATE_MISSING');

      await adapter.loadState(dumped);
      expect(await adapter.getCurrentBlockNumber?.()).toBe(persistedHeight);
      const restoredLogs = browserVM.getLogs({
        address: adapter.addresses.entityProvider,
        fromBlock: persistedHeight,
        toBlock: persistedHeight,
      });
      expect(restoredLogs.some((log) => log.transactionHash === firstReceipt?.hash)).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  test('deploys, supports typed contracts, snapshots, and feeds watcher events', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31337 });
    try {
      await adapter.deployStack();
      expect(adapter.mode).toBe('browservm');
      expect(adapter.getBrowserVM()).not.toBeNull();
      expect(adapter.addresses.depository).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(adapter.addresses.entityProvider).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(await adapter.depository.getTokensLength()).toBeGreaterThan(1n);

      const beforeSnapshot = await adapter.entityProvider.nextNumber();
      const beforeSnapshotBlock = await adapter.getCurrentBlockNumber?.();
      const snapshot = await adapter.snapshot();
      await (await adapter.entityProvider.registerNumberedEntity(`${'0x'}${'33'.repeat(32)}`)).wait();
      expect(await adapter.entityProvider.nextNumber()).toBe(beforeSnapshot + 1n);
      await adapter.revert(snapshot);
      expect(await adapter.entityProvider.nextNumber()).toBe(beforeSnapshot);
      expect(await adapter.getCurrentBlockNumber?.()).toBe(beforeSnapshotBlock);
      const browserVM = adapter.getBrowserVM();
      if (!browserVM || beforeSnapshotBlock === undefined) throw new Error('BROWSERVM_CHECKPOINT_API_MISSING');
      expect(browserVM.getLogs({ fromBlock: beforeSnapshotBlock + 1 })).toHaveLength(0);

      const env = createEmptyEnv('browservm-adapter-boundary');
      env.scenarioMode = true;
      env.timestamp = 1;
      const jReplica = bindScenarioJReplica(
        env,
        createJReplica(env, 'BrowserVM Adapter', adapter.addresses.depository),
        adapter,
      );
      expect(jReplica.watcherConfirmationDepth).toBe(adapter.getFinalityDepth?.());
      expect(jReplica.chainId).toBe(Number(adapter.chainId));
      expect(jReplica.contracts).toEqual(adapter.addresses);
      expect(buildCanonicalJReplicaSnapshot(jReplica).watcherConfirmationDepth).toBe(0);
      const entityId = `${'0x'}${'44'.repeat(32)}`;
      const signerId = '1';
      const entityReplica = makeReplica(entityId, signerId);
      entityReplica.state.config.jurisdiction = createJurisdictionConfig(
        jReplica.name,
        adapter.addresses.depository,
        adapter.addresses.entityProvider,
        'browservm://',
        Number(adapter.chainId),
      );
      env.eReplicas.set(`${entityId}:${signerId}`, entityReplica);

      adapter.startWatching(env);
      const events = await adapter.debugFundReserves(entityId, 1, 123n);
      expect(events.some((event) => event.name === 'ReserveUpdated')).toBe(true);

      const runtimeTxs = env.runtimeMempool?.runtimeTxs ?? [];
      expect(runtimeTxs.some((tx) => tx.type === 'observeJRange')).toBe(true);
      expect(runtimeTxs.some((tx) => tx.type === 'recordAuthenticatedJAuthority')).toBe(true);
      expect(runtimeTxs.some((tx) => tx.type === 'observeJRange' &&
        tx.data.blocks.flatMap(block => block.events).some(event => event.type === 'ReserveUpdated'))).toBe(true);

      // A receipt changes only validator-local observed jurisdiction history.
      // It must not inject a financial j_event directly into Entity consensus;
      // the separately tested J-prefix quorum path turns this observation into
      // an exact certified range after every validator verifies its own prefix.
      expect(env.runtimeMempool?.entityInputs ?? []).toHaveLength(0);
      expect(entityReplica.state.reserves.has(1)).toBe(false);
    } finally {
      await adapter.close();
    }
  });
});
