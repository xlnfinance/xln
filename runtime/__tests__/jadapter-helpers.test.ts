import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  isTransientRpcUnavailableError,
  readOptionalRpcBatchBigInt,
  readRequiredRpcBatchBigInt,
  resolveWatcherPollToBlock,
  shouldEmitExternalWalletAllowanceDelta,
  shouldEmitExternalWalletBalanceDelta,
} from '../jadapter/rpc';
import {
  applyJEventsToEnv,
  buildJEventsRuntimeInput,
  collectRelevantJEventReplicaKeys,
  getWatcherStartBlock,
  getMinimumCommittedSignerJHeight,
  processEventBatch,
  rawEventToJEvents,
  rememberPendingWatcherJBlock,
  resolveCommittedWatcherCursor,
  setJEventIngressTransform,
  updateWatcherJurisdictionCursor,
} from '../jadapter/watcher';
import { findRecentReserveUpdatedEvent } from '../jurisdiction/event-evidence';
import { createEmptyEnv } from '../runtime';
import type { EntityReplica, Env, JReplica, JurisdictionConfig } from '../types';

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

const makeJurisdiction = (name: string, chainId: number, depositoryAddress: string): JurisdictionConfig => ({
  name,
  address: `rpc://${name}`,
  chainId,
  depositoryAddress,
  entityProviderAddress: `0x${(chainId % 256).toString(16).padStart(2, '0').repeat(20)}`,
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
  test('jadapter helper diagnostics use structured logging only', () => {
    const source = readFileSync(join(process.cwd(), 'runtime/jadapter/helpers.ts'), 'utf8');

    expect(source).toContain("createStructuredLogger('jadapter.helpers')");
    expect(source).toContain("jadapterHelperLog.info('event_batch.canonical'");
    expect(source).toContain("jadapterHelperLog.info('j_event.deliver_settled'");
    expect(source).toContain("jadapterHelperLog.info('event_batch.delivered_to_entity'");
    expect(source).not.toContain('console.');
  });

  test('RPC wallet snapshot reads fail fast on partial RPC errors', () => {
    expect(readRequiredRpcBatchBigInt(new Map([[1, { id: 1, result: '0x2a' }]]), 1, 'balance')).toBe(42n);
    expect(() => readRequiredRpcBatchBigInt(new Map(), 1, 'balance')).toThrow(/EXTERNAL_WALLET_SNAPSHOT_RPC_MISSING/);
    expect(() => readRequiredRpcBatchBigInt(new Map([[1, { id: 1, error: { message: 'boom' } }]]), 1, 'balance'))
      .toThrow(/EXTERNAL_WALLET_SNAPSHOT_RPC_ERROR/);
    expect(() => readRequiredRpcBatchBigInt(new Map([[1, { id: 1, result: null }]]), 1, 'balance'))
      .toThrow(/EXTERNAL_WALLET_SNAPSHOT_RPC_INVALID_RESULT/);
    expect(() => readRequiredRpcBatchBigInt(new Map([[1, { id: 1, result: 'not-a-number' }]]), 1, 'balance'))
      .toThrow(/EXTERNAL_WALLET_SNAPSHOT_RPC_INVALID_BIGINT/);
    expect(readOptionalRpcBatchBigInt(new Map([[1, { id: 1, result: '0x' }]]), 1, 'balance')).toMatchObject({
      ok: false,
      error: expect.stringContaining('EXTERNAL_WALLET_SNAPSHOT_RPC_INVALID_BIGINT'),
    });
  });

  test('external wallet watcher gates deltas by committed per-key baselines only', () => {
    const tokenA = `0x${'61'.repeat(20)}`;
    const tokenB = `0x${'62'.repeat(20)}`;
    const spenderA = `0x${'71'.repeat(20)}`;
    const spenderB = `0x${'72'.repeat(20)}`;
    const tracked = {
      entityId: `0x${'51'.repeat(32)}`,
      watchAfterBlock: 100,
      balanceAfterBlockByToken: new Map([[tokenA, 80]]),
      allowanceAfterBlockByKey: new Map([[`${tokenA}:${spenderA}`, 80]]),
    };

    expect(shouldEmitExternalWalletBalanceDelta(tracked, tokenA, 90)).toBe(false);
    expect(shouldEmitExternalWalletBalanceDelta(tracked, tokenA, 101)).toBe(true);
    expect(shouldEmitExternalWalletBalanceDelta(tracked, tokenA, 80)).toBe(false);
    expect(shouldEmitExternalWalletBalanceDelta(tracked, tokenB, 101)).toBe(false);
    expect(shouldEmitExternalWalletAllowanceDelta(tracked, tokenA, spenderA, 90)).toBe(false);
    expect(shouldEmitExternalWalletAllowanceDelta(tracked, tokenA, spenderA, 101)).toBe(true);
    expect(shouldEmitExternalWalletAllowanceDelta(tracked, tokenA, spenderA, 80)).toBe(false);
    expect(shouldEmitExternalWalletAllowanceDelta(tracked, tokenA, spenderB, 101)).toBe(false);
  });

  test('RPC proxy upstream timeout is transient for the watcher', () => {
    const error = new Error(
      'server response 502 Bad Gateway (responseBody={"error":"PROXY_UPSTREAM_TIMEOUT:5000"}, code=SERVER_ERROR)',
    ) as Error & { code?: string; info?: unknown };
    error.code = 'SERVER_ERROR';
    error.info = {
      requestUrl: 'https://localhost:20364/rpc',
      responseStatus: '502 Bad Gateway',
      responseBody: '{"error":"PROXY_UPSTREAM_TIMEOUT:5000","upstream":"http://localhost:20360/"}',
    };

    expect(isTransientRpcUnavailableError(error)).toBe(true);
    expect(isTransientRpcUnavailableError(Object.assign(
      new Error('server response 500 Internal Server Error (code=SERVER_ERROR)'),
      {
        code: 'SERVER_ERROR',
        info: {
          requestUrl: 'https://localhost:20364/rpc2',
          responseStatus: '500 Internal Server Error',
          responseBody: 'Internal Server Error',
        },
      },
    ))).toBe(true);
    expect(isTransientRpcUnavailableError(new Error('EXTERNAL_WALLET_BASELINE_MISSING'))).toBe(false);
    expect(isTransientRpcUnavailableError(new Error('execution reverted: INSUFFICIENT_RESERVE'))).toBe(false);
  });

  test('RPC watcher bounds historical catch-up without skipping the safe tip', () => {
    expect(resolveWatcherPollToBlock(1, 10_000, 256)).toBe(256);
    expect(resolveWatcherPollToBlock(257, 10_000, 256)).toBe(512);
    expect(resolveWatcherPollToBlock(9_900, 10_000, 256)).toBe(10_000);
    expect(resolveWatcherPollToBlock(10_000, 10_000, 256)).toBe(10_000);
    expect(() => resolveWatcherPollToBlock(0, 10_000, 256)).toThrow(/J_WATCHER_FROM_BLOCK_INVALID/);
    expect(() => resolveWatcherPollToBlock(2, 1, 256)).toThrow(/J_WATCHER_SAFE_TO_BLOCK_INVALID/);
    expect(() => resolveWatcherPollToBlock(1, 10_000, 0)).toThrow(/J_WATCHER_BLOCK_RANGE_INVALID/);
  });

  test('j-event ingress rejects during persistence quiesce before cursor or dedup mutation', () => {
    const env = createEmptyEnv('jadapter-quiesce-ingress');
    env.runtimeState = { persistenceQuiescing: true } as Env['runtimeState'];
    const entityId = `0x${'44'.repeat(32)}`;
    const owner = `0x${'55'.repeat(20)}`;
    const txCounter = { value: 0 } as { value: number; _seenLogs?: unknown };

    expect(() => processEventBatch(
      [{
        name: 'ExternalWalletSnapshot',
        args: {
          entityId,
          owner,
          nativeBalance: '1',
          tokenBalances: [],
          allowances: [],
        },
        blockNumber: 7,
        blockHash: `0x${'66'.repeat(32)}`,
        transactionHash: `0x${'77'.repeat(32)}`,
      }],
      env,
      7,
      `0x${'66'.repeat(32)}`,
      txCounter,
      'test-quiesce',
    )).toThrow(/J_EVENT_INGRESS_QUIESCING:test-quiesce/);

    expect(txCounter._seenLogs).toBeUndefined();
    expect(env.runtimeMempool?.entityInputs ?? []).toHaveLength(0);
    expect(env.runtimeState?.externalWalletWatchOwners).toBeUndefined();

    expect(() => applyJEventsToEnv(env, [{
      name: 'ExternalWalletSnapshot',
      args: {
        entityId,
        owner,
        nativeBalance: '1',
        tokenBalances: [],
        allowances: [],
      },
      blockNumber: 8,
      blockHash: `0x${'68'.repeat(32)}`,
      transactionHash: 'external-wallet-snapshot:8',
    }], 'manual-snapshot')).toThrow(/J_EVENT_INGRESS_QUIESCING:manual-snapshot/);

    expect(env.runtimeMempool?.entityInputs ?? []).toHaveLength(0);
    expect(env.runtimeState?.externalWalletWatchOwners).toBeUndefined();
  });

  test('external wallet snapshot normalization rejects missing financial fields', () => {
    const entityId = `0x${'44'.repeat(32)}`;
    const owner = `0x${'55'.repeat(20)}`;
    const tokenAddress = `0x${'61'.repeat(20)}`;
    const spender = `0x${'71'.repeat(20)}`;

    expect(() => rawEventToJEvents({
      name: 'ExternalWalletSnapshot',
      args: {
        entityId,
        owner,
        tokenBalances: [{ tokenAddress }],
      },
    } as any, entityId)).toThrow(/EXTERNAL_WALLET_SNAPSHOT_BALANCE_MISSING/);

    expect(() => rawEventToJEvents({
      name: 'ExternalWalletSnapshot',
      args: {
        entityId,
        owner,
        allowances: [{ tokenAddress, spender }],
      },
    } as any, entityId)).toThrow(/EXTERNAL_WALLET_SNAPSHOT_ALLOWANCE_MISSING/);
  });

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
    updateWatcherJurisdictionCursor(env, 30, '0xaaa');
    expect(getWatcherStartBlock(env, '0xaaa')).toBe(121);
  });

  test('watcher start block is capped by committed signer j-blocks when present', () => {
    const env = makeCursorEnv('jadapter-cursor-signer-jblock', [
      makeJReplica('Arrakis', 120n, '0xaaa'),
    ], 'Arrakis');
    const entityId = `0x${'64'.repeat(32)}`;
    const left = makeReplica(entityId, '1', true);
    const right = makeReplica(entityId, '2', false);
    left.state.lastFinalizedJHeight = 40;
    right.state.lastFinalizedJHeight = 45;
    env.eReplicas.set(`${entityId}:1`, left);
    env.eReplicas.set(`${entityId}:2`, right);

    expect(getMinimumCommittedSignerJHeight(env)).toBe(40);
    expect(getWatcherStartBlock(env, '0xaaa')).toBe(41);

    updateWatcherJurisdictionCursor(env, 30, '0xaaa');
    expect(getWatcherStartBlock(env, '0xaaa')).toBe(41);

    updateWatcherJurisdictionCursor(env, 200, '0xaaa');
    expect(getWatcherStartBlock(env, '0xaaa')).toBe(41);
  });

  test('watcher start block ignores signer j-blocks from unrelated jurisdictions', () => {
    const arrakis = makeJurisdiction('Arrakis', 31337, `0x${'aa'.repeat(20)}`);
    const wakanda = makeJurisdiction('Wakanda', 31338, `0x${'bb'.repeat(20)}`);
    const env = makeCursorEnv('jadapter-cursor-jurisdiction-scope', [
      makeJReplica(arrakis.name, 120n, arrakis.depositoryAddress),
      makeJReplica(wakanda.name, 80n, wakanda.depositoryAddress),
    ], arrakis.name);
    const arrakisEntity = `0x${'66'.repeat(32)}`;
    const wakandaEntity = `0x${'67'.repeat(32)}`;
    const arrakisLeft = makeReplica(arrakisEntity, '1', true);
    const arrakisRight = makeReplica(arrakisEntity, '2', false);
    const wakandaLeft = makeReplica(wakandaEntity, '1', true);
    const wakandaRight = makeReplica(wakandaEntity, '2', false);
    arrakisLeft.state.config.jurisdiction = arrakis;
    arrakisRight.state.config.jurisdiction = arrakis;
    wakandaLeft.state.config.jurisdiction = wakanda;
    wakandaRight.state.config.jurisdiction = wakanda;
    arrakisLeft.state.lastFinalizedJHeight = 100;
    arrakisRight.state.lastFinalizedJHeight = 110;
    wakandaLeft.state.lastFinalizedJHeight = 5;
    wakandaRight.state.lastFinalizedJHeight = 7;
    env.eReplicas.set(`${arrakisEntity}:1`, arrakisLeft);
    env.eReplicas.set(`${arrakisEntity}:2`, arrakisRight);
    env.eReplicas.set(`${wakandaEntity}:1`, wakandaLeft);
    env.eReplicas.set(`${wakandaEntity}:2`, wakandaRight);

    expect(getMinimumCommittedSignerJHeight(env)).toBe(5);
    expect(getWatcherStartBlock(env, arrakis.depositoryAddress)).toBe(101);
    expect(getWatcherStartBlock(env, wakanda.depositoryAddress)).toBe(6);
  });

  test('watcher cursor waits for relevant signer replicas to finalize their j-block', () => {
    const env = createEmptyEnv('jadapter-cursor-pending-jblock');
    const entityId = `0x${'65'.repeat(32)}`;
    const proposerSignerId = '1';
    const validatorSignerId = '2';
    const proposer = makeReplica(entityId, proposerSignerId, true);
    const validator = makeReplica(entityId, validatorSignerId, false);
    proposer.state.lastFinalizedJHeight = 8;
    validator.state.lastFinalizedJHeight = 8;
    env.eReplicas.set(`${entityId}:${proposerSignerId}`, proposer);
    env.eReplicas.set(`${entityId}:${validatorSignerId}`, validator);

    const rawEvents = [{
      name: 'ReserveUpdated',
      args: {
        entity: entityId,
        tokenId: 2,
        newBalance: 123n,
      },
      blockNumber: 10,
      blockHash: `0x${'66'.repeat(32)}`,
      transactionHash: `0x${'77'.repeat(32)}`,
      logIndex: 0,
    }];
    const replicaKeys = collectRelevantJEventReplicaKeys(env, rawEvents);
    const pending = new Map<number, Set<string>>();

    expect(replicaKeys).toEqual([`${entityId}:${proposerSignerId}`, `${entityId}:${validatorSignerId}`]);
    rememberPendingWatcherJBlock(pending, 10, replicaKeys);
    expect(resolveCommittedWatcherCursor(env, pending, 20, 8)).toBe(9);
    expect(pending.has(10)).toBe(true);

    proposer.state.lastFinalizedJHeight = 10;
    expect(resolveCommittedWatcherCursor(env, pending, 20, 9)).toBe(9);
    expect(pending.has(10)).toBe(true);

    validator.state.lastFinalizedJHeight = 10;
    expect(resolveCommittedWatcherCursor(env, pending, 20, 9)).toBe(20);
    expect(pending.has(10)).toBe(false);
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
    expect(queuedInputs.map((input) => input.entityTxs[0]?.data?.observedAt)).toEqual([7, 7]);
    expect(env.runtimeState?.wakeRequested).toBe(true);
  });

  test('J-event ingress transform replaces external block identity before signing', () => {
    const env = createEmptyEnv('jadapter-helper-trace-transform');
    const entityId = `0x${'46'.repeat(32)}`;
    env.eReplicas.set(`${entityId}:1`, makeReplica(entityId, '1', true));
    const recordedBlockHash = `0x${'88'.repeat(32)}`;
    const restore = setJEventIngressTransform((batch) => ({
      ...batch,
      blockNumber: 70,
      blockHash: recordedBlockHash,
      rawEvents: batch.rawEvents.map((event) => ({
        ...event,
        blockNumber: 70,
        blockHash: recordedBlockHash,
      })),
    }));

    try {
      processEventBatch(
        [{
          name: 'ReserveUpdated',
          args: { entity: entityId, tokenId: 2, newBalance: 123n },
          blockNumber: 7,
          blockHash: `0x${'66'.repeat(32)}`,
          transactionHash: `0x${'77'.repeat(32)}`,
          logIndex: 0,
        }],
        env,
        7,
        `0x${'66'.repeat(32)}`,
        { value: 0 },
        'trace-test',
      );
    } finally {
      restore();
    }

    const jEventData = env.runtimeMempool?.entityInputs?.[0]?.entityTxs?.[0]?.data;
    expect(jEventData?.blockNumber).toBe(70);
    expect(jEventData?.blockHash).toBe(recordedBlockHash);
    expect(jEventData?.observedAt).toBe(70);
  });

  test('buildJEventsRuntimeInput returns j_event input without enqueueing into runtime mempool', () => {
    const env = createEmptyEnv('jadapter-helper-build-input-seed');
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;

    const entityId = `0x${'45'.repeat(32)}`;
    const proposerSignerId = '1';
    const validatorSignerId = '2';
    env.eReplicas.set(`${entityId}:${proposerSignerId}`, makeReplica(entityId, proposerSignerId, true));
    env.eReplicas.set(`${entityId}:${validatorSignerId}`, makeReplica(entityId, validatorSignerId, false));

    const event = {
      name: 'ReserveUpdated',
      args: {
        entity: entityId,
        tokenId: 2,
        newBalance: 456n,
      },
      blockNumber: 8,
      blockHash: `0x${'67'.repeat(32)}`,
      transactionHash: `0x${'78'.repeat(32)}`,
      logIndex: 0,
    };
    const input = buildJEventsRuntimeInput(env, [event], 'test-build');
    env.timestamp = 9_999;
    const rebuiltInput = buildJEventsRuntimeInput(env, [event], 'test-build');

    expect(input?.timestamp).toBe(8);
    expect(rebuiltInput?.timestamp).toBe(8);
    expect(input?.runtimeTxs).toEqual([]);
    expect(input?.entityInputs).toHaveLength(2);
    expect(input?.entityInputs?.every((entry) => entry.entityId === entityId.toLowerCase())).toBe(true);
    expect(input?.entityInputs?.map((entry) => entry.signerId).sort()).toEqual([proposerSignerId, validatorSignerId].sort());
    expect(input?.entityInputs?.every((entry) => entry.entityTxs[0]?.type === 'j_event')).toBe(true);
    expect(input?.entityInputs?.map((entry) => entry.entityTxs[0]?.data?.observedAt)).toEqual([8, 8]);
    expect(rebuiltInput?.entityInputs?.map((entry) => entry.entityTxs[0]?.data?.observedAt)).toEqual([8, 8]);
    expect(env.runtimeMempool?.entityInputs ?? []).toEqual([]);
    expect(env.runtimeState?.wakeRequested).not.toBe(true);
  });

  test('watcher reserve evidence survives unrelated two-jurisdiction traffic', () => {
    const env = createEmptyEnv('jadapter-helper-reserve-evidence-seed');
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;

    const entityA = `0x${'71'.repeat(32)}`;
    const entityB = `0x${'72'.repeat(32)}`;
    const signerA = '1';
    const signerB = '2';
    env.eReplicas.set(`${entityA}:${signerA}`, makeReplica(entityA, signerA, true));
    env.eReplicas.set(`${entityB}:${signerB}`, makeReplica(entityB, signerB, true));

    processEventBatch(
      [{
        name: 'ReserveUpdated',
        args: {
          entity: entityA,
          tokenId: 2,
          newBalance: 500n,
        },
        blockNumber: 20,
        blockHash: `0x${'aa'.repeat(32)}`,
        transactionHash: `0x${'ab'.repeat(32)}`,
        logIndex: 0,
      }],
      env,
      20,
      `0x${'aa'.repeat(32)}`,
      { value: 0 },
      'jurisdiction-a',
    );

    processEventBatch(
      Array.from({ length: 1_100 }, (_, index) => ({
        name: 'ReserveUpdated',
        args: {
          entity: entityB,
          tokenId: 2,
          newBalance: BigInt(index + 1),
        },
        blockNumber: 21,
        blockHash: `0x${'bb'.repeat(32)}`,
        transactionHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
        logIndex: index,
      })),
      env,
      21,
      `0x${'bb'.repeat(32)}`,
      { value: 0 },
      'jurisdiction-b',
    );

    const reserveEvent = findRecentReserveUpdatedEvent(env, entityA, 2, 500n);
    expect(reserveEvent?.transactionHash).toBe(`0x${'ab'.repeat(32)}`);
    expect(findRecentReserveUpdatedEvent(env, entityA, 2, 501n)).toBeNull();
  });

  test('processEventBatch keeps same ERC20 transfer log deltas for both tracked external owners', () => {
    const env = createEmptyEnv('jadapter-helper-external-delta-dedup');
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;

    const leftEntityId = `0x${'51'.repeat(32)}`;
    const rightEntityId = `0x${'52'.repeat(32)}`;
    const leftSignerId = '1';
    const rightSignerId = '2';
    const tokenAddress = `0x${'61'.repeat(20)}`;
    const leftOwner = `0x${'71'.repeat(20)}`;
    const rightOwner = `0x${'72'.repeat(20)}`;
    env.eReplicas.set(`${leftEntityId}:${leftSignerId}`, makeReplica(leftEntityId, leftSignerId, true));
    env.eReplicas.set(`${rightEntityId}:${rightSignerId}`, makeReplica(rightEntityId, rightSignerId, true));

    processEventBatch(
      [
        {
          name: 'ExternalWalletDelta',
          args: {
            entityId: leftEntityId,
            owner: leftOwner,
            tokenAddress,
            tokenId: 3,
            balanceDelta: '-100',
          },
          blockNumber: 8,
          blockHash: `0x${'68'.repeat(32)}`,
          transactionHash: `0x${'78'.repeat(32)}`,
          logIndex: 4,
        },
        {
          name: 'ExternalWalletDelta',
          args: {
            entityId: rightEntityId,
            owner: rightOwner,
            tokenAddress,
            tokenId: 3,
            balanceDelta: '100',
          },
          blockNumber: 8,
          blockHash: `0x${'68'.repeat(32)}`,
          transactionHash: `0x${'78'.repeat(32)}`,
          logIndex: 4,
        },
      ],
      env,
      8,
      `0x${'68'.repeat(32)}`,
      { value: 0 },
      'test',
    );

    const queuedInputs = env.runtimeMempool?.entityInputs ?? [];
    expect(queuedInputs.length).toBe(2);
    expect(queuedInputs.map((input) => input.entityId).sort()).toEqual([leftEntityId, rightEntityId].sort());
    expect(queuedInputs.map((input) => input.entityTxs[0]?.type)).toEqual(['j_event', 'j_event']);
  });
});
