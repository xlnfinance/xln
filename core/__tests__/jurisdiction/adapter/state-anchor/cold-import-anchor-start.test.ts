import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { ethers } from 'ethers';

import { deriveSignerAddressSync, getSignerPrivateKey } from '../../../../account/crypto';
import { generateLazyEntityId } from '../../../../entity/factory';
import type { EntityRuntimeContext } from '../../../../entity/runtime-context';
import { applyJAnchor, buildJAnchorTx, getJAnchorLocalRefusal } from '../../../../entity/tx/j-anchor/j-anchor-finality';
import { seedReplicaJHistoryFromCommittedAnchor } from '../../../../entity/consensus/j-prefix/prefix-round';
import { selectProposableEntityTxs } from '../../../../entity/consensus/proposal/policy';
import { selectEntityProposal } from '../../../../entity/consensus/proposal/selection';
import type { EntityReplica, EntityState } from '../../../../entity/types';
import type { EntityTx } from '../../../../types/entity-tx';
import { createJAdapter, createXlnJsonRpcProvider, type JAdapter } from '../../../../jurisdiction/adapter';
import {
  buildEntityProvenValuesFromFold,
  readJHistoryAnchorStartFromStorage,
} from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-proven-values-root';
import { getJHistoryRegistrationBaseHeight } from '../../../../jurisdiction/machine/history-consensus';
import { getLocalJPrefixAttestableHeight } from '../../../../jurisdiction/machine/history/j-prefix-consensus';
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
import { startShortfallDispute, type DisputeParty } from '../../../fixtures/jurisdiction/real-dispute-shortfall';

// Producer side of the anchor start on a real chain: a wallet Entity folded
// from full history and an anchor start read only from storage proven under the
// hash-bound header of the SAME block must admit to the same proven values.
const CHAIN_ID = 31_337;
const RUNTIME_SEED = 'cold-import-anchor-start';
const JURISDICTION_NAME = 'Cold Import Anchor Start';

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

test('an anchor start proven from storage admits the same values the history fold reaches', async () => {
  const jAdapter = adapter!;
  const provider = jAdapter.provider as ethers.JsonRpcProvider;
  const jurisdiction = createJurisdictionConfig(
    JURISDICTION_NAME,
    jAdapter.addresses.depository,
    jAdapter.addresses.entityProvider,
    rpcUrl,
    CHAIN_ID,
  );
  const signerId = deriveSignerAddressSync(RUNTIME_SEED, '2').toLowerCase();
  const env = createEmptyEnv(RUNTIME_SEED);
  env.scenarioMode = true;
  env.state.timestamp = 1;
  setScenarioStorageEnabled(env, false);
  ensureSignerKeysFromSeed(env, ['2'], RUNTIME_SEED);
  const privateKey = ethers.hexlify(getSignerPrivateKey(env, signerId));
  const entityId = generateLazyEntityId([new ethers.Wallet(privateKey).address], 1n).toLowerCase();
  await jAdapter.debugFundReserves(entityId, 1, 1_000n);

  // History side: the unchanged full cold import.
  const jReplica = createJReplica(env, JURISDICTION_NAME, jAdapter.addresses.depository);
  jReplica.chainId = CHAIN_ID;
  jReplica.watcherConfirmationDepth = 0;
  jReplica.rpcs = [rpcUrl];
  jReplica.contracts = { ...jAdapter.addresses };
  const coldAdapter = await createJAdapter({
    mode: 'rpc',
    chainId: CHAIN_ID,
    rpcUrl,
    watchPollMs: 100,
    fromReplica: { ...jReplica, entityProviderDeploymentBlock: jAdapter.entityProviderDeploymentBlock },
  });
  attachLiveJAdapter(env, JURISDICTION_NAME, coldAdapter);
  const tip = await provider.getBlockNumber();
  coldAdapter.startWatching(env);
  const state = (): EntityState => {
    const replica = env.state.eReplicas.get(`${entityId}:${signerId}`);
    if (!replica) throw new Error(`ANCHOR_START_REPLICA_MISSING:${entityId}`);
    return replica.state;
  };
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
  for (let attempt = 0; attempt < 40 && Number(state().lastFinalizedJHeight) < tip; attempt += 1) {
    await Bun.sleep(100);
    await processJEvents(env);
  }
  await coldAdapter.stopWatchingAndWait();
  await coldAdapter.close();
  const folded = state();
  expect(folded.reserves.get(1)).toBe(1_000n);
  const registry = folded.certifiedBoardState;
  if (!registry) throw new Error('ANCHOR_START_REGISTRY_MISSING');
  const anchorHeight = registry.finalizedJHeight;
  expect(anchorHeight).toBeGreaterThanOrEqual(tip);
  const block = await provider.getBlock(anchorHeight);
  if (!block?.hash) throw new Error('ANCHOR_START_BLOCK_MISSING');
  expect(block.hash.toLowerCase()).toBe(registry.finalizedJBlockHash.toLowerCase());

  // Anchor side: storage only, under the header that hashes to that block.
  const foldJurisdiction = folded.config.jurisdiction;
  if (!foldJurisdiction) throw new Error('ANCHOR_START_JURISDICTION_MISSING');
  const start = await readJHistoryAnchorStartFromStorage({
    send: (method, params) => provider.send(method, params),
    jurisdiction: foldJurisdiction,
    entityId,
    blockNumber: anchorHeight,
    authenticatedBlockHash: block.hash,
  });
  if (start.kind !== 'anchor') throw new Error(`ANCHOR_START_FELL_BACK:${start.reason}`);
  expect(start.header.anchorBlockHash).toBe(block.hash.toLowerCase());
  expect(start.header.stateRoot).toBe(String(block.stateRoot).toLowerCase());

  // The same Entity before any J finality, admitted through the handler.
  const genesis = {
    ...folded,
    jHistoryFinality: undefined,
    lastFinalizedJHeight: getJHistoryRegistrationBaseHeight(foldJurisdiction),
    reserves: new Map(),
    certifiedBoardState: undefined,
    // As imported: no EntityProvider action has been confirmed or intended.
    entityProviderActionState: undefined,
  } as EntityState;
  const context = { quietRuntimeLogs: true, runtimeSeed: env.runtimeSeed } as EntityRuntimeContext;
  const tx = buildJAnchorTx(context, genesis, signerId, start.header, start.values);
  const admitted = applyJAnchor(genesis, tx.data, context);

  const tokenCount = start.values.tokenCount;
  expect(buildEntityProvenValuesFromFold(admitted, foldJurisdiction, tokenCount))
    .toEqual(buildEntityProvenValuesFromFold(folded, foldJurisdiction, tokenCount));
  expect(admitted.reserves).toEqual(folded.reserves);
  expect(admitted.certifiedBoardState?.boardRegistryRoot).toBe(registry.boardRegistryRoot);
  // Same representation, not only the same root: an unadvanced nonce stays absent.
  expect(admitted.entityProviderActionState).toEqual(folded.entityProviderActionState);
  expect(admitted.jBatchState).toEqual(folded.jBatchState);
  expect(admitted.lastFinalizedJHeight).toBe(anchorHeight);
  expect(admitted.jHistoryFinality?.tipBlockHash).toBe(block.hash.toLowerCase());

  // Finality requires a J-prefix vote, built only from validator-local history.
  // A frame without 'j_anchor' implies none; the committed anchor implies the
  // history a scan through it leaves, so the next frame need not wait for a page.
  const replica = { entityId, signerId, state: admitted } as EntityReplica;
  seedReplicaJHistoryFromCommittedAnchor(replica, [{ type: 'r2r', data: { toEntityId: entityId, tokenId: 1, amount: 1n } }]);
  expect(replica.jHistory).toBeUndefined();
  seedReplicaJHistoryFromCommittedAnchor(replica, [tx]);
  const seeded = replica.jHistory;
  if (!seeded) throw new Error('ANCHOR_START_LOCAL_HISTORY_MISSING');
  expect(seeded.scannedThroughHeight).toBe(anchorHeight);
  expect(seeded.eventBlocks.size).toBe(0);
  expect(seeded.blockHashes.get(anchorHeight)).toBe(block.hash.toLowerCase());
  expect(getLocalJPrefixAttestableHeight(admitted, seeded)).toBe(anchorHeight);

  // Proposer side: an admissible anchor applies first in its frame; one queued
  // over state it refuses is dropped, never proposed into a halting frame.
  const chat = { type: 'chatMessage', data: { message: 'queued before the anchor', timestamp: 1 } } as EntityTx;
  expect(getJAnchorLocalRefusal(genesis)).toBeNull();
  const ordered = await selectProposableEntityTxs(context, genesis, [chat, tx]);
  expect(ordered.txs.map(entry => entry.type)).toEqual(['j_anchor', 'chatMessage']);
  expect(getJAnchorLocalRefusal(admitted)).toBe('FINALITY_EXISTS');
  const refusing = { entityId, signerId, isProposer: true, state: admitted, mempool: [tx, chat] } as EntityReplica;
  await selectEntityProposal(context, refusing, {
    localCanPropose: true,
    trustedLocalCrossJurisdiction: false,
    trustedLocalEntityTxs: [],
    accountWorkOnly: false,
    checkpoint: () => {},
  });
  expect(refusing.mempool.map(entry => entry.type)).toEqual(['chatMessage']);

  // The Foundation's action nonce is not fold-derivable: it stays on full history.
  const foundation = await readJHistoryAnchorStartFromStorage({
    send: (method, params) => provider.send(method, params),
    jurisdiction: foldJurisdiction,
    entityId: `0x${'00'.repeat(31)}01`,
    blockNumber: anchorHeight,
    authenticatedBlockHash: block.hash,
  });
  expect(foundation).toEqual({ kind: 'history', reason: 'ACTION_NONCE_UNPROVEN' });
}, 60_000);

test('an open debt in either direction keeps both parties on full history', async () => {
  const jAdapter = adapter!;
  const provider = jAdapter.provider as ethers.JsonRpcProvider;
  const jurisdiction = createJurisdictionConfig(
    JURISDICTION_NAME,
    jAdapter.addresses.depository,
    jAdapter.addresses.entityProvider,
    rpcUrl,
    CHAIN_ID,
  );
  const parties: DisputeParty[] = Array.from({ length: 2 }, () => ethers.Wallet.createRandom())
    .map(wallet => ({ wallet, entityId: generateLazyEntityId([wallet.address], 1n).toLowerCase() }))
    .sort((left, right) => (left.entityId < right.entityId ? -1 : 1));
  const [debtor, creditor] = parties as [DisputeParty, DisputeParty];
  // An unlisted token: the per-token queues cannot enumerate it, only the global counts see it.
  const unlisted = BigInt(await jAdapter.depository.getTokensLength()) + 3n;
  const finalize = await startShortfallDispute(jAdapter, CHAIN_ID, debtor, creditor, -55n, 'd5', unlisted);
  await provider.send('evm_increaseTime', [120]);
  await provider.send('evm_mine', []);
  await finalize();
  expect(BigInt(await jAdapter.depository.activeDebts(debtor.entityId))).toBe(1n);
  expect(BigInt(await jAdapter.depository.inActiveDebts(creditor.entityId))).toBe(1n);
  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);
  if (!block?.hash) throw new Error('ANCHOR_START_BLOCK_MISSING');
  for (const party of [debtor, creditor]) {
    const start = await readJHistoryAnchorStartFromStorage({
      send: (method, params) => provider.send(method, params),
      jurisdiction,
      entityId: party.entityId,
      blockNumber,
      authenticatedBlockHash: block.hash,
    });
    expect(start).toEqual({ kind: 'history', reason: 'DEBT_PRESENT' });
  }
}, 60_000);

// Every reserve source except the dev mint is bound to a listed token (deposits
// resolve through tokenToId/_tokens, ERC1155 receipt through tokenToId) and every
// other path conserves value per token. A dev mint outside _tokens.length would
// put a reserve where the storage anchor cannot enumerate it, so it is refused.
test('a dev mint outside _tokens.length is refused: the storage anchor sees every reserve', async () => {
  const jAdapter = adapter!;
  const tokenCount = BigInt(await jAdapter.depository.getTokensLength());
  const entityId = generateLazyEntityId([ethers.Wallet.createRandom().address], 1n).toLowerCase();
  const failure = await jAdapter.depository.mintToReserve.staticCall(entityId, tokenCount, 1n)
    .then(() => null, (error: unknown) => error);
  expect(failure instanceof Error ? failure.message : '').toContain('E11');
  // The last listed id still mints.
  await jAdapter.debugFundReserves(entityId, Number(tokenCount - 1n), 7n);
  expect(BigInt(await jAdapter.depository._reserves(entityId, tokenCount - 1n))).toBe(7n);
}, 60_000);
