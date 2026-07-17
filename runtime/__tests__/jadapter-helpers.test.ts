import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { deriveSignerAddressSync } from '../account/crypto';
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
  findWatcherJurisdictionReplica,
  getWatcherStartBlock,
  getMinimumCommittedSignerJHeight,
  getMinimumScannedSignerJHeight,
  isWatcherJHistoryRangeDurable,
  processEventBatch,
  enqueueJHistoryRange,
  enqueueJHistoryRewindForReplicaKeys,
  isEntityReplicaRelevantToWatcher,
  rawEventToJEvents,
  rememberPendingWatcherJBlock,
  resolveCommittedWatcherCursor,
  setJEventIngressTransform,
  setJHistoryRangeIngressTransform,
  updateWatcherJurisdictionCursor,
} from '../jadapter/watcher';
import { findRecentReserveUpdatedEvent } from '../jurisdiction/event-evidence';
import { canonicalJurisdictionEventsHash } from '../jurisdiction/event-observation';
import {
  buildLocalJPrefixAttestation,
  mergeJPrefixAttestations,
} from '../jurisdiction/j-prefix-consensus';
import { recordValidatorJHistory } from '../jurisdiction/local-history';
import { createEmptyEnv } from '../runtime';
import { applyRuntimeTx } from '../machine/tx-handlers';
import type { EntityReplica, Env, JReplica, JurisdictionConfig } from '../types';

const makeJReplica = (
  name: string,
  blockNumber: bigint,
  depositoryAddress: string,
  chainId?: number,
  entityProviderAddress?: string,
): JReplica => ({
  name,
  blockNumber,
  depositoryAddress,
  ...(chainId !== undefined ? { chainId } : {}),
  ...(entityProviderAddress !== undefined ? { entityProviderAddress } : {}),
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
    expect(isTransientRpcUnavailableError(new Error('RPC_BATCH_HTTP_500'))).toBe(true);
    expect(isTransientRpcUnavailableError(
      new Error('J_HISTORY_HEADER_MISSING:height=34 error=none'),
    )).toBe(true);
    expect(isTransientRpcUnavailableError(
      new Error('J_HISTORY_FINALIZED_REORG:34'),
    )).toBe(false);
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
    const source = makeJReplica(
      'quiesce-source',
      0n,
      `0x${'41'.repeat(20)}`,
      31_337,
      `0x${'42'.repeat(20)}`,
    );
    env.jReplicas.set(source.name, source);
    env.runtimeState = { persistenceQuiescing: true } as Env['runtimeState'];
    const entityId = `0x${'44'.repeat(32)}`;
    const owner = `0x${'55'.repeat(20)}`;
    const txCounter = { value: 0 } as { value: number; _seenLogs?: unknown };

    expect(() => enqueueJHistoryRange(
      env,
      [],
      7,
      `0x${'66'.repeat(32)}`,
      source.depositoryAddress,
      [{ jHeight: 7, jBlockHash: `0x${'66'.repeat(32)}` }],
      source.chainId,
    )).toThrow(/J_EVENT_INGRESS_QUIESCING:history-range/);

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
    }], 'manual-snapshot', source)).toThrow(/J_EVENT_INGRESS_QUIESCING:manual-snapshot/);

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

  test('watcher cursor advances only when its authenticated RuntimeTx is applied', async () => {
    const env = makeCursorEnv('jadapter-cursor-update', [
      makeJReplica('Arrakis', 100n, '0xaaa'),
    ], 'Arrakis');

    expect(getWatcherStartBlock(env, '0xaaa')).toBe(101);
    updateWatcherJurisdictionCursor(env, 120, '0xaaa');
    expect(getWatcherStartBlock(env, '0xaaa')).toBe(101);
    const cursorTx = env.runtimeMempool?.runtimeTxs.find((tx) => tx.type === 'advanceJWatcherCursor');
    if (!cursorTx) throw new Error('J_WATCHER_CURSOR_RUNTIME_TX_MISSING');
    await applyRuntimeTx(env, cursorTx);
    expect(getWatcherStartBlock(env, '0xaaa')).toBe(121);
    updateWatcherJurisdictionCursor(env, 30, '0xaaa');
    expect(getWatcherStartBlock(env, '0xaaa')).toBe(121);
  });

  test('watcher cursor RuntimeTx is exact-stack scoped and rejects external ingress', async () => {
    const sharedDepository = `0x${'ab'.repeat(20)}`;
    const arrakis = makeJReplica('Arrakis', 100n, sharedDepository, 31337);
    const wakanda = makeJReplica('Wakanda', 200n, sharedDepository, 31338);
    const env = makeCursorEnv('jadapter-cursor-runtime-tx-scope', [arrakis, wakanda], 'Arrakis');

    updateWatcherJurisdictionCursor(env, 120, sharedDepository, 31337);
    const cursorTx = env.runtimeMempool?.runtimeTxs.find((tx) => tx.type === 'advanceJWatcherCursor');
    if (!cursorTx) throw new Error('J_WATCHER_CURSOR_RUNTIME_TX_MISSING');
    await applyRuntimeTx(env, cursorTx);

    expect(arrakis.blockNumber).toBe(120n);
    expect(wakanda.blockNumber).toBe(200n);
    await expect(applyRuntimeTx(env, {
      type: 'advanceJWatcherCursor',
      data: { depositoryAddress: sharedDepository, chainId: 31337, blockNumber: 121 },
    })).rejects.toThrow(/J_AUTHORITY_RUNTIME_TX_EXTERNAL_INGRESS_REJECTED:advanceJWatcherCursor/);
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

  test('durably rewinds only the restored pre-anchor replica whose registration base changed', async () => {
    const jurisdiction = {
      ...makeJurisdiction('Pre-anchor rewind', 31_337, `0x${'a1'.repeat(20)}`),
      entityProviderDeploymentBlock: 11,
      registrationBlock: 12,
    };
    const watcher = makeJReplica(
      jurisdiction.name,
      10n,
      jurisdiction.depositoryAddress!,
      jurisdiction.chainId,
      jurisdiction.entityProviderAddress,
    );
    const env = makeCursorEnv('jadapter-pre-anchor-rewind', [watcher], jurisdiction.name);
    const entityId = `0x${'65'.repeat(32)}`;
    const replica = makeReplica(entityId, '1', true);
    replica.state.config.jurisdiction = jurisdiction;
    replica.state.lastFinalizedJHeight = 10;
    const jurisdictionRef = `stack:${jurisdiction.chainId}:${jurisdiction.depositoryAddress}`;
    replica.jHistory = {
      jurisdictionRef,
      scannedThroughHeight: 10,
      contiguousThroughHeight: 10,
      tipBlockHash: `0x${'10'.repeat(32)}`,
      eventBlocks: new Map(),
      blockHashes: new Map([[10, `0x${'10'.repeat(32)}`]]),
    };
    const replicaKey = `${entityId}:1`;
    env.eReplicas.set(replicaKey, replica);
    const healthyEntityId = `0x${'66'.repeat(32)}`;
    const healthy = makeReplica(healthyEntityId, '2', true);
    healthy.state.config.jurisdiction = jurisdiction;
    healthy.state.lastFinalizedJHeight = 10;
    healthy.jHistory = {
      jurisdictionRef,
      scannedThroughHeight: 10,
      contiguousThroughHeight: 10,
      tipBlockHash: `0x${'20'.repeat(32)}`,
      eventBlocks: new Map(),
      blockHashes: new Map([[10, `0x${'20'.repeat(32)}`]]),
    };
    const healthyReplicaKey = `${healthyEntityId}:2`;
    env.eReplicas.set(healthyReplicaKey, healthy);

    expect(enqueueJHistoryRewindForReplicaKeys(
      env,
      10,
      `0x${'20'.repeat(32)}`,
      [replicaKey],
      jurisdiction.depositoryAddress,
      jurisdiction.chainId,
    )).toEqual([replicaKey]);
    expect(env.runtimeMempool?.runtimeTxs).toHaveLength(1);
    expect(env.runtimeMempool?.runtimeTxs[0]?.type).toBe('rewindJHistory');
    await applyRuntimeTx(env, env.runtimeMempool!.runtimeTxs[0]!);
    expect(replica.jHistory).toBeUndefined();
    expect(healthy.jHistory?.tipBlockHash).toBe(`0x${'20'.repeat(32)}`);
    expect(env.overlay).toContainEqual({ family: 'entity', entityId });
  });

  test('watcher start block ignores signer j-blocks from unrelated jurisdictions', () => {
    const arrakis = makeJurisdiction('Arrakis', 31337, `0x${'aa'.repeat(20)}`);
    const wakanda = makeJurisdiction('Wakanda', 31338, `0x${'bb'.repeat(20)}`);
    const env = makeCursorEnv('jadapter-cursor-jurisdiction-scope', [
      makeJReplica(arrakis.name, 120n, arrakis.depositoryAddress, arrakis.chainId, arrakis.entityProviderAddress),
      makeJReplica(wakanda.name, 80n, wakanda.depositoryAddress, wakanda.chainId, wakanda.entityProviderAddress),
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

  test('late replica catch-up starts after its contiguous authenticated prefix, not a sparse tip', () => {
    const jurisdiction = makeJurisdiction('Late replica', 31337, `0x${'ad'.repeat(20)}`);
    const watcher = makeJReplica(
      jurisdiction.name,
      436n,
      jurisdiction.depositoryAddress!,
      jurisdiction.chainId,
      jurisdiction.entityProviderAddress,
    );
    const env = makeCursorEnv('jadapter-late-replica-contiguous-prefix', [watcher], jurisdiction.name);
    const replica = makeReplica(`0x${'70'.repeat(32)}`, '1', true);
    replica.state.config.jurisdiction = jurisdiction;
    replica.state.lastFinalizedJHeight = 44;
    const jurisdictionRef = `stack:${jurisdiction.chainId}:${jurisdiction.depositoryAddress}`;
    const headerHash = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`;
    replica.state.jHistoryFinality = {
      jurisdictionRef,
      finalizedThroughHeight: 44,
      tipBlockHash: headerHash(44),
      eventHistoryRoot: `0x${'00'.repeat(32)}`,
    };
    replica.jHistory = {
      jurisdictionRef,
      scannedThroughHeight: 436,
      contiguousThroughHeight: 44,
      tipBlockHash: headerHash(436),
      eventBlocks: new Map(),
      blockHashes: new Map([
        [44, headerHash(44)],
        ...(
        Array.from({ length: 6 }, (_, index) => {
          const height = 431 + index;
          return [height, headerHash(height)] as const;
        })
        ),
      ]),
    };
    env.eReplicas.set(`${replica.entityId}:1`, replica);

    expect(getMinimumScannedSignerJHeight(env, watcher)).toBe(44);

    replica.jHistory = recordValidatorJHistory(replica.jHistory, {
      jurisdictionRef,
      scannedThroughHeight: 108,
      tipBlockHash: headerHash(108),
      headers: Array.from({ length: 64 }, (_, index) => ({
        jHeight: 45 + index,
        jBlockHash: headerHash(45 + index),
      })),
      blocks: [],
    }, replica.state);
    expect(getMinimumScannedSignerJHeight(env, watcher)).toBe(108);
  });

  test('watcher identity includes chainId when deterministic deployments share an address', () => {
    const sharedDepository = `0x${'aa'.repeat(20)}`;
    const arrakis = makeJurisdiction('Arrakis', 31337, sharedDepository);
    const wakanda = makeJurisdiction('Wakanda', 31338, sharedDepository);
    const arrakisJ = makeJReplica(
      arrakis.name,
      120n,
      sharedDepository,
      arrakis.chainId,
      arrakis.entityProviderAddress,
    );
    const wakandaJ = makeJReplica(
      wakanda.name,
      80n,
      sharedDepository,
      wakanda.chainId,
      wakanda.entityProviderAddress,
    );
    const env = makeCursorEnv('jadapter-cursor-shared-address', [arrakisJ, wakandaJ], arrakis.name);
    const arrakisEntity = makeReplica(`0x${'68'.repeat(32)}`, '1', true);
    const wakandaEntity = makeReplica(`0x${'69'.repeat(32)}`, '2', true);
    arrakisEntity.state.config.jurisdiction = arrakis;
    wakandaEntity.state.config.jurisdiction = wakanda;
    arrakisEntity.state.lastFinalizedJHeight = 100;
    wakandaEntity.state.lastFinalizedJHeight = 5;
    env.eReplicas.set(`${arrakisEntity.entityId}:1`, arrakisEntity);
    env.eReplicas.set(`${wakandaEntity.entityId}:2`, wakandaEntity);

    expect(isEntityReplicaRelevantToWatcher(env, arrakisEntity, arrakisJ)).toBe(true);
    expect(isEntityReplicaRelevantToWatcher(env, arrakisEntity, wakandaJ)).toBe(false);
    expect(isEntityReplicaRelevantToWatcher(env, wakandaEntity, arrakisJ)).toBe(false);
    expect(isEntityReplicaRelevantToWatcher(env, wakandaEntity, wakandaJ)).toBe(true);
    expect(getWatcherStartBlock(env, sharedDepository, 31337)).toBe(101);
    expect(getWatcherStartBlock(env, sharedDepository, 31338)).toBe(6);
    expect(() => getWatcherStartBlock(env, sharedDepository)).toThrow(/J_WATCHER_JURISDICTION_AMBIGUOUS/);
    expect(() => getWatcherStartBlock(env, sharedDepository, 31339)).toThrow(
      /J_WATCHER_JURISDICTION_NOT_FOUND:start-block/,
    );
    expect(() => enqueueJHistoryRange(
      env,
      [],
      121,
      `0x${'12'.repeat(32)}`,
      sharedDepository,
      [{ jHeight: 121, jBlockHash: `0x${'12'.repeat(32)}` }],
      31339,
    )).toThrow(/J_WATCHER_JURISDICTION_NOT_FOUND:history-range/);
    expect(arrakisEntity.jHistory).toBeUndefined();
    expect(wakandaEntity.jHistory).toBeUndefined();
  });

  test('watcher accepts a unique legacy replica without chainId but never guesses between duplicates', () => {
    const sharedDepository = `0x${'ac'.repeat(20)}`;
    const legacy = makeJReplica('Legacy', 40n, sharedDepository);
    const env = makeCursorEnv('jadapter-cursor-legacy-chain', [legacy], legacy.name);

    expect(findWatcherJurisdictionReplica(env, sharedDepository, 31337)).toBe(legacy);
    expect(getWatcherStartBlock(env, sharedDepository, 31337)).toBe(41);

    const duplicate = makeJReplica('Legacy Duplicate', 41n, sharedDepository);
    env.jReplicas.set(duplicate.name, duplicate);
    expect(findWatcherJurisdictionReplica(env, sharedDepository, 31337)).toBeNull();
    expect(() => getWatcherStartBlock(env, sharedDepository, 31337)).toThrow(
      /J_WATCHER_JURISDICTION_NOT_FOUND:start-block/,
    );
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

  test('semantic watcher event holds finality when its validator already signed the current round', () => {
    const seed = 'jadapter-current-round-finality-hold';
    const env = createEmptyEnv(seed);
    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const entityId = `0x${'75'.repeat(32)}`;
    const replicaKey = `${entityId}:${signerId}`;
    const jurisdiction = makeJurisdiction('Current round hold', 31337, `0x${'76'.repeat(20)}`);
    const jurisdictionRef = `stack:${jurisdiction.chainId}:${jurisdiction.depositoryAddress}`;
    const blockHash = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`;
    const replica = makeReplica(entityId, signerId, true);
    replica.state.config.jurisdiction = jurisdiction;
    replica.jHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 1,
      tipBlockHash: blockHash(1),
      headers: [{ jHeight: 1, jBlockHash: blockHash(1) }],
      blocks: [],
    }, replica.state);
    env.eReplicas.set(replicaKey, replica);

    const signedHead = buildLocalJPrefixAttestation(env, replica);
    if (!signedHead) throw new Error('TEST_CURRENT_J_PREFIX_ATTESTATION_MISSING');
    replica.jPrefixRound = mergeJPrefixAttestations(
      env,
      replica.state,
      undefined,
      new Map([[signerId, signedHead]]),
    );

    const jurisdictionEvents = [{
      type: 'ReserveUpdated' as const,
      data: { entity: entityId, tokenId: 1, newBalance: '42' },
      blockNumber: 2,
      blockHash: blockHash(2),
      transactionHash: `0x${'78'.repeat(32)}`,
      logIndex: 0,
    }];
    const observedEvent = {
      type: 'observeJRange' as const,
      data: {
        entityId,
        signerId,
        jurisdictionRef,
        scannedThroughHeight: 2,
        tipBlockHash: blockHash(2),
        blocks: [{
          jurisdictionRef,
          jHeight: 2,
          jBlockHash: blockHash(2),
          eventsHash: canonicalJurisdictionEventsHash(jurisdictionEvents),
          events: jurisdictionEvents,
        }],
      },
    };
    const range = enqueueJHistoryRange(
      env,
      [{ timestamp: 2, runtimeTxs: [observedEvent], entityInputs: [] }],
      2,
      blockHash(2),
      undefined,
      [{ jHeight: 2, jBlockHash: blockHash(2) }],
    );

    expect(range.scannedReplicaKeys).toEqual([replicaKey]);
    expect(range.finalityReplicaKeys).toEqual([replicaKey]);
    // A signer cannot replace its own current-round head. The independent
    // finality fence remains until the next round certifies this event block.
    expect(env.runtimeMempool?.entityInputs).toEqual([]);
    const pending = new Map<number, Set<string>>();
    rememberPendingWatcherJBlock(pending, 2, range.finalityReplicaKeys);
    expect(resolveCommittedWatcherCursor(env, pending, 2, 0)).toBe(1);
    expect(pending.has(2)).toBe(true);

    replica.state.lastFinalizedJHeight = 2;
    expect(resolveCommittedWatcherCursor(env, pending, 2, 1)).toBe(2);
    expect(pending.has(2)).toBe(false);
  });

  test('authenticated empty watcher progress never creates a global Entity-finality fence', () => {
    const seed = 'jadapter-empty-page-no-global-finality';
    const env = createEmptyEnv(seed);
    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const entityId = `0x${'79'.repeat(32)}`;
    const replicaKey = `${entityId}:${signerId}`;
    const jurisdiction = makeJurisdiction('Empty page', 31337, `0x${'7a'.repeat(20)}`);
    const blockHash = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`;
    const replica = makeReplica(entityId, signerId, true);
    replica.state.config.jurisdiction = jurisdiction;
    env.eReplicas.set(replicaKey, replica);

    const range = enqueueJHistoryRange(
      env,
      [],
      100,
      blockHash(100),
      undefined,
      Array.from({ length: 100 }, (_, index) => ({
        jHeight: index + 1,
        jBlockHash: blockHash(index + 1),
      })),
    );

    expect(range.scannedReplicaKeys).toEqual([replicaKey]);
    expect(range.finalityReplicaKeys).toEqual([]);
    expect(env.runtimeMempool?.entityInputs[0]?.jPrefixAttestations?.size).toBe(1);
    const pending = new Map<number, Set<string>>();
    rememberPendingWatcherJBlock(pending, 100, range.finalityReplicaKeys);
    expect(resolveCommittedWatcherCursor(env, pending, 100, 0)).toBe(100);
  });

  test('watcher does not enqueue the next authenticated page before the prior local scan is durable', () => {
    const env = createEmptyEnv('jadapter-pending-local-scan');
    const entityId = `0x${'45'.repeat(32)}`;
    const replica = makeReplica(entityId, '1', true);
    const replicaKey = `${entityId}:1`;
    env.eReplicas.set(replicaKey, replica);
    const pending = {
      fromBlock: 1,
      toBlock: 10,
      tipBlockHash: `0x${'10'.repeat(32)}`,
      replicaKeys: new Set([replicaKey]),
    };
    expect(isWatcherJHistoryRangeDurable(env, pending)).toBe(false);

    replica.jHistory = {
      jurisdictionRef: 'chain:31337:0xdepository',
      scannedThroughHeight: 9,
      contiguousThroughHeight: 9,
      tipBlockHash: `0x${'09'.repeat(32)}`,
      eventBlocks: new Map(),
      blockHashes: new Map([[9, `0x${'09'.repeat(32)}`]]),
    };
    expect(isWatcherJHistoryRangeDurable(env, pending)).toBe(false);

    replica.jHistory.scannedThroughHeight = 100;
    replica.jHistory.tipBlockHash = `0x${'64'.repeat(32)}`;
    replica.jHistory.blockHashes.set(100, `0x${'64'.repeat(32)}`);
    expect(isWatcherJHistoryRangeDurable(env, pending)).toBe(false);

    replica.jHistory.blockHashes.set(10, `0x${'10'.repeat(32)}`);
    expect(isWatcherJHistoryRangeDurable(env, pending)).toBe(true);

    expect(() => isWatcherJHistoryRangeDurable(env, {
      ...pending,
      tipBlockHash: `0x${'11'.repeat(32)}`,
    })).toThrow(
      /J_WATCHER_PENDING_SCAN_TIP_CONFLICT:10/,
    );
  });

  test('watcher releases a pending page superseded by a higher Entity-certified anchor', () => {
    const env = createEmptyEnv('jadapter-pending-page-certified-past-tip');
    const entityId = `0x${'46'.repeat(32)}`;
    const replica = makeReplica(entityId, '1', true);
    const replicaKey = `${entityId}:1`;
    const jurisdictionRef = 'stack:31337:0xdepository';
    replica.state.lastFinalizedJHeight = 20;
    replica.state.jHistoryFinality = {
      jurisdictionRef,
      baseHeight: 0,
      finalizedThroughHeight: 20,
      tipBlockHash: `0x${'20'.repeat(32)}`,
      eventHistoryRoot: `0x${'00'.repeat(32)}`,
      proposerSignerId: '1',
      proposerSignature: '0xtest',
      entityHeight: 1,
    };
    replica.jHistory = {
      jurisdictionRef,
      scannedThroughHeight: 100,
      contiguousThroughHeight: 20,
      tipBlockHash: `0x${'64'.repeat(32)}`,
      eventBlocks: new Map(),
      blockHashes: new Map([
        [20, `0x${'20'.repeat(32)}`],
        [100, `0x${'64'.repeat(32)}`],
      ]),
    };
    env.eReplicas.set(replicaKey, replica);

    expect(isWatcherJHistoryRangeDurable(env, {
      fromBlock: 1,
      toBlock: 10,
      tipBlockHash: `0x${'10'.repeat(32)}`,
      replicaKeys: new Set([replicaKey]),
    })).toBe(true);
  });

  test('processEventBatch durably fans out sparse observations and defers unsigned prefix heads', () => {
    const env = createEmptyEnv('jadapter-helper-delivery-seed');
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;

    const entityId = `0x${'44'.repeat(32)}`;
    const proposerSignerId = '1';
    const validatorSignerId = '2';
    const proposer = makeReplica(entityId, proposerSignerId, true);
    const validator = makeReplica(entityId, validatorSignerId, false);
    const board = {
      mode: 'proposer-based' as const,
      threshold: 2n,
      validators: [proposerSignerId, validatorSignerId],
      shares: { [proposerSignerId]: 1n, [validatorSignerId]: 1n },
    };
    proposer.state.config = board;
    validator.state.config = board;
    env.eReplicas.set(`${entityId}:${proposerSignerId}`, proposer);
    env.eReplicas.set(`${entityId}:${validatorSignerId}`, validator);

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

    const observations = env.runtimeMempool?.runtimeTxs.filter((tx) => tx.type === 'observeJRange') ?? [];
    expect(observations).toHaveLength(2);
    expect(observations.map((tx) => tx.data.entityId)).toEqual([entityId, entityId]);
    expect(observations.map((tx) => tx.data.signerId)).toEqual([proposerSignerId, validatorSignerId]);
    expect(observations.map((tx) => tx.data.scannedThroughHeight)).toEqual([7, 7]);
    expect(observations.map((tx) => tx.data.blocks[0]?.events[0]?.logIndex)).toEqual([0, 0]);
    // H7 without authenticated H1..H6 is durable local evidence, but it is
    // not a signable exact prefix. Validators must not invent the gap.
    expect(env.runtimeMempool?.entityInputs ?? []).toEqual([]);
    expect(env.runtimeState?.wakeRequested).toBe(true);
  });

  test('deferred watcher event stays out of the mempool until its authenticated prefix is queued atomically', async () => {
    const env = createEmptyEnv('jadapter-deferred-event-prefix-atomicity');
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;
    const entityId = `0x${'48'.repeat(32)}`;
    const signerId = '1';
    env.eReplicas.set(`${entityId}:${signerId}`, makeReplica(entityId, signerId, true));
    const blockHash = (height: number): string =>
      `0x${height.toString(16).padStart(64, '0')}`;

    const observedInput = processEventBatch(
      [{
        name: 'ReserveUpdated',
        args: { entity: entityId, tokenId: 2, newBalance: 123n },
        blockNumber: 7,
        blockHash: blockHash(7),
        transactionHash: `0x${'79'.repeat(32)}`,
        logIndex: 0,
      }],
      env,
      7,
      blockHash(7),
      { value: 0 },
      'rpc-atomic-prefix',
      undefined,
      true,
      'chain',
    );

    expect(observedInput).not.toBeNull();
    expect(env.runtimeMempool?.runtimeTxs ?? []).toEqual([]);
    expect(env.runtimeMempool?.entityInputs ?? []).toEqual([]);

    enqueueJHistoryRange(
      env,
      [observedInput!],
      7,
      blockHash(7),
      undefined,
      Array.from({ length: 7 }, (_, index) => ({
        jHeight: index + 1,
        jBlockHash: blockHash(index + 1),
      })),
    );

    const observations = env.runtimeMempool?.runtimeTxs.filter((tx) => tx.type === 'observeJRange') ?? [];
    expect(observations).toHaveLength(2);
    expect(observations[0]?.data.blocks[0]?.jHeight).toBe(7);
    expect(observations[1]?.data.headers?.map((header) => header.jHeight)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const attestation = env.runtimeMempool?.entityInputs[0]?.jPrefixAttestations?.get(signerId);
    expect(attestation?.scannedThroughHeight).toBe(7);
    expect(attestation?.headers.map((header) => header.jHeight)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(env.runtimeState?.wakeRequested).toBe(true);

    for (const tx of env.runtimeMempool?.runtimeTxs ?? []) await applyRuntimeTx(env, tx);
    const history = env.eReplicas.get(`${entityId}:${signerId}`)?.jHistory;
    expect(history?.contiguousThroughHeight).toBe(7);
    expect(history?.eventBlocks.get(7)?.events[0]?.type).toBe('ReserveUpdated');
  });

  test('sparse semantic event waits for its exact contiguous prefix instead of certifying empty catch-up pages', async () => {
    const env = createEmptyEnv('jadapter-sparse-event-no-empty-entity-frames');
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;
    const entityId = `0x${'58'.repeat(32)}`;
    const signerId = '1';
    env.eReplicas.set(`${entityId}:${signerId}`, makeReplica(entityId, signerId, true));
    const blockHash = (height: number): string =>
      `0x${height.toString(16).padStart(64, '0')}`;

    const observedInput = processEventBatch(
      [{
        name: 'ReserveUpdated',
        args: { entity: entityId, tokenId: 2, newBalance: 123n },
        blockNumber: 7,
        blockHash: blockHash(7),
        transactionHash: `0x${'89'.repeat(32)}`,
        logIndex: 0,
      }],
      env,
      7,
      blockHash(7),
      { value: 0 },
      'rpc-sparse-prefix',
      undefined,
      true,
      'chain',
    );
    if (!observedInput) throw new Error('TEST_SPARSE_EVENT_OBSERVATION_MISSING');

    enqueueJHistoryRange(
      env,
      [observedInput],
      3,
      blockHash(3),
      undefined,
      [1, 2, 3].map(jHeight => ({ jHeight, jBlockHash: blockHash(jHeight) })),
    );

    expect(
      env.runtimeMempool?.entityInputs ?? [],
      'H1..H3 are empty catch-up headers; the semantic H7 event is not attestable yet',
    ).toEqual([]);
    for (const tx of env.runtimeMempool?.runtimeTxs ?? []) await applyRuntimeTx(env, tx);
    env.runtimeMempool!.runtimeTxs = [];
    env.runtimeMempool!.entityInputs = [];
    const partialHistory = env.eReplicas.get(`${entityId}:${signerId}`)?.jHistory;
    expect(partialHistory?.contiguousThroughHeight).toBe(3);
    expect(partialHistory?.eventBlocks.has(7)).toBe(true);

    enqueueJHistoryRange(
      env,
      [],
      7,
      blockHash(7),
      undefined,
      [4, 5, 6, 7].map(jHeight => ({ jHeight, jBlockHash: blockHash(jHeight) })),
    );
    const attestation = env.runtimeMempool?.entityInputs[0]?.jPrefixAttestations?.get(signerId);
    expect(attestation?.scannedThroughHeight).toBe(7);
    expect(attestation?.blocks.map(block => block.blockNumber)).toEqual([7]);
  });

  test('chain watcher rejects a Solidity event that lost its EVM log index', () => {
    const env = createEmptyEnv('jadapter-chain-log-order');
    const entityId = `0x${'49'.repeat(32)}`;
    env.eReplicas.set(`${entityId}:1`, makeReplica(entityId, '1', true));

    expect(() => processEventBatch(
      [{
        name: 'ReserveUpdated',
        args: { entity: entityId, tokenId: 2, newBalance: 123n },
        blockNumber: 7,
        blockHash: `0x${'66'.repeat(32)}`,
        transactionHash: `0x${'77'.repeat(32)}`,
      }],
      env,
      7,
      `0x${'66'.repeat(32)}`,
      { value: 0 },
      'rpc-test',
      undefined,
      false,
      'chain',
    )).toThrow('J_EVENT_CHAIN_LOG_INDEX_MISSING:rpc-test:ReserveUpdated');
  });

  test('J-event ingress transform replaces external block identity before durable observation', () => {
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

    const observation = env.runtimeMempool?.runtimeTxs?.find((tx) => tx.type === 'observeJRange');
    expect(observation?.type).toBe('observeJRange');
    if (observation?.type !== 'observeJRange') throw new Error('transformed J observation missing');
    expect(observation.data.blocks[0]?.jHeight).toBe(70);
    expect(observation.data.blocks[0]?.jBlockHash).toBe(recordedBlockHash);
    expect(observation.data.scannedThroughHeight).toBe(70);
    expect(observation.data.tipBlockHash).toBe(recordedBlockHash);
    expect(env.runtimeMempool?.entityInputs ?? []).toEqual([]);
  });

  test('J-history range ingress transform replaces external tip identity before signing', () => {
    const env = createEmptyEnv('jadapter-range-trace-transform');
    const entityId = `0x${'47'.repeat(32)}`;
    env.eReplicas.set(`${entityId}:1`, makeReplica(entityId, '1', true));
    const recordedTipHash = `0x${'99'.repeat(32)}`;
    const restore = setJHistoryRangeIngressTransform(() => ({
      scannedThroughHeight: 180,
      tipBlockHash: recordedTipHash,
      headers: [{ jHeight: 180, jBlockHash: recordedTipHash }],
    }));

    try {
      enqueueJHistoryRange(env, [], 180, `0x${'77'.repeat(32)}`);
    } finally {
      restore();
    }

    const observation = env.runtimeMempool?.runtimeTxs?.find((tx) => tx.type === 'observeJRange');
    expect(observation?.type).toBe('observeJRange');
    if (observation?.type !== 'observeJRange') throw new Error('transformed J range observation missing');
    expect(observation.data.scannedThroughHeight).toBe(180);
    expect(observation.data.tipBlockHash).toBe(recordedTipHash);
    expect(observation.data.headers).toEqual([{ jHeight: 180, jBlockHash: recordedTipHash }]);
    const localHistory = env.eReplicas.get(`${entityId}:1`)?.jHistory;
    expect(localHistory?.blockHashes.get(180)).toBeUndefined();
    expect(env.runtimeMempool?.entityInputs ?? []).toEqual([]);
  });

  test('buildJEventsRuntimeInput returns durable sparse observations without enqueueing', () => {
    const env = createEmptyEnv('jadapter-helper-build-input-seed');
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;
    const jurisdiction = makeJurisdiction('build-input', 31_337, `0x${'46'.repeat(20)}`);
    const source = makeJReplica(
      jurisdiction.name,
      0n,
      jurisdiction.depositoryAddress!,
      jurisdiction.chainId,
      jurisdiction.entityProviderAddress,
    );
    env.jReplicas.set(source.name, source);

    const entityId = `0x${'45'.repeat(32)}`;
    const proposerSignerId = '1';
    const validatorSignerId = '2';
    const proposer = makeReplica(entityId, proposerSignerId, true);
    const validator = makeReplica(entityId, validatorSignerId, false);
    const board = {
      mode: 'proposer-based' as const,
      threshold: 2n,
      validators: [proposerSignerId, validatorSignerId],
      shares: { [proposerSignerId]: 1n, [validatorSignerId]: 1n },
    };
    proposer.state.config = { ...board, jurisdiction };
    validator.state.config = { ...board, jurisdiction };
    env.eReplicas.set(`${entityId}:${proposerSignerId}`, proposer);
    env.eReplicas.set(`${entityId}:${validatorSignerId}`, validator);

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
    const input = buildJEventsRuntimeInput(env, [event], 'test-build', source);
    env.timestamp = 9_999;
    const rebuiltInput = buildJEventsRuntimeInput(env, [event], 'test-build', source);

    expect(input?.timestamp).toBe(8);
    expect(rebuiltInput?.timestamp).toBe(8);
    const observations = input?.runtimeTxs.filter((tx) => tx.type === 'observeJRange') ?? [];
    const rebuiltObservations = rebuiltInput?.runtimeTxs.filter((tx) => tx.type === 'observeJRange') ?? [];
    expect(observations).toHaveLength(2);
    expect(observations.map((tx) => tx.data.entityId)).toEqual([entityId, entityId]);
    expect(observations.map((tx) => tx.data.signerId)).toEqual([proposerSignerId, validatorSignerId]);
    expect(observations.map((tx) => tx.data.blocks[0]?.jHeight)).toEqual([8, 8]);
    expect(rebuiltObservations.map((tx) => tx.data.blocks[0]?.jHeight)).toEqual([8, 8]);
    expect(input?.entityInputs).toEqual([]);
    expect(rebuiltInput?.entityInputs).toEqual([]);
    expect(env.runtimeMempool?.entityInputs ?? []).toEqual([]);
    expect(env.runtimeState?.wakeRequested).not.toBe(true);
  });

  test('receipt events never advance an unobserved entity on another jurisdiction', () => {
    const sharedDepository = `0x${'aa'.repeat(20)}`;
    const testnet = makeJurisdiction('Testnet', 31337, sharedDepository);
    const tron = makeJurisdiction('Tron', 31338, sharedDepository);
    const testnetSource = makeJReplica(
      testnet.name,
      120n,
      sharedDepository,
      testnet.chainId,
      testnet.entityProviderAddress,
    );
    const tronSource = makeJReplica(
      tron.name,
      120n,
      sharedDepository,
      tron.chainId,
      tron.entityProviderAddress,
    );
    const env = makeCursorEnv('jadapter-receipt-jurisdiction-scope', [testnetSource, tronSource]);
    const testnetEntityId = `0x${'73'.repeat(32)}`;
    const tronEntityId = `0x${'74'.repeat(32)}`;
    const testnetReplica = makeReplica(testnetEntityId, '1', true);
    const tronReplica = makeReplica(tronEntityId, '2', true);
    testnetReplica.state.config.jurisdiction = testnet;
    tronReplica.state.config.jurisdiction = tron;
    env.eReplicas.set(`${testnetEntityId}:1`, testnetReplica);
    env.eReplicas.set(`${tronEntityId}:2`, tronReplica);

    const input = buildJEventsRuntimeInput(env, [{
      name: 'ReserveUpdated',
      args: { entity: testnetEntityId, tokenId: 1, newBalance: 10n },
      blockNumber: 120,
      blockHash: `0x${'37'.repeat(32)}`,
      transactionHash: `0x${'75'.repeat(32)}`,
      logIndex: 0,
    }], 'testnet-receipt', testnetSource);

    const observed = input?.runtimeTxs.filter((tx) => tx.type === 'observeJRange') ?? [];
    expect(observed.map((tx) => tx.data.entityId)).toEqual([testnetEntityId]);
    expect(input?.entityInputs).toEqual([]);
    expect(observed.some((tx) => tx.data.entityId === tronEntityId)).toBe(false);
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

    const observations = env.runtimeMempool?.runtimeTxs.filter((tx) => tx.type === 'observeJRange') ?? [];
    expect(observations).toHaveLength(2);
    expect(observations.map((tx) => tx.data.entityId).sort()).toEqual([leftEntityId, rightEntityId].sort());
    expect(observations.map((tx) => tx.data.blocks[0]?.events[0]?.logIndex)).toEqual([4, 4]);
    expect(env.runtimeMempool?.entityInputs ?? []).toEqual([]);
  });
});
