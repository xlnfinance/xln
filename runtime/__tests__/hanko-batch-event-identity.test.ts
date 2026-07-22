import { expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { applyHankoBatchProcessedEvent } from '../entity/tx/j-events-batch';
import { generateLazyEntityId } from '../entity/factory';
import { prepareSignedBatch } from '../hanko/batch';
import { createJAdapter } from '../jadapter';
import { rawEventToJEvents } from '../jadapter/helpers';
import { createEmptyBatch } from '../jurisdiction/batch';
import { normalizeJurisdictionEvent } from '../jurisdiction/event-normalization';
import type { EntityState, JurisdictionEvent } from '../types';

const ENTITY_ID = `0x${'11'.repeat(32)}`;
const STALE_BATCH_HASH = `0x${'22'.repeat(32)}`;
const PENDING_BATCH_HASH = `0x${'33'.repeat(32)}`;

const makeEntityState = (): EntityState => ({
  entityId: ENTITY_ID,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    validators: ['validator'],
    shares: { validator: 1n },
    threshold: 1n,
  },
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  jBatchState: {
    batch: createEmptyBatch(),
    jurisdiction: null,
    lastBroadcast: 900,
    broadcastCount: 2,
    failedAttempts: 0,
    status: 'sent',
    entityNonce: 6,
    sentBatch: {
      batch: createEmptyBatch(),
      batchHash: PENDING_BATCH_HASH,
      encodedBatch: '0x1234',
      entityNonce: 7,
      firstSubmittedAt: 900,
      lastSubmittedAt: 900,
      submitAttempts: 1,
    },
  },
  entityEncPubKey: `0x${'44'.repeat(32)}`,
  entityEncPrivKey: `0x${'55'.repeat(32)}`,
  profile: { name: 'Batch identity', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
  swapTradingPairs: [],
});

test('finalized different batch at the pending nonce quarantines the now-unexecutable replacement', async () => {
  const state = makeEntityState();
  const staleEvent = {
    type: 'HankoBatchProcessed',
    data: {
      entityId: ENTITY_ID,
      batchHash: STALE_BATCH_HASH,
      nonce: 7,
      success: true,
    },
  } as unknown as JurisdictionEvent;

  await applyHankoBatchProcessedEvent({
    newState: state,
    event: staleEvent,
    transactionHash: `0x${'66'.repeat(32)}`,
    blockNumber: 100,
    dirtyAccounts: new Set(),
  });

  expect(state.jBatchState?.entityNonce).toBe(7);
  expect(state.jBatchState?.sentBatch?.batchHash).toBe(PENDING_BATCH_HASH);
  expect(state.jBatchState?.sentBatch?.terminalFailure?.message)
    .toContain(`J_BATCH_NONCE_CONSUMED_BY_DIFFERENT_HASH:${STALE_BATCH_HASH}`);
  expect(state.jBatchState?.status).toBe('failed');
  expect(state.batchHistory).toBeUndefined();
});

test('only an exact nonce and canonical batch hash finalizes the pending batch', async () => {
  const state = makeEntityState();
  const matchingEvent: JurisdictionEvent = {
    type: 'HankoBatchProcessed',
    data: {
      entityId: ENTITY_ID,
      batchHash: PENDING_BATCH_HASH.toUpperCase().replace('0X', '0x'),
      nonce: 7,
      success: true,
    },
  };

  await applyHankoBatchProcessedEvent({
    newState: state,
    event: matchingEvent,
    transactionHash: `0x${'77'.repeat(32)}`,
    blockNumber: 101,
    dirtyAccounts: new Set(),
  });

  expect(state.jBatchState?.sentBatch).toBeUndefined();
  expect(state.jBatchState?.entityNonce).toBe(7);
  expect(state.batchHistory).toHaveLength(1);
  expect(state.batchHistory?.[0]?.batchHash).toBe(PENDING_BATCH_HASH);
});

test('finality releases a protocol-forced draft broadcast without mixing it into the pending batch', async () => {
  const state = makeEntityState();
  state.jBatchState!.autoBroadcastDraft = true;
  state.jBatchState!.batch.reserveToReserve.push({
    receivingEntity: `0x${'44'.repeat(32)}`,
    tokenId: 1,
    amount: 4n,
  });
  const outputs: import('../types').EntityInput[] = [];

  await applyHankoBatchProcessedEvent({
    newState: state,
    event: {
      type: 'HankoBatchProcessed',
      data: {
        entityId: ENTITY_ID,
        batchHash: PENDING_BATCH_HASH,
        nonce: 7,
        success: true,
      },
    },
    transactionHash: `0x${'78'.repeat(32)}`,
    blockNumber: 102,
    dirtyAccounts: new Set(),
    outputs,
  });

  expect(state.jBatchState?.sentBatch).toBeUndefined();
  expect(state.jBatchState?.autoBroadcastDraft).toBe(true);
  expect(outputs).toEqual([{
    entityId: ENTITY_ID,
    signerId: 'validator',
    entityTxs: [{ type: 'j_broadcast', data: {} }],
  }]);
});

test('an older stale event cannot requeue or mark a newer pending batch failed', async () => {
  const state = makeEntityState();
  const staleFailure: JurisdictionEvent = {
    type: 'HankoBatchProcessed',
    data: {
      entityId: ENTITY_ID,
      batchHash: STALE_BATCH_HASH,
      nonce: 6,
      success: false,
    },
  };

  await applyHankoBatchProcessedEvent({
    newState: state,
    event: staleFailure,
    transactionHash: `0x${'88'.repeat(32)}`,
    blockNumber: 102,
    dirtyAccounts: new Set(),
  });

  expect(state.jBatchState?.sentBatch?.batchHash).toBe(PENDING_BATCH_HASH);
  expect(state.jBatchState?.status).toBe('sent');
  expect(state.jBatchState?.failedAttempts).toBe(0);
  expect(state.batchHistory).toBeUndefined();
});

test('adapter decoding and persistence normalization preserve canonical batchHash identity', () => {
  const [decoded] = rawEventToJEvents({
    name: 'HankoBatchProcessed',
    args: {
      entityId: ENTITY_ID,
      batchHash: PENDING_BATCH_HASH,
      nonce: 7n,
      success: true,
    },
    blockNumber: 103,
    blockHash: `0x${'99'.repeat(32)}`,
    transactionHash: `0x${'aa'.repeat(32)}`,
    logIndex: 4,
  }, ENTITY_ID);

  expect(decoded?.type).toBe('HankoBatchProcessed');
  expect(decoded?.data).toEqual({
    entityId: ENTITY_ID,
    batchHash: PENDING_BATCH_HASH,
    nonce: 7,
    success: true,
  });
  expect(normalizeJurisdictionEvent(decoded)).toEqual(decoded);
  expect(normalizeJurisdictionEvent({
    type: 'HankoBatchProcessed',
    data: { entityId: ENTITY_ID, nonce: 7, success: true },
  })).toBeNull();
});

test('BrowserVM production processBatch event finalizes only its exact runtime pending batch', async () => {
  const privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const signerAddress = new ethers.Wallet(privateKey).address;
  const entityId = generateLazyEntityId([signerAddress], 1n).toLowerCase();
  const adapter = await createJAdapter({ mode: 'browservm', chainId: 31337 });

  try {
    const signed = prepareSignedBatch(
      createEmptyBatch(),
      entityId,
      privateKey,
      31337n,
      adapter.addresses.depository,
      0n,
    );
    const receipt = await adapter.processBatch(
      signed.encodedBatch,
      signed.hankoData,
      signed.nextNonce,
    );
    const rawEvent = receipt.events.find((event) => event.name === 'HankoBatchProcessed');
    if (!rawEvent) throw new Error('HANKO_BATCH_PROCESSED_EVENT_MISSING');
    const [event] = rawEventToJEvents(rawEvent, entityId);
    if (!event) throw new Error('HANKO_BATCH_PROCESSED_EVENT_DECODE_FAILED');

    const state = makeEntityState();
    state.entityId = entityId;
    state.jBatchState!.sentBatch = {
      batch: createEmptyBatch(),
      batchHash: signed.batchHash,
      encodedBatch: signed.encodedBatch,
      entityNonce: Number(signed.nextNonce),
      firstSubmittedAt: 900,
      lastSubmittedAt: 900,
      submitAttempts: 1,
    };
    state.jBatchState!.entityNonce = 0;

    await applyHankoBatchProcessedEvent({
      newState: state,
      event,
      transactionHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
      dirtyAccounts: new Set(),
    });

    expect(event.type).toBe('HankoBatchProcessed');
    expect(event.type === 'HankoBatchProcessed' ? event.data.batchHash : null).toBe(signed.batchHash);
    expect(state.jBatchState?.sentBatch).toBeUndefined();
    expect(state.batchHistory?.[0]?.batchHash).toBe(signed.batchHash);
  } finally {
    await adapter.close();
  }
}, 30_000);
