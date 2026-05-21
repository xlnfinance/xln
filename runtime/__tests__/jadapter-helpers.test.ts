import { describe, expect, test } from 'bun:test';

import { getWatcherStartBlock, processEventBatch, updateWatcherJurisdictionCursor } from '../jadapter/watcher';
import { createEmptyEnv } from '../runtime';
import type { EntityReplica, Env, JReplica } from '../types';

const makeJReplica = (name: string, blockNumber: bigint, depositoryAddress: string): JReplica => ({
  name,
  blockNumber,
  depositoryAddress,
  stateRoot: new Uint8Array(32),
  mempool: [],
  blockDelayMs: 0,
  lastBlockTimestamp: 0,
  position: { x: 0, y: 0, z: 0 },
});

const makeCursorEnv = (seed: string, replicas: JReplica[], activeJurisdiction?: string): Env => {
  const env = createEmptyEnv(seed);
  env.activeJurisdiction = activeJurisdiction;
  env.jReplicas = new Map(replicas.map((replica) => [replica.name, replica]));
  return env;
};

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
    const env = makeCursorEnv('jadapter-cursor-match', [
      makeJReplica('Arrakis', 17n, '0xaaa'),
      makeJReplica('Wakanda', 44n, '0xbbb'),
    ], 'Arrakis');

    expect(getWatcherStartBlock(env, '0xaaa')).toBe(18);
  });

  test('falls back to active jurisdiction block when no depository address is provided', () => {
    const env = makeCursorEnv('jadapter-cursor-active', [
      makeJReplica('Arrakis', 22n, '0xaaa'),
      makeJReplica('Wakanda', 19n, '0xbbb'),
    ], 'Wakanda');

    expect(getWatcherStartBlock(env)).toBe(20);
  });

  test('falls back to genesis when no jurisdiction replica is present', () => {
    const env = makeCursorEnv('jadapter-cursor-empty', []);

    expect(getWatcherStartBlock(env)).toBe(1);
  });

  test('watcher start block only advances after an explicit committed cursor update', () => {
    const env = makeCursorEnv('jadapter-cursor-update', [
      makeJReplica('Arrakis', 100n, '0xaaa'),
    ], 'Arrakis');

    expect(getWatcherStartBlock(env, '0xaaa')).toBe(101);
    updateWatcherJurisdictionCursor(env, 120, '0xaaa');
    expect(getWatcherStartBlock(env, '0xaaa')).toBe(121);
  });

  test('processEventBatch fans out canonical events to every registered replica through runtime ingress', () => {
    const env = createEmptyEnv('jadapter-helper-delivery-seed');
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;

    const entityId = `0x${'44'.repeat(32)}`;
    const proposerSignerId = '1';
    const validatorSignerId = '2';
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
