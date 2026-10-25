import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { ethers } from 'ethers';

import type { JurisdictionConfig } from '../../../../entity/types';
import { encodeSingleSignerBoard, hashBoard } from '../../../../entity/factory';
import { buildSingleSignerHanko } from '../../../../hanko/batch';
import { hashBoardProposalHankoPayload } from '../../../../hanko/onchain-domain';
import { createJAdapter, createXlnJsonRpcProvider } from '../../../../jurisdiction/adapter';
import type { JAdapter } from '../../../../jurisdiction/adapter/types';
import { rawEventToJEvents } from '../../../../jurisdiction/adapter/events/j-event-payloads';
import { decodeJEventLog } from '../../../../jurisdiction/adapter/j-event-log-decoder';
import {
  assertCertifiedBoardRegistryMatchesAnchor,
  readCertifiedBoardAnchor,
  type CertifiedBoardStorageAnchor,
} from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-board-anchor';
import { readHashBoundStateRoot } from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-header-hash';
import {
  advanceCertifiedBoardFinality,
  applyCertifiedBoardRegistryEvent,
  getCertifiedBoardStackKey,
  hashCertifiedBoardRecord,
  lookupCertifiedBoardRecord,
} from '../../../../jurisdiction/machine/board-registry';
import {
  buildJHistoryAnchorRoot,
  EMPTY_J_HISTORY_ROOT,
  foldJHistoryRoot,
} from '../../../../jurisdiction/machine/history-consensus';
import type { JurisdictionEvent } from '../../../../types/jurisdiction-events';
import type {
  CertifiedBoardPatriciaNode,
  CertifiedBoardRegistryState,
} from '../../../../types/entity-board-registry';

// History-derived and storage-derived certified-board registries must agree on
// a real EntityProvider: same leaf for every numbered entity and the same root.
const CHAIN_ID = 31_337;
const BOARD_AUTHORITY = 0; // ProposerType.BOARD
const ONE_DAY = 86_400;

const reservePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      server.close(error => (error ? reject(error) : resolve(address.port)));
    });
  });

let anvil: ChildProcess | null = null;
let adapter: JAdapter | null = null;
let provider: ethers.JsonRpcProvider;
let jurisdiction: JurisdictionConfig;

type Fold = {
  state: CertifiedBoardRegistryState | undefined;
  store: Map<string, CertifiedBoardPatriciaNode>;
  events: JurisdictionEvent[];
};

const foldHistory = async (toBlock: number): Promise<Fold> => {
  const jAdapter = adapter!;
  const logs = await provider.getLogs({ address: jAdapter.addresses.entityProvider, fromBlock: 0, toBlock });
  const fold: Fold = { state: undefined, store: new Map(), events: [] };
  for (const log of logs) {
    const raw = decodeJEventLog(log, jAdapter.entityProvider.interface, {
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    }, 'BOARD_ANCHOR_LOG_DECODE');
    if (raw.name !== 'FoundationBootstrapped' && raw.name !== 'EntityRegistered' && raw.name !== 'BoardActivated') continue;
    for (const event of rawEventToJEvents(raw, ethers.ZeroHash)) {
      const applied = applyCertifiedBoardRegistryEvent(fold.state, fold.store, jurisdiction, event);
      for (const [hash, node] of applied.newNodes) fold.store.set(hash, node);
      fold.state = applied.state;
      fold.events.push(event);
    }
  }
  return fold;
};

type StorageAnchor = CertifiedBoardStorageAnchor;

const send = (method: string, params: unknown[]): Promise<unknown> => provider.send(method, params);

const blockStateRoot = async (blockNumber: number): Promise<string> =>
  String(((await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false])) as { stateRoot: string }).stateRoot);

const anchorFromStorage = async (blockNumber: number, entitiesPerProof?: number): Promise<StorageAnchor> =>
  readCertifiedBoardAnchor({
    send,
    jurisdiction,
    blockNumber,
    authenticatedStateRoot: await blockStateRoot(blockNumber),
    ...(entitiesPerProof === undefined ? {} : { entitiesPerProof }),
  });

const assertHistoryEqualsStorage = async (blockNumber: number): Promise<{ fold: Fold; anchor: StorageAnchor }> => {
  const fold = await foldHistory(blockNumber);
  const anchor = await anchorFromStorage(blockNumber);
  expect(anchor.records.size).toBeGreaterThanOrEqual(2);
  for (const [entityId, storageRecord] of anchor.records) {
    const historyRecord = lookupCertifiedBoardRecord(fold.store, fold.state!.boardRegistryRoot, storageRecord.stackKey, entityId);
    expect(historyRecord).toEqual(storageRecord);
    expect(hashCertifiedBoardRecord(historyRecord!)).toBe(hashCertifiedBoardRecord(storageRecord));
  }
  expect(fold.state!.boardRegistryRoot).toBe(anchor.root);
  return { fold, anchor };
};

const mined = async (tx: Promise<ethers.ContractTransactionResponse>): Promise<number> =>
  Number((await (await tx).wait())!.blockNumber);

beforeAll(async () => {
  const port = await reservePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  anvil = spawn('anvil', [
    '--host', '127.0.0.1', '--port', String(port), '--chain-id', String(CHAIN_ID),
    '--block-gas-limit', '60000000', '--silent',
  ], { stdio: 'ignore' });
  provider = createXlnJsonRpcProvider(rpcUrl);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await provider.getBlockNumber();
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await Bun.sleep(50);
    }
  }
  adapter = await createJAdapter({ mode: 'rpc', chainId: CHAIN_ID, rpcUrl });
  await adapter.deployStack();
  jurisdiction = {
    chainId: CHAIN_ID,
    depositoryAddress: adapter.addresses.depository,
    entityProviderAddress: adapter.addresses.entityProvider,
  } as JurisdictionConfig;
}, 60_000);

afterAll(async () => {
  await provider?.destroy();
  anvil?.kill('SIGKILL');
});

test('history fold and eth_getProof storage give the same board leaves and root across A->B->A', async () => {
  const jAdapter = adapter!;
  const ep = jAdapter.entityProvider;
  const signerA = ethers.Wallet.createRandom();
  const signerB = ethers.Wallet.createRandom();
  const boardA = encodeSingleSignerBoard(signerA.address);
  const boardB = encodeSingleSignerBoard(signerB.address);
  const hashA = hashBoard(boardA).toLowerCase();
  const hashB = hashBoard(boardB).toLowerCase();

  const registeredAt = await mined(ep.registerNumberedEntity(boardA));
  const entityId = ethers.toBeHex((await ep.nextNumber()) - 1n, 32).toLowerCase();
  const registered = await assertHistoryEqualsStorage(registeredAt);
  expect(registered.anchor.records.get(entityId)).toMatchObject({ boardHash: hashA, boardEpoch: 0, source: 'EntityRegistered' });

  const rotate = async (nextHash: string, currentSignerKey: string, epoch: bigint, nonce: bigint): Promise<number> => {
    const digest = hashBoardProposalHankoPayload(
      { chainId: CHAIN_ID, entityProviderAddress: jAdapter.addresses.entityProvider, boardEpoch: epoch },
      { entityId, newBoardHash: nextHash, authority: BOARD_AUTHORITY, actionNonce: nonce },
    );
    const hanko = buildSingleSignerHanko(entityId, digest, currentSignerKey);
    await mined(ep.proposeBoard(entityId, nextHash, BOARD_AUTHORITY, [hanko]));
    await provider.send('evm_increaseTime', [ONE_DAY]);
    await provider.send('evm_mine', []);
    return mined(ep.activateBoard(entityId));
  };

  await mined(ep.commitBoard(boardB));
  const toB = await rotate(hashB, signerA.privateKey, 0n, 1n);
  const afterB = await assertHistoryEqualsStorage(toB);
  expect(afterB.anchor.records.get(entityId)).toMatchObject({
    boardHash: hashB, boardEpoch: 1, previousBoardHash: hashA, source: 'BoardActivated',
  });

  const backToA = await rotate(hashA, signerB.privateKey, 1n, 2n);
  const afterA = await assertHistoryEqualsStorage(backToA);
  const finalRecord = afterA.anchor.records.get(entityId)!;
  expect(finalRecord).toMatchObject({ boardHash: hashA, boardEpoch: 2, previousBoardHash: hashB, source: 'BoardActivated' });
  // A->B->A returns to the same board hash but not the same leaf.
  expect(hashCertifiedBoardRecord(finalRecord)).not.toBe(hashCertifiedBoardRecord(registered.anchor.records.get(entityId)!));
  expect(afterA.anchor.root).not.toBe(registered.anchor.root);

  const { fold } = afterA;
  const rootBefore = fold.state!.boardRegistryRoot;
  const activations = fold.events.filter(
    (event): event is Extract<JurisdictionEvent, { type: 'BoardActivated' }> =>
      event.type === 'BoardActivated' && event.data.entityId.toLowerCase() === entityId,
  );
  expect(activations.map(event => event.data.boardEpoch)).toEqual(['1', '2']);

  // Duplicate delivery of the latest activation is a no-op.
  const duplicate = applyCertifiedBoardRegistryEvent(fold.state, fold.store, jurisdiction, activations[1]!);
  expect(duplicate.state.boardRegistryRoot).toBe(rootBefore);
  expect(duplicate.newNodes.size).toBe(0);

  // A stale epoch and an epoch gap are rejected; the root never moves.
  expect(() => applyCertifiedBoardRegistryEvent(fold.state, fold.store, jurisdiction, activations[0]!))
    .toThrow('CERTIFIED_BOARD_ACTIVATION_STALE');
  const gap = { ...activations[1]!, data: { ...activations[1]!.data, boardEpoch: '4' } };
  expect(() => applyCertifiedBoardRegistryEvent(fold.state, fold.store, jurisdiction, gap))
    .toThrow('CERTIFIED_BOARD_ACTIVATION_EPOCH_GAP');
  // Same epoch with a different board is a conflict, not an overwrite.
  const conflict = { ...activations[1]!, data: { ...activations[1]!.data, newBoardHash: hashB } };
  expect(() => applyCertifiedBoardRegistryEvent(fold.state, fold.store, jurisdiction, conflict))
    .toThrow('CERTIFIED_BOARD_ACTIVE_CONFLICT');
  expect(fold.state!.boardRegistryRoot).toBe(rootBefore);
  expect((await anchorFromStorage(backToA)).root).toBe(rootBefore);
  // One entity per eth_getProof gives the same records and root.
  const perEntity = await anchorFromStorage(backToA, 1);
  expect(perEntity.root).toBe(rootBefore);
  expect([...perEntity.records.values()]).toEqual([...afterA.anchor.records.values()]);

  // The anchor is only as good as its stateRoot and contract address.
  const otherRoot = await blockStateRoot(registeredAt);
  await expect(readCertifiedBoardAnchor({ send, jurisdiction, blockNumber: backToA, authenticatedStateRoot: otherRoot }))
    .rejects.toThrow('STATE_PROOF_NODE_HASH_MISMATCH');
  const codeless = { ...jurisdiction, entityProviderAddress: ethers.Wallet.createRandom().address };
  await expect(readCertifiedBoardAnchor({
    send, jurisdiction: codeless, blockNumber: backToA, authenticatedStateRoot: await blockStateRoot(backToA),
  })).rejects.toThrow('BOARD_ANCHOR_CONTRACT_MISSING');

  // Finalized Entity registry vs storage at its own finalized block.
  const tipBlock = (await provider.send('eth_getBlockByNumber', [ethers.toQuantity(backToA), false])) as {
    hash: string; stateRoot: string;
  };
  const finalized = advanceCertifiedBoardFinality(fold.state, jurisdiction, backToA, tipBlock.hash, ethers.ZeroHash);
  const startedAt = performance.now();
  const verified = await assertCertifiedBoardRegistryMatchesAnchor({
    send, jurisdiction, registry: finalized,
    authenticatedBlockHash: tipBlock.hash,
  });
  console.log(`[board-anchor] finalized equality ${verified.records.size} entities ${(performance.now() - startedAt).toFixed(1)}ms`);
  expect(verified.root).toBe(finalized.boardRegistryRoot);
  // The registry must claim the exact authenticated block.
  await expect(assertCertifiedBoardRegistryMatchesAnchor({
    send, jurisdiction, registry: finalized,
    authenticatedBlockHash: (await provider.getBlock(registeredAt))!.hash!,
  })).rejects.toThrow('BOARD_ANCHOR_BLOCK_HASH_MISMATCH');
  // A fold that missed the rotations but claims the tip is caught by storage.
  const lagging = advanceCertifiedBoardFinality(registered.fold.state, jurisdiction, backToA, tipBlock.hash, ethers.ZeroHash);
  await expect(assertCertifiedBoardRegistryMatchesAnchor({
    send, jurisdiction, registry: lagging,
    authenticatedBlockHash: tipBlock.hash,
  })).rejects.toThrow('BOARD_ANCHOR_ROOT_MISMATCH');
  await expect(assertCertifiedBoardRegistryMatchesAnchor({
    send, jurisdiction: codeless, registry: finalized,
    authenticatedBlockHash: tipBlock.hash,
  })).rejects.toThrow('BOARD_ANCHOR_STACK_MISMATCH');
  // An RPC that serves a real but older stateRoot under the unchanged tip hash,
  // stably on every read, is rejected by the header hash, not by a fence.
  const staleRoot = ((await provider.send('eth_getBlockByNumber', [ethers.toQuantity(registeredAt), false])) as {
    stateRoot: string;
  }).stateRoot;
  expect(staleRoot).not.toBe(tipBlock.stateRoot);
  const forgingSend = async (method: string, params: unknown[]): Promise<unknown> => {
    const result = await send(method, params);
    return method === 'eth_getBlockByNumber' ? { ...(result as object), stateRoot: staleRoot } : result;
  };
  await expect(assertCertifiedBoardRegistryMatchesAnchor({
    send: forgingSend, jurisdiction, registry: finalized, authenticatedBlockHash: tipBlock.hash,
  })).rejects.toThrow('STATE_ANCHOR_HEADER_HASH_MISMATCH');

  // Anchor-start history base: two independent hash-bound reads of the same
  // block agree, and every bound field moves the root.
  const jurisdictionRef = getCertifiedBoardStackKey(jurisdiction);
  const boundRoot = await readHashBoundStateRoot(send, backToA, tipBlock.hash);
  expect(boundRoot).toBe(tipBlock.stateRoot.toLowerCase());
  const anchorInput = {
    jurisdictionRef, anchorHeight: backToA, anchorBlockHash: tipBlock.hash,
    stateRoot: boundRoot, provenValuesRoot: verified.root,
  };
  const anchorRoot = buildJHistoryAnchorRoot(anchorInput);
  const independentRoot = buildJHistoryAnchorRoot({
    ...anchorInput,
    stateRoot: await readHashBoundStateRoot(send, backToA, tipBlock.hash),
    provenValuesRoot: perEntity.root,
  });
  expect(independentRoot).toBe(anchorRoot);
  expect(anchorRoot).not.toBe(EMPTY_J_HISTORY_ROOT);
  const mutants = [
    { ...anchorInput, jurisdictionRef: `${jurisdictionRef}:other` },
    { ...anchorInput, anchorHeight: backToA - 1 },
    { ...anchorInput, anchorBlockHash: (await provider.getBlock(registeredAt))!.hash! },
    { ...anchorInput, stateRoot: staleRoot },
    { ...anchorInput, provenValuesRoot: registered.fold.state!.boardRegistryRoot },
  ];
  for (const mutant of mutants) expect(buildJHistoryAnchorRoot(mutant)).not.toBe(anchorRoot);
  expect(() => buildJHistoryAnchorRoot({ ...anchorInput, anchorHeight: 0 }))
    .toThrow('J_HISTORY_INVALID_ANCHOR_HEIGHT');
  expect(() => buildJHistoryAnchorRoot({ ...anchorInput, stateRoot: '0x1234' }))
    .toThrow('J_HISTORY_INVALID_ANCHOR_STATE_ROOT');

  // A later real block folds onto the anchor exactly as onto any certified root.
  await provider.send('evm_mine', []);
  const nextBlock = (await provider.getBlock(backToA + 1))!;
  const nextIdentity = {
    jurisdictionRef, jHeight: backToA + 1, jBlockHash: nextBlock.hash!, eventsHash: ethers.ZeroHash,
  };
  const continued = foldJHistoryRoot(anchorRoot, [nextIdentity]);
  expect(foldJHistoryRoot(independentRoot, [nextIdentity])).toBe(continued);
  expect(continued).not.toBe(anchorRoot);
  expect(foldJHistoryRoot(buildJHistoryAnchorRoot(mutants[4]!), [nextIdentity])).not.toBe(continued);
}, 60_000);
