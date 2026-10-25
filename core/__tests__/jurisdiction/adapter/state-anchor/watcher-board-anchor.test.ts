import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { ethers } from 'ethers';

import { deriveSignerAddressSync, getSignerPrivateKey } from '../../../../account/crypto';
import { encodeSingleSignerBoard, generateLazyEntityId, hashBoard } from '../../../../entity/factory';
import { buildSingleSignerHanko, prepareSignedBatch } from '../../../../hanko/batch';
import { hashBoardProposalHankoPayload, hashCancelEntityProviderActionHankoPayload } from '../../../../hanko/onchain-domain';
import { createJAdapter, createXlnJsonRpcProvider, type JAdapter } from '../../../../jurisdiction/adapter';
import { assertEntityOutDebtsMatchAnchor } from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-debt-anchor';
import { HISTORY_STORAGE_ADDRESS } from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-debt-provenance';
import { readDepositoryAnchorBase } from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-depository-base';
import {
  buildEntityProvenValuesFromFold,
  readEntityProvenValuesFromStorage,
} from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-proven-values-root';
import { assertEntityReservesMatchAnchor } from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-reserve-anchor';
import { createEmptyBatch } from '../../../../jurisdiction/machine/batch';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../../../../jurisdiction/machine/board-registry';
import { safeStringify } from '../../../../protocol/serialization';
import { createEmptyEnv } from '../../../../runtime';
import { attachLiveJAdapter } from '../../../../runtime/j-submit/live-jadapters';
import { createTestEntityImportRuntimeTx } from '../../../../qa/entity-creation-fixture';
import { createJReplica, createJurisdictionConfig } from '../../../../scenarios/harness/boot';
import {
  commitRuntimeInput,
  ensureSignerKeysFromSeed,
  processJEvents,
  setScenarioStorageEnabled,
} from '../../../../scenarios/harness/helpers';
import { startShortfallDispute } from '../../../fixtures/jurisdiction/real-dispute-shortfall';

// The production RPC watcher proves each finalized certified-board registry
// against EntityProvider storage (eth_getProof, header-hash-bound stateRoot)
// during its canonical audit, on a real chain with a signed A->B rotation. The
// same audit proves the Entity's reserves after a signed R2R and its non-empty
// out-debt queue after a real dispute shortfall.
const CHAIN_ID = 31_337;
const RUNTIME_SEED = 'watcher-board-anchor';
const SIGNER_ID = deriveSignerAddressSync(RUNTIME_SEED, '2').toLowerCase();
const CREDITOR_SIGNER_ID = deriveSignerAddressSync(RUNTIME_SEED, '3').toLowerCase();
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
let rpcUrl = '';

beforeAll(async () => {
  const port = await reservePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  anvil = spawn('anvil', [
    '--host', '127.0.0.1', '--port', String(port), '--chain-id', String(CHAIN_ID),
    '--block-gas-limit', '60000000', '--silent',
  ], { stdio: 'ignore' });
  const probe = createXlnJsonRpcProvider(rpcUrl);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await probe.getBlockNumber();
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await Bun.sleep(50);
    }
  }
  await probe.destroy();
  adapter = await createJAdapter({ mode: 'rpc', chainId: CHAIN_ID, rpcUrl, watchPollMs: 100 });
  await adapter.deployStack();
}, 60_000);

afterAll(async () => {
  await adapter?.stopWatchingAndWait();
  await adapter?.close();
  anvil?.kill('SIGKILL');
});

const mined = async (tx: Promise<ethers.ContractTransactionResponse>): Promise<number> =>
  Number((await (await tx).wait())!.blockNumber);

const JURISDICTION_NAME = 'Watcher Board Anchor';

// A runtime that follows the chain through `jAdapter`'s watcher.
const followChain = (jAdapter: JAdapter, signerIndexes: string[]) => {
  const env = createEmptyEnv(RUNTIME_SEED);
  env.scenarioMode = true;
  env.state.timestamp = 1;
  setScenarioStorageEnabled(env, false);
  ensureSignerKeysFromSeed(env, signerIndexes, RUNTIME_SEED);
  const jReplica = createJReplica(env, JURISDICTION_NAME, jAdapter.addresses.depository);
  jReplica.chainId = CHAIN_ID;
  jReplica.watcherConfirmationDepth = 0;
  jReplica.rpcs = [rpcUrl];
  jReplica.contracts = { ...jAdapter.addresses };
  attachLiveJAdapter(env, JURISDICTION_NAME, jAdapter);
  const jurisdiction = createJurisdictionConfig(
    JURISDICTION_NAME,
    jAdapter.addresses.depository,
    jAdapter.addresses.entityProvider,
    rpcUrl,
    CHAIN_ID,
  );
  return { env, jReplica, jurisdiction };
};

// Imports the single-signer lazy Entity of `signerId` and returns its id.
const importEntity = async (
  env: ReturnType<typeof createEmptyEnv>,
  jurisdiction: ReturnType<typeof createJurisdictionConfig>,
  signerId: string,
): Promise<string> => {
  const signerAddress = new ethers.Wallet(ethers.hexlify(getSignerPrivateKey(env, signerId))).address;
  const entityId = generateLazyEntityId([signerAddress], 1n).toLowerCase();
  await commitRuntimeInput(env, {
    runtimeTxs: [
      createTestEntityImportRuntimeTx(env, {
        entityId,
        signerId,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [signerId],
            shares: { [signerId]: 1n },
            jurisdiction,
          },
        },
      }),
    ],
    entityInputs: [],
  });
  return entityId;
};

const replicaState = (env: ReturnType<typeof createEmptyEnv>, entityId: string, signerId: string) => {
  const replica = env.state.eReplicas.get(`${entityId}:${signerId}`);
  if (!replica) throw new Error(`WATCHER_ANCHOR_REPLICA_MISSING:${entityId}:${signerId}`);
  return replica.state;
};

// Runs one poll with process exit and the debug channel captured, as the
// watcher's fail-closed halt reports through both.
const captureFatalPoll = async (env: ReturnType<typeof createEmptyEnv>, poll: () => Promise<void>): Promise<string[]> => {
  const fatal: string[] = [];
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    fatal.push(`exit:${code}`);
  }) as typeof process.exit);
  const infrastructure = env.infrastructure as { p2p?: unknown };
  const previousP2p = infrastructure.p2p;
  if ((previousP2p ?? null) !== null) throw new Error('WATCHER_ANCHOR_P2P_UNEXPECTED');
  infrastructure.p2p = { sendDebugEvent: (payload: unknown) => fatal.push(safeStringify(payload)) };
  try {
    await poll();
  } finally {
    exitSpy.mockRestore();
    infrastructure.p2p = previousP2p;
  }
  return fatal;
};

// Records, without altering, every header batch the watcher sends: a JSON-RPC
// array of eth_getBlockByNumber whose ids are the requested heights.
const observeHeaderBatches = async (run: () => Promise<void>): Promise<number[][]> => {
  const batches: number[][] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    type BatchItem = { method?: unknown; id?: unknown; params?: unknown[] } | null;
    const parsed: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const body: BatchItem[] = Array.isArray(parsed) ? parsed as BatchItem[] : [];
    if (body.length > 0 && body.every(item =>
      item?.method === 'eth_getBlockByNumber' && item.id === Number(item.params?.[0]))) {
      batches.push(body.map(item => Number(item?.id)));
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return batches;
};

test('watcher canonical audit proves the finalized registry against storage and halts on a forged root', async () => {
  const jAdapter = adapter!;
  const ep = jAdapter.entityProvider;
  const provider = jAdapter.provider as ethers.JsonRpcProvider;

  // Observe, never alter, the watcher's state-proof reads.
  const proofCalls: Array<{ address: string; blockNumber: number; ms: number }> = [];
  const sequentialCalls = new Map<string, number>();
  const originalSend = provider.send.bind(provider);
  provider.send = async (method: string, params: unknown[] | Record<string, unknown>) => {
    sequentialCalls.set(method, (sequentialCalls.get(method) ?? 0) + 1);
    if (method !== 'eth_getProof') return originalSend(method, params);
    const startedAt = performance.now();
    const result = await originalSend(method, params);
    proofCalls.push({
      address: String((params as unknown[])[0]).toLowerCase(),
      blockNumber: Number((params as unknown[])[2]),
      ms: performance.now() - startedAt,
    });
    return result;
  };

  // A numbered entity rotates A->B with its own signed BOARD Hanko.
  const signerA = ethers.Wallet.createRandom();
  const signerB = ethers.Wallet.createRandom();
  const boardA = encodeSingleSignerBoard(signerA.address);
  const boardB = encodeSingleSignerBoard(signerB.address);
  const hashB = hashBoard(boardB).toLowerCase();
  await mined(ep.registerNumberedEntity(boardA));
  const rotatedEntityId = ethers.toBeHex((await ep.nextNumber()) - 1n, 32).toLowerCase();
  await mined(ep.commitBoard(boardB));
  const digest = hashBoardProposalHankoPayload(
    { chainId: CHAIN_ID, entityProviderAddress: jAdapter.addresses.entityProvider, boardEpoch: 0n },
    { entityId: rotatedEntityId, newBoardHash: hashB, authority: BOARD_AUTHORITY, actionNonce: 1n },
  );
  await mined(ep.proposeBoard(rotatedEntityId, hashB, BOARD_AUTHORITY, [
    buildSingleSignerHanko(rotatedEntityId, digest, signerA.privateKey),
  ]));
  await provider.send('evm_increaseTime', [ONE_DAY]);
  await provider.send('evm_mine', []);
  const rotatedAt = await mined(ep.activateBoard(rotatedEntityId));

  // A runtime with one imported Entity follows the chain through the watcher.
  const { env, jReplica, jurisdiction } = followChain(jAdapter, ['2', '3']);
  jAdapter.startWatching(env);
  const entityId = await importEntity(env, jurisdiction, SIGNER_ID);
  await processJEvents(env);
  const replica = env.state.eReplicas.get(`${entityId}:${SIGNER_ID}`);
  if (!replica) throw new Error('WATCHER_BOARD_ANCHOR_REPLICA_MISSING');
  const registry = () => replica.state.certifiedBoardState!;
  expect(registry().finalizedJHeight).toBeGreaterThanOrEqual(rotatedAt);
  expect(resolveObserverCertifiedBoardHash(replica.state, getCertifiedBoardNodeStore(env), rotatedEntityId)).toBe(hashB);

  // A new head makes the canonical audit due; the finalized registry is proven.
  const auditedHeight = registry().finalizedJHeight;
  const auditedRoot = registry().boardRegistryRoot;
  const headerBatches = await observeHeaderBatches(async () => {
    await provider.send('evm_mine', []);
    await processJEvents(env);
  });
  // The audit reads the head (authority check) and its local audit heights in
  // one header batch; the audited height is not read again in this poll.
  const auditHead = await provider.getBlockNumber();
  const auditBatches = headerBatches.filter(heights => heights.includes(auditedHeight));
  expect(auditBatches).toHaveLength(1);
  expect(auditBatches[0]).toContain(auditHead);
  const proven = proofCalls.filter(call => call.blockNumber === auditedHeight);
  expect(proven.length).toBeGreaterThan(0);
  console.log(`[watcher-board-anchor] audit height=${auditedHeight} getProof=${proven.length} ` +
    `ms=${proven.map(call => call.ms.toFixed(1)).join(',')} total=${proofCalls.length}`);

  // An unchanged registry is not re-proven on the next audit.
  const beforeIdleAudit = proofCalls.length;
  const unchangedKey = `${registry().finalizedJHeight}:${registry().boardRegistryRoot}`;
  await provider.send('evm_mine', []);
  await processJEvents(env);
  const reproven = proofCalls.slice(beforeIdleAudit);
  console.log(`[watcher-board-anchor] next audit key=${unchangedKey} newGetProof=${reproven.length} ` +
    `heights=${reproven.map(call => call.blockNumber).join(',')}`);
  for (const call of reproven) expect(call.blockNumber).not.toBe(auditedHeight);

  // E1: reserves minted and moved by the Entity's own signed R2R (one token
  // fully drained) are finalized by the watcher fold and proven equal to
  // Depository storage on the next audit.
  const payee = ethers.hexlify(ethers.randomBytes(32)).toLowerCase();
  await jAdapter.debugFundReserves(entityId, 1, 1_000n);
  await jAdapter.debugFundReserves(entityId, 2, 500n);
  const r2r = createEmptyBatch();
  r2r.reserveToReserve.push({ receivingEntity: payee, tokenId: 1, amount: 300n });
  r2r.reserveToReserve.push({ receivingEntity: payee, tokenId: 2, amount: 500n });
  const signedR2r = prepareSignedBatch(
    r2r, entityId, ethers.hexlify(getSignerPrivateKey(env, SIGNER_ID)), BigInt(CHAIN_ID), jAdapter.addresses.depository, 0n,
  );
  await jAdapter.processBatch(signedR2r.encodedBatch, signedR2r.hankoData, signedR2r.nextNonce);
  const movedAt = Number(await provider.getBlockNumber());
  const liveState = () => env.state.eReplicas.get(`${entityId}:${SIGNER_ID}`)!.state;
  for (let attempt = 0; attempt < 10 && Number(liveState().lastFinalizedJHeight) < movedAt; attempt += 1) {
    await provider.send('evm_mine', []);
    await processJEvents(env);
  }
  expect(Number(liveState().lastFinalizedJHeight)).toBeGreaterThanOrEqual(movedAt);
  expect(liveState().reserves.get(1)).toBe(700n);
  expect(liveState().reserves.get(2)).toBe(0n);
  const reserveHeight = Number(liveState().lastFinalizedJHeight);
  const beforeReserveAudit = proofCalls.length;
  await provider.send('evm_mine', []);
  await processJEvents(env);
  const reserveProofs = proofCalls.slice(beforeReserveAudit).filter(call => call.blockNumber === reserveHeight);
  const depository = jAdapter.addresses.depository.toLowerCase();
  const reserveProofsAll = proofCalls.filter(call => call.blockNumber === reserveHeight && call.address === depository);
  console.log(`[watcher-reserve-anchor] audit height=${reserveHeight} getProof=${reserveProofsAll.length} ` +
    `ms=${reserveProofsAll.map(call => call.ms.toFixed(1)).join(',')} lateGetProof=${reserveProofs.length}`);
  // One shared Depository._tokens.length proof for the audit height, then one
  // reserve chunk and one out-debt queue-head proof; empty queues need no entry pass.
  expect(reserveProofsAll.length).toBe(3);
  expect(jAdapter.isWatching()).toBe(true);

  // The same finalized block with a stale pre-R2R balance is refused.
  const reserveHash = (await provider.getBlock(reserveHeight))!.hash!;
  const provenReserves = await assertEntityReservesMatchAnchor({
    send: (method, params) => originalSend(method, params),
    jurisdiction: { depositoryAddress: jAdapter.addresses.depository },
    blockNumber: reserveHeight,
    authenticatedBlockHash: reserveHash,
    entities: [{ entityId, reserves: liveState().reserves }],
  });
  expect(provenReserves.reserves.get(entityId)).toEqual(new Map([[1, 700n]]));
  await expect(assertEntityReservesMatchAnchor({
    send: (method, params) => originalSend(method, params),
    jurisdiction: { depositoryAddress: jAdapter.addresses.depository },
    blockNumber: reserveHeight,
    authenticatedBlockHash: reserveHash,
    entities: [{ entityId, reserves: new Map([[1, 1_000n], [2, 500n]]) }],
  })).rejects.toThrow('RESERVE_ANCHOR_MISMATCH');
  // A shared base proven at another block cannot stand in for this one.
  const otherBlock = (await provider.getBlock(reserveHeight - 1))!;
  const otherBase = await readDepositoryAnchorBase({
    send: (method, params) => originalSend(method, params),
    depositoryAddress: jAdapter.addresses.depository,
    blockNumber: otherBlock.number,
    authenticatedBlockHash: otherBlock.hash!,
    fail: (code, detail = '') => { throw new Error(`TEST_BASE_${code}:${detail}`); },
  });
  await expect(assertEntityReservesMatchAnchor({
    send: (method, params) => originalSend(method, params),
    jurisdiction: { depositoryAddress: jAdapter.addresses.depository },
    blockNumber: reserveHeight,
    authenticatedBlockHash: reserveHash,
    base: otherBase,
    entities: [{ entityId, reserves: liveState().reserves }],
  })).rejects.toThrow('RESERVE_ANCHOR_BASE_MISMATCH');

  // D2: a real dispute shortfall makes the imported Entity a debtor of a second
  // imported Entity. Its 700 token-1 reserve goes to the creditor and 300 is
  // booked as debt; the watcher folds DebtCreated into both ledgers and the next
  // audit proves the non-empty queue and the creditor's in-count in-runtime.
  const creditorId = await importEntity(env, jurisdiction, CREDITOR_SIGNER_ID);
  expect(creditorId > entityId).toBe(true);
  await processJEvents(env);
  const creditorState = () => replicaState(env, creditorId, CREDITOR_SIGNER_ID);
  expect(creditorState().inDebtsByToken).toBeUndefined();
  const finalizeShortfall = await startShortfallDispute(
    jAdapter,
    CHAIN_ID,
    { wallet: { privateKey: ethers.hexlify(getSignerPrivateKey(env, SIGNER_ID)) }, entityId },
    { wallet: { privateKey: ethers.hexlify(getSignerPrivateKey(env, CREDITOR_SIGNER_ID)) }, entityId: creditorId },
    -1_000n,
    'd2',
  );
  await provider.send('evm_increaseTime', [120]);
  await provider.send('evm_mine', []);
  await finalizeShortfall();
  const debtAt = Number(await provider.getBlockNumber());
  const debtFinalized = () => Math.min(Number(liveState().lastFinalizedJHeight), Number(creditorState().lastFinalizedJHeight));
  for (let attempt = 0; attempt < 10 && debtFinalized() < debtAt; attempt += 1) {
    await provider.send('evm_mine', []);
    await processJEvents(env);
  }
  expect(debtFinalized()).toBeGreaterThanOrEqual(debtAt);
  expect(liveState().reserves.get(1)).toBe(0n);
  expect([...(liveState().outDebtsByToken?.get(1)?.values() ?? [])].map(entry => [entry.creditor, entry.remainingAmount, entry.createdDebtIndex]))
    .toEqual([[creditorId, 300n, 0]]);
  // The watcher delivered the same DebtCreated to the creditor side.
  const creditorInDebts = () => [...(creditorState().inDebtsByToken?.get(1)?.values() ?? [])]
    .map(entry => [entry.direction, entry.debtor, entry.creditor, entry.remainingAmount, entry.createdDebtIndex]);
  expect(creditorInDebts()).toEqual([['in', entityId, creditorId, 300n, 0]]);
  expect(creditorState().outDebtsByToken).toBeUndefined();
  const debtHeight = Number(liveState().lastFinalizedJHeight);
  await provider.send('evm_mine', []);
  await processJEvents(env);
  // The watcher's own per-Entity proven-values roots from this audit.
  const watcherProven = jAdapter.getWatcherProvenValues?.() ?? [];
  const debtProofs = proofCalls.filter(call => call.blockNumber === debtHeight && call.address === depository);
  console.log(`[watcher-debt-anchor] audit height=${debtHeight} getProof=${debtProofs.length} ` +
    `ms=${debtProofs.map(call => call.ms.toFixed(1)).join(',')}`);
  // One shared _tokens.length proof, one reserve chunk, then one out-debt
  // queue-head proof and one entry pass for the open queue.
  expect(debtProofs.length).toBe(4);
  // The same audit linked the open debt's creation block to its certified
  // anchor through the EIP-2935 history slot and proved its creation receipt.
  const historyProofs = proofCalls.filter(call => call.address === HISTORY_STORAGE_ADDRESS.toLowerCase());
  expect(historyProofs.length).toBeGreaterThanOrEqual(1);
  expect(historyProofs.every(call => call.blockNumber > debtAt - 1)).toBe(true);
  // The creation proof ran, and read the block's raw transactions through the
  // authenticated batch transport rather than one provider round trip each.
  expect(sequentialCalls.get('eth_getBlockTransactionCountByHash') ?? 0).toBeGreaterThanOrEqual(1);
  expect(sequentialCalls.get('eth_getRawTransactionByBlockHashAndIndex') ?? 0).toBe(0);
  expect(jAdapter.isWatching()).toBe(true);

  // The same finalized block proves the live ledger and refuses one without the debt.
  const debtBlock = await provider.getBlock(debtHeight);
  if (!debtBlock?.hash) throw new Error('WATCHER_DEBT_ANCHOR_BLOCK_MISSING');
  const debtCommon = {
    send: (method: string, params: unknown[]) => originalSend(method, params),
    jurisdiction: { depositoryAddress: jAdapter.addresses.depository },
    blockNumber: debtHeight,
    authenticatedBlockHash: debtBlock.hash,
  };
  const provenDebts = await assertEntityOutDebtsMatchAnchor({ ...debtCommon, entities: [{ entityId, outDebtsByToken: liveState().outDebtsByToken }] });
  expect(provenDebts.debtors.get(entityId)?.byToken.get(1))
    .toEqual({ cursor: 0n, length: 1n, outstanding: 300n, entries: [{ index: 0, creditor: creditorId, amount: 300n }] });
  await expect(assertEntityOutDebtsMatchAnchor({ ...debtCommon, entities: [{ entityId, outDebtsByToken: undefined }] }))
    .rejects.toThrow('DEBT_ANCHOR_MISMATCH');
  // The creditor's open in-entries match inActiveDebts; a ledger without them does not.
  const creditorLedgers = { entityId: creditorId, outDebtsByToken: creditorState().outDebtsByToken };
  const provenCredits = await assertEntityOutDebtsMatchAnchor({
    ...debtCommon,
    entities: [{ ...creditorLedgers, inDebtsByToken: creditorState().inDebtsByToken }],
  });
  expect(provenCredits.debtors.get(creditorId)?.inActiveDebts).toBe(1n);
  expect(provenCredits.debtors.get(creditorId)?.activeDebts).toBe(0n);
  await expect(assertEntityOutDebtsMatchAnchor({ ...debtCommon, entities: [{ ...creditorLedgers, inDebtsByToken: undefined }] }))
    .rejects.toThrow('DEBT_ANCHOR_IN_ACTIVE_COUNT_MISMATCH');
  // Count-equal in-ledgers whose single entry is not the debtor's stored one.
  const genuineCredit = [...(creditorState().inDebtsByToken?.get(1)?.values() ?? [])];
  expect(genuineCredit.length).toBe(1);
  const forgedCredits = (patch: Partial<(typeof genuineCredit)[number]>) =>
    new Map([[1, new Map(genuineCredit.map(entry => [entry.debtId, { ...entry, ...patch }]))]]);
  for (const patch of [{ remainingAmount: 299n }, { createdDebtIndex: 1 }, { createdSeq: genuineCredit[0]?.createdSeq === 1n ? 2n : 1n }]) {
    await expect(assertEntityOutDebtsMatchAnchor({ ...debtCommon, entities: [{ ...creditorLedgers, inDebtsByToken: forgedCredits(patch) }] }))
      .rejects.toThrow('DEBT_ANCHOR_IN_ENTRY_MISMATCH');
  }

  // One proven-values root per Entity over B1+E1+D+nonces at its own certified
  // block: the fold side equals the storage-only side; dropping any component
  // moves it. The debtor's signed R2R advanced its Depository batch nonce.
  expect(liveState().jBatchState?.entityNonce ?? 0).toBeGreaterThan(0);
  const anchorJurisdiction = {
    chainId: CHAIN_ID,
    depositoryAddress: jAdapter.addresses.depository,
    entityProviderAddress: jAdapter.addresses.entityProvider,
  };
  const provenSides = [
    { id: entityId, state: liveState(), inDebtors: [] as string[] },
    { id: creditorId, state: creditorState(), inDebtors: [entityId] },
  ];
  for (const { id, state, inDebtors } of provenSides) {
    const registryAt = state.certifiedBoardState;
    if (!registryAt) throw new Error('WATCHER_PROVEN_VALUES_REGISTRY_MISSING');
    const anchorHash = (await provider.getBlock(registryAt.finalizedJHeight))?.hash;
    if (!anchorHash) throw new Error('WATCHER_PROVEN_VALUES_BLOCK_MISSING');
    expect(anchorHash.toLowerCase()).toBe(registryAt.finalizedJBlockHash.toLowerCase());
    const storageSide = await readEntityProvenValuesFromStorage({
      send: (method, params) => originalSend(method, params),
      jurisdiction: anchorJurisdiction,
      entityId: id,
      blockNumber: registryAt.finalizedJHeight,
      authenticatedBlockHash: anchorHash,
      inDebtorIds: inDebtors,
    });
    const foldSide = buildEntityProvenValuesFromFold(state, anchorJurisdiction, storageSide.tokenCount);
    expect(foldSide).toEqual(storageSide.values);
    const mutants = [
      { ...state, certifiedBoardState: { ...registryAt, boardRegistryRoot: ethers.keccak256(ethers.toUtf8Bytes('forged-registry')) } },
      { ...state, reserves: new Map([[1, 1n]]) },
      { ...state, outDebtsByToken: new Map(), inDebtsByToken: new Map() },
      // A stale batch nonce, and an action nonce the chain never confirmed.
      ...(state.jBatchState ? [{ ...state, jBatchState: { ...state.jBatchState, entityNonce: state.jBatchState.entityNonce - 1 } }] : []),
      {
        ...state,
        entityProviderActionState: {
          version: 1 as const,
          confirmedNonce: (state.entityProviderActionState?.confirmedNonce ?? 0n) + 1n,
          generation: state.entityProviderActionState?.generation ?? 0,
        },
      },
    ];
    for (const mutant of mutants) {
      expect(buildEntityProvenValuesFromFold(mutant, anchorJurisdiction, storageSide.tokenCount).root).not.toBe(storageSide.values.root);
    }
  }
  // Without the fold's debtor hint the storage side cannot enumerate the
  // creditor's in-debt; inActiveDebts stays in the root, so it cannot match.
  const creditorAt = creditorState().certifiedBoardState;
  if (!creditorAt) throw new Error('WATCHER_PROVEN_VALUES_REGISTRY_MISSING');
  const unhinted = await readEntityProvenValuesFromStorage({
    send: (method, params) => originalSend(method, params),
    jurisdiction: anchorJurisdiction,
    entityId: creditorId,
    blockNumber: creditorAt.finalizedJHeight,
    authenticatedBlockHash: creditorAt.finalizedJBlockHash,
    inDebtorIds: [],
  });
  expect(unhinted.values.root).not.toBe(buildEntityProvenValuesFromFold(creditorState(), anchorJurisdiction, unhinted.tokenCount).root);

  // In-runtime: the canonical audit built each Entity's root from the proofs it
  // already read (debtHeight stays at 4 proofs) and checked fold == storage.
  // Every root it reported after the debt equals an independent storage read.
  const reported = watcherProven.map(values => ({ id: values.entityId, height: values.blockNumber, root: values.root }));
  expect(reported.some(entry => entry.id === entityId.toLowerCase() && entry.height === debtHeight)).toBe(true);
  expect(reported.some(entry => entry.id === creditorId.toLowerCase() && entry.height >= debtAt)).toBe(true);
  for (const entry of reported) {
    const block = await provider.getBlock(entry.height);
    if (!block?.hash) throw new Error('WATCHER_PROVEN_VALUES_BLOCK_MISSING');
    const independent = await readEntityProvenValuesFromStorage({
      send: (method, params) => originalSend(method, params),
      jurisdiction: anchorJurisdiction,
      entityId: entry.id,
      blockNumber: entry.height,
      authenticatedBlockHash: block.hash,
      inDebtorIds: entry.id === creditorId.toLowerCase() ? [entityId] : [],
    });
    expect(entry.root).toBe(independent.values.root);
  }

  // A real signed EntityProvider action on the imported wallet Entity: an
  // external cancel advances entityActionNonces to 1. The fold confirms it and
  // the watcher's proven root (own slot-5 audit) equals an independent read.
  expect(liveState().entityProviderActionState?.confirmedNonce ?? 0n).toBe(0n);
  const cancelledActionHash = ethers.keccak256(ethers.toUtf8Bytes('nonce-anchor-external-cancel'));
  const cancelDigest = hashCancelEntityProviderActionHankoPayload(
    { chainId: CHAIN_ID, entityProviderAddress: jAdapter.addresses.entityProvider, boardEpoch: 0n },
    { entityNumber: BigInt(entityId), actionNonce: 1n, cancelledActionHash, cancelledActionKind: 0 },
  );
  const cancelledAt = await mined(ep.cancelEntityProviderAction(BigInt(entityId), cancelledActionHash, 0, buildSingleSignerHanko(
    entityId, cancelDigest, ethers.hexlify(getSignerPrivateKey(env, SIGNER_ID)),
  )));
  for (let attempt = 0; attempt < 10 && Number(liveState().lastFinalizedJHeight) < cancelledAt; attempt += 1) {
    await provider.send('evm_mine', []);
    await processJEvents(env);
  }
  expect(Number(liveState().lastFinalizedJHeight)).toBeGreaterThanOrEqual(cancelledAt);
  expect(liveState().entityProviderActionState?.confirmedNonce).toBe(1n);
  await provider.send('evm_mine', []);
  await processJEvents(env);
  const actionProven = (jAdapter.getWatcherProvenValues?.() ?? []).find(values => values.entityId === entityId.toLowerCase());
  if (!actionProven) throw new Error('WATCHER_PROVEN_VALUES_ACTION_MISSING');
  expect(actionProven.blockNumber).toBeGreaterThanOrEqual(cancelledAt);
  const actionBlock = await provider.getBlock(actionProven.blockNumber);
  if (!actionBlock?.hash) throw new Error('WATCHER_PROVEN_VALUES_BLOCK_MISSING');
  const actionStorage = await readEntityProvenValuesFromStorage({
    send: (method, params) => originalSend(method, params),
    jurisdiction: anchorJurisdiction,
    entityId,
    blockNumber: actionProven.blockNumber,
    authenticatedBlockHash: actionBlock.hash,
    inDebtorIds: [],
  });
  expect(actionProven.root).toBe(actionStorage.values.root);
  expect(buildEntityProvenValuesFromFold(liveState(), anchorJurisdiction, actionStorage.tokenCount).root).toBe(actionStorage.values.root);
  expect(buildEntityProvenValuesFromFold(
    { ...liveState(), entityProviderActionState: { version: 1 as const, confirmedNonce: 0n, generation: 0 } },
    anchorJurisdiction,
    actionStorage.tokenCount,
  ).root).not.toBe(actionStorage.values.root);
  expect(jAdapter.isWatching()).toBe(true);

  // A forged finalized root halts the watcher fail-closed before admission.
  const fatal: string[] = [];
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    fatal.push(`exit:${code}`);
  }) as typeof process.exit);
  const infrastructure = env.infrastructure as { p2p?: unknown };
  const previousP2p = infrastructure.p2p;
  expect(previousP2p ?? null).toBeNull();
  infrastructure.p2p = { sendDebugEvent: (payload: unknown) => fatal.push(safeStringify(payload)) };
  const forgedRoot = ethers.keccak256(ethers.toUtf8Bytes('forged-board-registry-root'));
  // Entity frames since the import replaced the state object; forge the live one.
  const forgedState = liveState();
  const genuine = forgedState.certifiedBoardState!;
  forgedState.certifiedBoardState = { ...genuine, boardRegistryRoot: forgedRoot };
  try {
    await provider.send('evm_mine', []);
    await jAdapter.pollNow!();
  } finally {
    forgedState.certifiedBoardState = genuine;
    exitSpy.mockRestore();
    infrastructure.p2p = previousP2p;
  }
  expect(fatal).toContain('exit:1');
  expect(fatal.join('\n')).toContain('BOARD_ANCHOR_ROOT_MISMATCH');
  expect(jAdapter.isWatching()).toBe(false);
  expect(auditedRoot).not.toBe(forgedRoot);

  // A second runtime cold-imports only the creditor through its own watcher on
  // the same stack: history delivers the creditor-side DebtCreated and the audit
  // proves the in-count and the entry's creation. A halted watcher stays halted,
  // so each forged ledger gets its own cold runtime.
  const coldCreditorHalt = async (forge: (state: ReturnType<typeof replicaState>) => () => void): Promise<string> => {
    const coldAdapter = await createJAdapter({
      mode: 'rpc',
      chainId: CHAIN_ID,
      rpcUrl,
      watchPollMs: 100,
      fromReplica: { ...jReplica, entityProviderDeploymentBlock: jAdapter.entityProviderDeploymentBlock },
    });
    try {
      const cold = followChain(coldAdapter, ['3']);
      coldAdapter.startWatching(cold.env);
      expect(await importEntity(cold.env, cold.jurisdiction, CREDITOR_SIGNER_ID)).toBe(creditorId);
      await processJEvents(cold.env);
      const coldState = () => replicaState(cold.env, creditorId, CREDITOR_SIGNER_ID);
      expect(Number(coldState().lastFinalizedJHeight)).toBeGreaterThanOrEqual(debtAt);
      expect([...(coldState().inDebtsByToken?.get(1)?.values() ?? [])]
        .map(entry => [entry.direction, entry.debtor, entry.creditor, entry.remainingAmount, entry.createdDebtIndex]))
        .toEqual([['in', entityId, creditorId, 300n, 0]]);
      await provider.send('evm_mine', []);
      await processJEvents(cold.env);
      expect(coldAdapter.isWatching()).toBe(true);
      const restore = forge(coldState());
      const coldFatal = await captureFatalPoll(cold.env, async () => {
        if (!coldAdapter.pollNow) throw new Error('WATCHER_ANCHOR_POLL_NOW_MISSING');
        await provider.send('evm_mine', []);
        await coldAdapter.pollNow();
      }).finally(restore);
      expect(coldFatal).toContain('exit:1');
      expect(coldAdapter.isWatching()).toBe(false);
      return coldFatal.join('\n');
    } finally {
      await coldAdapter.stopWatchingAndWait();
      await coldAdapter.close();
    }
  };
  // A ledger that dropped the in-entry halts it.
  expect(await coldCreditorHalt(state => {
    const genuineIn = state.inDebtsByToken;
    if (!genuineIn) throw new Error('WATCHER_ANCHOR_IN_LEDGER_MISSING');
    delete state.inDebtsByToken;
    return () => { state.inDebtsByToken = genuineIn; };
  })).toContain('DEBT_ANCHOR_IN_ACTIVE_COUNT_MISMATCH');
  // An in-entry naming another creation transaction keeps every storage word,
  // so only the creation proof under the anchored header can refuse it.
  expect(await coldCreditorHalt(state => {
    const bucket = state.inDebtsByToken?.get(1);
    const [debtId, genuine] = [...(bucket?.entries() ?? [])][0] ?? [];
    if (!bucket || !debtId || !genuine) throw new Error('WATCHER_ANCHOR_IN_ENTRY_MISSING');
    bucket.set(debtId, { ...genuine, createdTxHash: ethers.keccak256(ethers.toUtf8Bytes('forged-created-tx')) });
    return () => { bucket.set(debtId, genuine); };
  })).toContain('DEBT_PROVENANCE_TRANSACTION_NOT_IN_BLOCK');
  provider.send = originalSend;
}, 60_000);
