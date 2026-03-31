import { describe, expect, test } from 'bun:test';

import { getWatcherStartBlock, processEventBatch, updateWatcherJurisdictionCursor } from '../jadapter/watcher';
import { createEmptyEnv } from '../runtime';
import type { EntityReplica } from '../types';

const makeReplica = (entityId: string, signerId: string, isProposer: boolean): EntityReplica =>
  ({
    entityId,
    signerId,
    mempool: [],
    isProposer,
    state: {
      entityId,
      height: 0,
      timestamp: 1_000,
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
      jBlockObservations: [],
      jBlockChain: [],
      entityEncPubKey: `${'0x'}${'11'.repeat(32)}`,
      entityEncPrivKey: `${'0x'}${'22'.repeat(32)}`,
      profile: {
        name: 'Replica',
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
      pendingSwapFillRatios: new Map(),
    },
  }) as EntityReplica;

describe('jadapter helper cursors', () => {
  test('uses matching jReplica blockNumber as watcher cursor source', () => {
    const env = {
      activeJurisdiction: 'Arrakis',
      jReplicas: new Map([
        ['Arrakis', { name: 'Arrakis', blockNumber: 17n, depositoryAddress: '0xaaa' }],
        ['Wakanda', { name: 'Wakanda', blockNumber: 44n, depositoryAddress: '0xbbb' }],
      ]),
    } as any;

    expect(getWatcherStartBlock(env, '0xaaa')).toBe(18);
  });

  test('falls back to active jurisdiction block when no depository address is provided', () => {
    const env = {
      activeJurisdiction: 'Wakanda',
      jReplicas: new Map([
        ['Arrakis', { name: 'Arrakis', blockNumber: 22n, depositoryAddress: '0xaaa' }],
        ['Wakanda', { name: 'Wakanda', blockNumber: 19n, depositoryAddress: '0xbbb' }],
      ]),
    } as any;

    expect(getWatcherStartBlock(env)).toBe(20);
  });

  test('falls back to genesis when no jurisdiction replica is present', () => {
    const env = {
      jReplicas: new Map(),
    } as any;

    expect(getWatcherStartBlock(env)).toBe(1);
  });

  test('watcher start block only advances after an explicit committed cursor update', () => {
    const env = {
      activeJurisdiction: 'Arrakis',
      jReplicas: new Map([
        ['Arrakis', { name: 'Arrakis', blockNumber: 100n, depositoryAddress: '0xaaa' }],
      ]),
    } as any;

    expect(getWatcherStartBlock(env, '0xaaa')).toBe(101);
    updateWatcherJurisdictionCursor(env, 120, '0xaaa');
    expect(getWatcherStartBlock(env, '0xaaa')).toBe(121);
  });

  test('processEventBatch fans out canonical events to every registered replica through runtime ingress', () => {
    const env = createEmptyEnv('jadapter-helper-delivery-seed');
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;

    const entityId = `0x${'44'.repeat(32)}`;
    const proposerSignerId = `0x${'55'.repeat(20)}`;
    const validatorSignerId = `0x${'66'.repeat(20)}`;
    env.eReplicas.set(`${entityId}:${proposerSignerId}`, makeReplica(entityId, proposerSignerId, true));
    env.eReplicas.set(`${entityId}:${validatorSignerId}`, makeReplica(entityId, validatorSignerId, false));

    processEventBatch(
      [{
        name: 'ReserveUpdated',
        args: {
          entity: entityId,
          tokenId: 2,
          newBalance: 123n,
        },
        blockNumber: 7,
        blockHash: `0x${'66'.repeat(32)}`,
        transactionHash: `0x${'77'.repeat(32)}`,
        logIndex: 0,
      }],
      env,
      7,
      `0x${'66'.repeat(32)}`,
      { value: 0 },
      'test',
    );

    const queuedInputs = env.runtimeMempool?.entityInputs ?? [];
    expect(queuedInputs.length).toBe(2);
    expect(queuedInputs.every((input) => input.entityId === entityId.toLowerCase())).toBe(true);
    expect(queuedInputs.map((input) => input.signerId).sort()).toEqual([proposerSignerId, validatorSignerId].sort());
    expect(queuedInputs.every((input) => input.entityTxs[0]?.type === 'j_event')).toBe(true);
    expect(env.runtimeState?.wakeRequested).toBe(true);
  });
});
