import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { ethers } from 'ethers';

import type { EntityState, JurisdictionConfig } from '../../../../entity/types';
import { generateLazyEntityId } from '../../../../entity/factory';
import { applyReserveUpdatedJEvent } from '../../../../entity/tx/j-events-observations';
import { applyHankoBatchProcessedEvent } from '../../../../entity/tx/j-events-batch';
import type { FinalizedJEventContext } from '../../../../entity/tx/j-events';
import { prepareSignedBatch } from '../../../../hanko/batch';
import { createJAdapter, createXlnJsonRpcProvider } from '../../../../jurisdiction/adapter';
import type { JAdapter } from '../../../../jurisdiction/adapter/types';
import { rawEventToJEvents } from '../../../../jurisdiction/adapter/events/j-event-payloads';
import { decodeJEventLog } from '../../../../jurisdiction/adapter/j-event-log-decoder';
import {
  buildReserveAnchorRoot,
  projectNonZeroReserves,
  readReserveAnchor,
} from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-reserve-anchor';
import { buildNonceAnchorRoot, nonceViewFromFold, readEntityNonceAnchor } from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-nonce-anchor';
import { createEmptyBatch } from '../../../../jurisdiction/machine/batch';

// The Entity reserve fold (canonical applyReserveUpdatedJEvent over the real
// Depository log history) and eth_getProof storage at the same hash-bound block
// must give the same non-zero reserves and the same anchor root, after real
// mints, signed reserve-to-reserve transfers including a full drain, and a
// signed reserve-to-collateral that also emits AccountSettled.
const CHAIN_ID = 31_337;

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

const send = (method: string, params: unknown[]): Promise<unknown> => provider.send(method, params);

const blockHashAt = async (blockNumber: number): Promise<string> =>
  String(((await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false])) as { hash: string }).hash);

/** Canonical Entity reserve fold for each listed entity up to `toBlock`. */
const foldHistoryReserves = async (entityIds: readonly string[], toBlock: number): Promise<Map<string, Map<number, bigint>>> => {
  const jAdapter = adapter!;
  const logs = await provider.getLogs({ address: jAdapter.addresses.depository, fromBlock: 0, toBlock });
  const states = new Map(entityIds.map(entityId => [entityId, { entityId, reserves: new Map<number, bigint>() } as unknown as EntityState]));
  for (const log of logs) {
    const raw = decodeJEventLog(log, jAdapter.depository.interface, {
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    }, 'RESERVE_ANCHOR_LOG_DECODE');
    if (raw.name !== 'ReserveUpdated') continue;
    for (const event of rawEventToJEvents(raw, ethers.ZeroHash)) {
      for (const state of states.values()) {
        applyReserveUpdatedJEvent({
          entityState: state,
          newState: state,
          event,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
        } as unknown as FinalizedJEventContext);
      }
    }
  }
  return new Map([...states].map(([entityId, state]) => [entityId, state.reserves]));
};

const mined = async (): Promise<{ number: number; hash: string }> => {
  const number = await provider.getBlockNumber();
  return { number, hash: await blockHashAt(number) };
};

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

test('history reserve fold and eth_getProof storage agree after mints, signed R2R and a full drain', async () => {
  const jAdapter = adapter!;
  const signer = ethers.Wallet.createRandom();
  const payer = generateLazyEntityId([signer.address], 1n).toLowerCase();
  const payee = ethers.hexlify(ethers.randomBytes(32)).toLowerCase();
  const untouched = ethers.hexlify(ethers.randomBytes(32)).toLowerCase();
  const entityIds = [payer, payee, untouched];
  const tokenCount = BigInt(await jAdapter.depository.getTokensLength());
  expect(tokenCount).toBeGreaterThanOrEqual(3n);

  await jAdapter.debugFundReserves(payer, 1, 1_000n);
  await jAdapter.debugFundReserves(payer, 2, 500n);
  await jAdapter.debugFundReserves(payee, 1, 7n);
  const funded = await mined();

  const batch = createEmptyBatch();
  batch.reserveToReserve.push({ receivingEntity: payee, tokenId: 1, amount: 300n });
  batch.reserveToReserve.push({ receivingEntity: payee, tokenId: 2, amount: 500n });
  const signed = prepareSignedBatch(batch, payer, signer.privateKey, BigInt(CHAIN_ID), jAdapter.addresses.depository, 0n);
  await jAdapter.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce);
  // Reserve-to-collateral also emits AccountSettled carrying both reserves.
  const collateral = createEmptyBatch();
  collateral.reserveToCollateral.push({ tokenId: 1, receivingEntity: payer, pairs: [{ entity: payee, amount: 200n }] });
  const signedCollateral = prepareSignedBatch(
    collateral, payer, signer.privateKey, BigInt(CHAIN_ID), jAdapter.addresses.depository, signed.nextNonce,
  );
  await jAdapter.processBatch(signedCollateral.encodedBatch, signedCollateral.hankoData, signedCollateral.nextNonce);
  const settled = await mined();
  expect(settled.number).toBeGreaterThan(funded.number);

  const history = await foldHistoryReserves(entityIds, settled.number);
  // The fold keeps the drained token as an explicit zero; storage cannot.
  expect(history.get(payer)!.get(2)).toBe(0n);
  expect(history.get(untouched)!.size).toBe(0);

  const anchor = await readReserveAnchor({ send, jurisdiction, blockNumber: settled.number, authenticatedBlockHash: settled.hash, entityIds });
  expect(anchor.tokenCount).toBe(tokenCount);
  expect(anchor.reserves.get(payer)).toEqual(new Map([[1, 500n]]));
  expect(anchor.reserves.get(payee)).toEqual(new Map([[1, 307n], [2, 500n]]));
  expect(anchor.reserves.get(untouched)).toEqual(new Map());
  for (const entityId of entityIds) {
    expect(projectNonZeroReserves(history.get(entityId)!)).toEqual(anchor.reserves.get(entityId)!);
  }
  const historyRoot = buildReserveAnchorRoot(tokenCount, history);
  expect(historyRoot).toBe(anchor.root);

  // The AccountSettled reserve snapshot (the other Entity reserve writer) is
  // read after the reserve writes, so it equals storage too.
  const settledLogs = (await provider.getLogs({ address: jAdapter.addresses.depository, fromBlock: settled.number, toBlock: settled.number }))
    .map(log => jAdapter.depository.interface.parseLog(log))
    .filter(parsed => parsed?.name === 'AccountSettled');
  expect(settledLogs.length).toBe(1);
  const [left, right] = payer < payee ? [payer, payee] : [payee, payer];
  const settlement = settledLogs[0]!.args[0][0];
  expect(String(settlement.left).toLowerCase()).toBe(left);
  expect(settlement.tokens[0].tokenId).toBe(1n);
  expect(settlement.tokens[0].leftReserve).toBe(anchor.reserves.get(left)!.get(1)!);
  expect(settlement.tokens[0].rightReserve).toBe(anchor.reserves.get(right)!.get(1)!);

  // Chunking and concurrency do not change the proven view.
  const chunked = await readReserveAnchor({
    send, jurisdiction, blockNumber: settled.number, authenticatedBlockHash: settled.hash, entityIds, slotsPerProof: 1, concurrency: 2,
  });
  expect(chunked.root).toBe(anchor.root);

  // Pre-transfer anchor equals the pre-transfer fold and differs from the tip.
  const before = await readReserveAnchor({ send, jurisdiction, blockNumber: funded.number, authenticatedBlockHash: funded.hash, entityIds });
  expect(before.root).toBe(buildReserveAnchorRoot(tokenCount, await foldHistoryReserves(entityIds, funded.number)));
  expect(before.root).not.toBe(anchor.root);

  // Mutants: wrong token, wrong balance, missing entity, wrong enumeration bound.
  const wrongToken = new Map(history);
  wrongToken.set(payee, new Map([[1, 307n], [3, 500n]]));
  expect(buildReserveAnchorRoot(tokenCount, wrongToken)).not.toBe(anchor.root);
  const wrongBalance = new Map(history);
  wrongBalance.set(payer, new Map([[1, 501n]]));
  expect(buildReserveAnchorRoot(tokenCount, wrongBalance)).not.toBe(anchor.root);
  const missing = await readReserveAnchor({
    send, jurisdiction, blockNumber: settled.number, authenticatedBlockHash: settled.hash, entityIds: [payer, payee],
  });
  expect(missing.root).not.toBe(anchor.root);
  expect(buildReserveAnchorRoot(tokenCount + 1n, history)).not.toBe(anchor.root);
  expect(() => buildReserveAnchorRoot(2n, history)).toThrow('RESERVE_ANCHOR_TOKEN_UNLISTED');

  // Stale state: the tip number with an older block hash is refused before any proof.
  await expect(readReserveAnchor({
    send, jurisdiction, blockNumber: settled.number, authenticatedBlockHash: funded.hash, entityIds,
  })).rejects.toThrow('CLAIMED_HASH_MISMATCH');
  // A code-less address would prove an all-zero ledger; it is refused.
  await expect(readReserveAnchor({
    send, jurisdiction: { depositoryAddress: ethers.Wallet.createRandom().address }, blockNumber: settled.number,
    authenticatedBlockHash: settled.hash, entityIds,
  })).rejects.toThrow('RESERVE_ANCHOR_CONTRACT_MISSING');
  await expect(readReserveAnchor({
    send, jurisdiction, blockNumber: settled.number, authenticatedBlockHash: settled.hash, entityIds: [payer, payer],
  })).rejects.toThrow('RESERVE_ANCHOR_ENTITY_DUPLICATE');
}, 60_000);

// Replay nonces (Depository entityNonces, EntityProvider entityActionNonces):
// the canonical HankoBatchProcessed fold equals eth_getProof storage at the
// same hash-bound block. The Foundation's action slot also counts its own
// Foundation actions (telemetry-only FoundationActionExecuted), so it is
// proven but recorded as not fold-derivable rather than defaulted.
test('nonce fold and eth_getProof storage agree after signed batches; Foundation action nonce stays unproven', async () => {
  const jAdapter = adapter!;
  const signer = ethers.Wallet.createRandom();
  const entityId = generateLazyEntityId([signer.address], 1n).toLowerCase();
  const idle = ethers.hexlify(ethers.randomBytes(32)).toLowerCase();
  const foundation = ethers.toBeHex(1n, 32).toLowerCase();
  const entityIds = [entityId, idle, foundation];
  await jAdapter.debugFundReserves(entityId, 1, 10n);
  const before = await mined();
  let nonce = 0n;
  for (let round = 0; round < 2; round += 1) {
    const batch = createEmptyBatch();
    batch.reserveToReserve.push({ receivingEntity: idle, tokenId: 1, amount: 1n });
    const signed = prepareSignedBatch(batch, entityId, signer.privateKey, BigInt(CHAIN_ID), jAdapter.addresses.depository, nonce);
    await jAdapter.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce);
    nonce = signed.nextNonce;
  }
  const tip = await mined();
  expect(tip.number).toBeGreaterThan(before.number);

  const foldNonces = async (toBlock: number): Promise<Map<string, EntityState>> => {
    const states = new Map(entityIds.map(id => [id, { entityId: id, timestamp: 0, messages: [] } as unknown as EntityState]));
    const logs = await provider.getLogs({ address: jAdapter.addresses.depository, fromBlock: 0, toBlock });
    for (const log of logs) {
      const raw = decodeJEventLog(log, jAdapter.depository.interface, {
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        logIndex: log.index,
      }, 'NONCE_ANCHOR_LOG_DECODE');
      if (raw.name !== 'HankoBatchProcessed') continue;
      for (const state of states.values()) {
        for (const event of rawEventToJEvents(raw, state.entityId)) {
          await applyHankoBatchProcessedEvent({ newState: state, event, blockNumber: log.blockNumber });
        }
      }
    }
    return states;
  };

  const folded = await foldNonces(tip.number);
  expect(folded.get(entityId)!.jBatchState?.entityNonce).toBe(2);
  expect(folded.get(idle)!.jBatchState).toBeUndefined();
  const anchor = await readEntityNonceAnchor({ send, jurisdiction, blockNumber: tip.number, authenticatedBlockHash: tip.hash, entityIds });
  expect(anchor.views.get(entityId)).toEqual({ entityId, batchNonce: 2n, actionNonce: 0n });
  expect(anchor.views.get(idle)).toEqual({ entityId: idle, batchNonce: 0n, actionNonce: 0n });
  expect(anchor.views.get(foundation)?.actionNonce).toBeNull();
  // The raw Foundation slot is still proven; deployStack lists its tokens
  // without a Foundation action, so it is zero here.
  expect(anchor.storedActionNonces.get(foundation)).toBe(BigInt(await jAdapter.entityProvider.entityActionNonces(foundation)));
  expect(anchor.storedActionNonces.get(foundation)).toBe(0n);
  const foldViews = [...folded.values()].map(nonceViewFromFold);
  expect(buildNonceAnchorRoot(foldViews)).toBe(anchor.root);

  // The pre-batch anchor equals the pre-batch fold and differs from the tip.
  const earlier = await readEntityNonceAnchor({ send, jurisdiction, blockNumber: before.number, authenticatedBlockHash: before.hash, entityIds });
  expect(buildNonceAnchorRoot([...(await foldNonces(before.number)).values()].map(nonceViewFromFold))).toBe(earlier.root);
  expect(earlier.root).not.toBe(anchor.root);

  // Mutants: a missed batch, a forged action nonce, a defaulted Foundation value.
  const missedBatch = foldViews.map(view => (view.entityId === entityId ? { ...view, batchNonce: 1n } : view));
  expect(buildNonceAnchorRoot(missedBatch)).not.toBe(anchor.root);
  const forgedAction = foldViews.map(view => (view.entityId === entityId ? { ...view, actionNonce: 1n } : view));
  expect(buildNonceAnchorRoot(forgedAction)).not.toBe(anchor.root);
  const defaultedFoundation = foldViews.map(view => (view.entityId === foundation ? { ...view, actionNonce: 0n } : view));
  expect(() => buildNonceAnchorRoot(defaultedFoundation)).toThrow('NONCE_ANCHOR_FOUNDATION_SCOPE');

  // Stale hash under the tip number and a code-less EntityProvider are refused.
  await expect(readEntityNonceAnchor({
    send, jurisdiction, blockNumber: tip.number, authenticatedBlockHash: before.hash, entityIds,
  })).rejects.toThrow('CLAIMED_HASH_MISMATCH');
  await expect(readEntityNonceAnchor({
    send, jurisdiction: { ...jurisdiction, entityProviderAddress: ethers.Wallet.createRandom().address },
    blockNumber: tip.number, authenticatedBlockHash: tip.hash, entityIds,
  })).rejects.toThrow('NONCE_ANCHOR_CONTRACT_MISSING');
}, 60_000);
