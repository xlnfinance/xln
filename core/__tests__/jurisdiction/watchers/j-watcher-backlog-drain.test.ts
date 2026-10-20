import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';

import { createEmptyEnv, processRuntime } from '../../../runtime';
import { safeStringify } from '../../../protocol/serialization';
import { deriveSignerAddressSync, getSignerPrivateKey } from '../../../account/crypto';
import { encodeSingleSignerBoard, generateLazyEntityId, hashBoard } from '../../../entity/factory';
import { createJAdapter, createXlnJsonRpcProvider, type JAdapter } from '../../../jurisdiction/adapter';
import { getWatcherStartBlock } from '../../../jurisdiction/adapter/watcher';
import { createJReplica, createJurisdictionConfig } from '../../../scenarios/harness/boot';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../../../jurisdiction/machine/board-registry';
import {
  commitRuntimeInput,
  ensureSignerKeysFromSeed,
  processJEvents,
  setScenarioStorageEnabled,
} from '../../../scenarios/harness/helpers';
import {
  buildCanonicalEntityReplicaSnapshot,
  buildDurableRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../../../storage/wal/snapshot';
import { attachLiveJAdapter } from '../../../runtime/j-submit/live-jadapters';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';

const CHAIN_ID = 31_337;
const RUNTIME_SEED = 'j-watcher-backlog-drain';
const SIGNER_ID = deriveSignerAddressSync(RUNTIME_SEED, '2').toLowerCase();
const LATE_SIGNER_ID = deriveSignerAddressSync(RUNTIME_SEED, '3').toLowerCase();
const TOKEN_ID = 1;
const RESERVE_AMOUNT = 123_456n;

const singleSignerEncodedBoard = (privateKey: Uint8Array): string =>
  encodeSingleSignerBoard(new ethers.Wallet(ethers.hexlify(privateKey)).address);

type ManagedAnvil = {
  child: ChildProcessWithoutNullStreams;
  rpcUrl: string;
  tmpRoot: string;
  output: string;
};

type RpcGateControl = {
  entered: Promise<void>;
  release(): void;
};

type RpcGateProxy = {
  rpcUrl: string;
  armBlockNumberGate(): RpcGateControl;
  armHeaderBatchGate(status?: 429 | 'missing-header'): RpcGateControl;
  takeHeaderBlocks(): number[];
  close(): Promise<void>;
};

let managedAnvil: ManagedAnvil | null = null;
let adapter: JAdapter | null = null;
let rpcProxy: RpcGateProxy | null = null;

const reservePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('J_WATCHER_BACKLOG_PORT_RESERVATION_FAILED'));
        return;
      }
      server.close(error => (error ? reject(error) : resolve(address.port)));
    });
  });

const waitForRpc = async (managed: ManagedAnvil): Promise<void> => {
  const provider = createXlnJsonRpcProvider(managed.rpcUrl);
  let lastError = 'not ready';
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const network = await provider.getNetwork();
      if (network.chainId === BigInt(CHAIN_ID)) {
        await provider.destroy();
        return;
      }
      lastError = `chainId=${network.chainId.toString()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(50);
  }
  await provider.destroy();
  throw new Error(`J_WATCHER_BACKLOG_RPC_NOT_READY:${lastError}\nanvil=${managed.output}`);
};

const startAnvil = async (): Promise<ManagedAnvil> => {
  const port = await reservePort();
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xln-j-watcher-backlog-'));
  const child = spawn(
    'anvil',
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--chain-id',
      String(CHAIN_ID),
      '--block-gas-limit',
      '60000000',
      '--prune-history',
      '1024',
      '--silent',
      '--state',
      join(tmpRoot, 'state.json'),
    ],
    { env: { ...process.env, TMPDIR: tmpRoot } },
  );
  const managed: ManagedAnvil = {
    child,
    rpcUrl: `http://127.0.0.1:${port}`,
    tmpRoot,
    output: '',
  };
  // Anvil emits RPC/mining logs even with --silent. An unread stdout pipe
  // fills during the long backlog and blocks the actual mining RPC forever.
  const captureOutput = (chunk: Buffer): void => {
    managed.output += chunk.toString();
  };
  child.stderr.on('data', captureOutput);
  child.stdout.on('data', captureOutput);
  await waitForRpc(managed);
  return managed;
};

const startRpcGateProxy = (upstreamUrl: string): RpcGateProxy => {
  let armedGate: { target: 'block-number' | 'headers'; status?: 429 | 'missing-header' } | null = null;
  let enteredResolve: (() => void) | null = null;
  let releasePromise: Promise<void> | null = null;
  let releaseResolve: (() => void) | null = null;
  const headerBlocks: number[] = [];
  const armGate = (target: 'block-number' | 'headers', status?: 429 | 'missing-header'): RpcGateControl => {
    if (armedGate || releasePromise) throw new Error('J_WATCHER_RPC_GATE_ALREADY_ARMED');
    armedGate = { target, ...(status === undefined ? {} : { status }) };
    const entered = new Promise<void>(resolve => {
      enteredResolve = resolve;
    });
    releasePromise = new Promise<void>(resolve => {
      releaseResolve = resolve;
    });
    return {
      entered,
      release() {
        const resolve = releaseResolve;
        if (!resolve) throw new Error('J_WATCHER_RPC_GATE_NOT_ARMED');
        armedGate = null;
        releaseResolve = null;
        releasePromise = null;
        enteredResolve = null;
        resolve();
      },
    };
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.text();
      type RpcCall = { id: number; method?: string; params?: unknown[] };
      const payload = JSON.parse(body) as RpcCall | RpcCall[];
      const methods = Array.isArray(payload) ? payload.map(entry => entry.method) : [payload.method];
      const headerBatch =
        Array.isArray(payload) && payload.length > 1 && payload.every(entry => entry.method === 'eth_getBlockByNumber');
      if (headerBatch) {
        for (const entry of payload) {
          const height = entry.params?.[0];
          if (typeof height !== 'string' || !/^0x[0-9a-f]+$/i.test(height)) {
            throw new Error('J_WATCHER_RPC_HEADER_HEIGHT_INVALID');
          }
          headerBlocks.push(Number(BigInt(height)));
        }
      }
      const gate = armedGate;
      if (gate && (gate.target === 'headers' ? headerBatch : methods.includes('eth_blockNumber'))) {
        armedGate = null;
        enteredResolve?.();
        if (!releasePromise) throw new Error('J_WATCHER_RPC_GATE_RELEASE_MISSING');
        await releasePromise;
        if (gate.status === 429) return new Response('Too Many Requests', { status: 429 });
        if (gate.status === 'missing-header' && Array.isArray(payload)) {
          return Response.json(
            payload.map(entry => ({
              jsonrpc: '2.0',
              id: entry.id,
              error: { code: -32000, message: `block not found with number ${entry.params?.[0]}` },
            })),
          );
        }
      }
      return await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    },
  });
  return {
    rpcUrl: `http://127.0.0.1:${server.port}`,
    armBlockNumberGate: () => armGate('block-number'),
    armHeaderBatchGate: status => armGate('headers', status),
    takeHeaderBlocks: () => headerBlocks.splice(0),
    async close(): Promise<void> {
      await server.stop(true);
    },
  };
};

const stopAnvil = async (managed: ManagedAnvil): Promise<void> => {
  if (managed.child.exitCode === null && managed.child.signalCode === null) {
    const exited = new Promise<void>(resolve => managed.child.once('exit', () => resolve()));
    managed.child.kill('SIGTERM');
    const graceful = await Promise.race([exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
    if (!graceful && managed.child.exitCode === null && managed.child.signalCode === null) {
      managed.child.kill('SIGKILL');
      await exited;
    }
  }
  await rm(managed.tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
};

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  try {
    if (adapter) await adapter.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (rpcProxy) await rpcProxy.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (managedAnvil) await stopAnvil(managedAnvil);
  } catch (error) {
    cleanupErrors.push(error);
  }
  adapter = null;
  rpcProxy = null;
  managedAnvil = null;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'J_WATCHER_BACKLOG_CLEANUP_FAILED');
});

describe('RPC J-watcher backlog drain', () => {
  test.each([
    {
      name: 'delivers an authenticated event beyond 4096 historical blocks before returning',
      backlogBlocks: 4700,
      pressure: false,
    },
    {
      name: 'retains RPC pressure and recovers authenticated progress below the checkpoint interval',
      backlogBlocks: 1200,
      pressure: true,
    },
  ])(
    '$name',
    async ({ backlogBlocks, pressure }) => {
      managedAnvil = await startAnvil();
      rpcProxy = startRpcGateProxy(managedAnvil.rpcUrl);
      adapter = await createJAdapter({ mode: 'rpc', chainId: CHAIN_ID, rpcUrl: rpcProxy.rpcUrl, watchPollMs: 100 });
      await adapter.deployStack();

      const env = createEmptyEnv(RUNTIME_SEED);
      env.scenarioMode = true;
      env.state.timestamp = 1;
      setScenarioStorageEnabled(env, false);
      ensureSignerKeysFromSeed(env, ['2', '3'], RUNTIME_SEED);

      const jurisdictionName = 'Backlog Drain';
      const jReplica = createJReplica(env, jurisdictionName, adapter.addresses.depository);
      jReplica.contracts = { ...jReplica.contracts, depository: adapter.addresses.depository };
      jReplica.contracts = { ...jReplica.contracts, entityProvider: adapter.addresses.entityProvider };
      jReplica.chainId = CHAIN_ID;
      jReplica.watcherConfirmationDepth = 0;
      jReplica.rpcs = [managedAnvil.rpcUrl];
      jReplica.contracts = { ...adapter.addresses };
      attachLiveJAdapter(env, jurisdictionName, adapter);
      adapter.startWatching(env);

      const jurisdiction = createJurisdictionConfig(
        jurisdictionName,
        adapter.addresses.depository,
        adapter.addresses.entityProvider,
        managedAnvil.rpcUrl,
        CHAIN_ID,
      );
      const signerPrivateKey = getSignerPrivateKey(env, SIGNER_ID);
      const registeredEncodedBoard = singleSignerEncodedBoard(signerPrivateKey);
      const registeredBoardHash = hashBoard(registeredEncodedBoard);
      const nextEntityNumber = await adapter.entityProvider.nextNumber();
      const registerReceipt = await (
        await adapter.entityProvider.registerNumberedEntitiesBatch([registeredEncodedBoard])
      ).wait();
      if (!registerReceipt || registerReceipt.status !== 1) {
        throw new Error('J_WATCHER_BACKLOG_ENTITY_REGISTRATION_FAILED');
      }
      const registeredEntityId = ethers.zeroPadValue(ethers.toBeHex(nextEntityNumber), 32).toLowerCase();
      const signerAddress = new ethers.Wallet(ethers.hexlify(signerPrivateKey)).address;
      const entityId = generateLazyEntityId([signerAddress], 1n).toLowerCase();
      await commitRuntimeInput(env, {
        runtimeTxs: [
          createTestEntityImportRuntimeTx(env, {
            entityId,
            signerId: SIGNER_ID,
            data: {
              isProposer: true,
              config: {
                mode: 'proposer-based',
                threshold: 1n,
                validators: [SIGNER_ID],
                shares: { [SIGNER_ID]: 1n },
                jurisdiction,
              },
            },
          }),
        ],
        entityInputs: [],
      });

      const provider = adapter.provider as ethers.JsonRpcProvider;
      await provider.send('anvil_mine', [ethers.toQuantity(backlogBlocks)]);
      const receiptEvents = await adapter.debugFundReserves(entityId, TOKEN_ID, RESERVE_AMOUNT);
      const reserveEvent = receiptEvents.find(event => event.name === 'ReserveUpdated');
      expect(Number(reserveEvent?.blockNumber ?? 0)).toBeGreaterThan(backlogBlocks);

      const pollWatcher = adapter.pollNow?.bind(adapter);
      const readScanProgress = adapter.getWatcherScanProgress?.bind(adapter);
      if (!pollWatcher || !readScanProgress) throw new Error('J_WATCHER_BACKLOG_POLL_API_MISSING');
      const isWatching = adapter.isWatching.bind(adapter);
      const takeHeaderBlocks = rpcProxy.takeHeaderBlocks;
      const waitForGate = async (stage: string, gate: RpcGateControl, poll?: Promise<void>): Promise<void> => {
        let timer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<{ status: 'timed-out' }>(resolve => {
          timer = setTimeout(() => resolve({ status: 'timed-out' }), 5_000);
        });
        const result = await Promise.race([
          gate.entered.then(() => ({ status: 'entered' }) as const),
          ...(poll
            ? [
                poll.then(
                  () => ({ status: 'resolved' }) as const,
                  (error: unknown) => ({ status: 'rejected', error }) as const,
                ),
              ]
            : []),
          deadline,
        ]).finally(() => clearTimeout(timer));
        if (result.status === 'entered') return;
        gate.release();
        throw new Error(
          `J_WATCHER_BACKLOG_GATE_NOT_REACHED:${stage}:${safeStringify({
            poll: result.status,
            scan: readScanProgress(),
            isWatching: isWatching(),
            headerBlocks: takeHeaderBlocks(),
          })}`,
          result.status === 'rejected' ? { cause: result.error } : undefined,
        );
      };
      if (pressure) {
        const fromBlock = getWatcherStartBlock(env, adapter.addresses.depository, CHAIN_ID);
        const failureState = () =>
          structuredClone({
            scan: readScanProgress(),
            jurisdictionHeight: env.state.jReplicas.get(jurisdictionName)?.blockNumber,
            finalizedHeight: env.state.eReplicas.get(`${entityId}:${SIGNER_ID}`)?.state.lastFinalizedJHeight,
            reserve: env.state.eReplicas.get(`${entityId}:${SIGNER_ID}`)?.state.reserves.get(TOKEN_ID),
            mempool: env.runtimeMempool,
          });
        const beforeFailures = failureState();
        rpcProxy.takeHeaderBlocks();
        // Start all eight chunks, then halve on each unavailable header. Drain
        // every in-flight sibling without committing any partial range or state.
        for (const window of [1023, 511, 255]) {
          const missingHeaderGate = rpcProxy.armHeaderBatchGate('missing-header');
          const missingHeaderPoll = pollWatcher();
          await waitForGate(`missing-header-${window}`, missingHeaderGate, missingHeaderPoll);
          missingHeaderGate.release();
          await missingHeaderPoll;
          expect(failureState()).toEqual(beforeFailures);
          expect(adapter.isWatching()).toBe(true);
          expect(rpcProxy.takeHeaderBlocks().sort((left, right) => left - right)).toEqual(
            Array.from({ length: window }, (_, index) => fromBlock + index),
          );
        }

        const timeoutGate = rpcProxy.armHeaderBatchGate();
        const retryStartedAt = performance.now();
        const timedOutPoll = pollWatcher();
        const joinedTimedOutPoll = pollWatcher();
        await waitForGate('timeout', timeoutGate, timedOutPoll);
        try {
          // A manual drain shares transport cooldown with the automatic timer.
          // A not-yet-available header uses the same cooldown as other RPC pressure.
          expect(performance.now() - retryStartedAt).toBeGreaterThanOrEqual(900);
          // Let the real HTTP batch deadline abort the held request; no fake clock.
          await Promise.all([timedOutPoll, joinedTimedOutPoll]);
        } finally {
          timeoutGate.release();
        }
        expect(failureState()).toEqual(beforeFailures);
        expect(adapter.isWatching()).toBe(true);
        // The retry still begins at block 1, which has no preceding anchor.
        expect(rpcProxy.takeHeaderBlocks()).toHaveLength(127);

        // All four failures shrink the actual poll: 1023 -> 511 -> 255 -> 127 -> 63.
        // Every successful response is forwarded from Anvil, including the fence.
        await pollWatcher();
        const readHeights = [...new Set(rpcProxy.takeHeaderBlocks())].sort((left, right) => left - right);
        const anchorHeight = Math.max(1, fromBlock - 1);
        expect(readHeights).toEqual(
          Array.from({ length: fromBlock + 63 - anchorHeight }, (_, index) => anchorHeight + index),
        );
        expect(readScanProgress().scannedThroughHeight).toBe(fromBlock + 62);

        const successfulRetryAt = performance.now();
        // Commit the first real observed range so the next poll can advance.
        // One success must not restore the larger burst while pressure remains.
        await processRuntime(env);
        const retainedPressureGate = rpcProxy.armBlockNumberGate();
        const retainedPressureEnteredAt = retainedPressureGate.entered.then(() => performance.now());
        const retainedPressurePoll = pollWatcher();
        // Observe the required minimum cooldown before starting the unchanged
        // RPC gate deadline. Capture actual entry time so an early poll still
        // fails even while this observer is waiting for the minimum interval.
        await Bun.sleep(Math.max(0, 1_400 - (performance.now() - successfulRetryAt)));
        await waitForGate('retained-pressure', retainedPressureGate, retainedPressurePoll);
        try {
          expect((await retainedPressureEnteredAt) - successfulRetryAt).toBeGreaterThanOrEqual(1_400);
        } finally {
          retainedPressureGate.release();
        }
        await retainedPressurePoll;
        expect(readScanProgress().scannedThroughHeight).toBe(fromBlock + 125);

        // A pressure-limited page below the liveness interval stays ephemeral,
        // but the next authenticated read must advance beyond it, not loop forever.
        rpcProxy.takeHeaderBlocks();
        await pollWatcher();
        expect(readScanProgress().scannedThroughHeight).toBe(fromBlock + 188);
      }

      await processJEvents(env);

      const replica = env.state.eReplicas.get(`${entityId}:${SIGNER_ID}`);
      expect(replica?.state.reserves.get(TOKEN_ID)).toBe(RESERVE_AMOUNT);
      expect(Number(env.state.jReplicas.get(jurisdictionName)?.blockNumber ?? 0n)).toBeGreaterThanOrEqual(
        Number(reserveEvent?.blockNumber ?? 0),
      );
      expect(replica?.state.lastFinalizedJHeight).toBeGreaterThanOrEqual(Number(reserveEvent?.blockNumber ?? 0));

      const beforeEmptyTail = await provider.send('evm_snapshot', []);
      await provider.send('anvil_mine', ['0x1']);
      const authenticatedEmptyTail = await provider.getBlockNumber();
      await processJEvents(env);

      const durableSemanticHeight = Number(reserveEvent?.blockNumber ?? 0);
      expect(Number(env.state.jReplicas.get(jurisdictionName)?.blockNumber ?? 0n)).toBe(durableSemanticHeight);
      expect(adapter.getWatcherScanProgress?.().scannedThroughHeight).toBe(authenticatedEmptyTail);
      const currentReplica = env.state.eReplicas.get(`${entityId}:${SIGNER_ID}`);
      expect(currentReplica?.jHistory?.scannedThroughHeight).toBe(durableSemanticHeight);
      expect(currentReplica?.state.lastFinalizedJHeight).toBe(durableSemanticHeight);

      // Reorg only the uncommitted carried suffix on the real chain. The
      // certified anchor is unchanged; no durable rewind may be fabricated.
      const replicaKey = `${entityId}:${SIGNER_ID}`;
      const abandonedTip = env.infrastructure?.carriedJScanTips?.get(replicaKey)?.data.tipBlockHash;
      expect(abandonedTip).toBeDefined();
      expect(await provider.send('evm_revert', [beforeEmptyTail])).toBe(true);
      await provider.send('evm_increaseTime', [10]);
      await provider.send('anvil_mine', ['0x2']);
      await pollWatcher();
      expect(env.infrastructure?.carriedJScanTips?.has(replicaKey)).toBe(false);
      expect(env.runtimeMempool?.runtimeTxs ?? []).toEqual([]);
      expect(env.state.eReplicas.get(replicaKey)?.state.lastFinalizedJHeight).toBe(durableSemanticHeight);
      await processJEvents(env);
      const replacementTip = env.infrastructure?.carriedJScanTips?.get(replicaKey);
      expect(replacementTip?.data.tipBlockHash).not.toBe(abandonedTip);
      expect(replacementTip?.data.scannedThroughHeight).toBe(authenticatedEmptyTail + 1);
      expect(env.state.eReplicas.get(replicaKey)?.jHistory?.scannedThroughHeight).toBe(durableSemanticHeight);

      // A watched ERC20 receipt can be perfectly authentic yet irrelevant to
      // every Entity in this Runtime. It advances only transient authenticated
      // scan progress (carried into the next frame that addresses the Entity);
      // WAL state remains event-driven and a restart safely rescans the bounded
      // empty suffix.
      const [watchedToken] = await adapter.getTokenRegistry();
      if (!watchedToken) throw new Error('J_WATCHER_BACKLOG_WATCHED_TOKEN_MISSING');
      const watchedErc20 = new ethers.Contract(
        watchedToken.address,
        ['function transfer(address to, uint256 amount) returns (bool)'],
        adapter.signer,
      );
      const irrelevantTransfer = await watchedErc20.getFunction('transfer')(
        '0x000000000000000000000000000000000000dEaD',
        1n,
      );
      await irrelevantTransfer.wait();
      const irrelevantLogHeight = await provider.getBlockNumber();
      await processJEvents(env);

      const afterIrrelevantLog = env.state.eReplicas.get(`${entityId}:${SIGNER_ID}`);
      expect(afterIrrelevantLog?.jHistory?.scannedThroughHeight).toBe(durableSemanticHeight);
      expect(afterIrrelevantLog?.jHistory?.contiguousThroughHeight).toBe(durableSemanticHeight);
      expect(afterIrrelevantLog?.state.lastFinalizedJHeight).toBe(durableSemanticHeight);
      expect(adapter.getWatcherScanProgress?.().scannedThroughHeight).toBe(irrelevantLogHeight);

      const restored = createEmptyEnv(RUNTIME_SEED);
      if (!afterIrrelevantLog) throw new Error('J_WATCHER_BACKLOG_REPLICA_MISSING');
      restored.state.eReplicas.set(`${entityId}:${SIGNER_ID}`, buildCanonicalEntityReplicaSnapshot(afterIrrelevantLog));
      restoreDurableRuntimeSnapshot(restored, buildDurableRuntimeMachineSnapshot(env));

      expect(Number(restored.state.jReplicas.get(jurisdictionName)?.blockNumber ?? 0n)).toBe(durableSemanticHeight);
      expect(restored.state.eReplicas.get(`${entityId}:${SIGNER_ID}`)?.jHistory?.scannedThroughHeight).toBe(
        durableSemanticHeight,
      );

      // Only committed history survives recovery. Re-authenticate every missing
      // carried header from the certified anchor; never restore an ephemeral tip.
      expect(restored.infrastructure?.carriedJScanTips?.size ?? 0).toBe(0);
      await adapter.stopWatchingAndWait();
      restored.scenarioMode = true;
      adapter.startWatching(restored);
      rpcProxy.takeHeaderBlocks();
      await pollWatcher();
      const restartHeaders = [...new Set(rpcProxy.takeHeaderBlocks())].sort((left, right) => left - right);
      expect(restartHeaders).toContain(durableSemanticHeight);
      expect(restartHeaders).toContain(irrelevantLogHeight);
      expect(restartHeaders.filter(height => height > durableSemanticHeight)).toEqual(
        Array.from({ length: irrelevantLogHeight - durableSemanticHeight }, (_, i) => durableSemanticHeight + i + 1),
      );
      expect(restored.state.eReplicas.get(replicaKey)?.jHistory?.scannedThroughHeight).toBe(durableSemanticHeight);
      expect(readScanProgress().scannedThroughHeight).toBe(irrelevantLogHeight);
      await adapter.stopWatchingAndWait();
      adapter.startWatching(env);

      const lateSignerPrivateKey = getSignerPrivateKey(env, LATE_SIGNER_ID);
      const lateSignerAddress = new ethers.Wallet(ethers.hexlify(lateSignerPrivateKey)).address;
      const lateEntityId = generateLazyEntityId([lateSignerAddress], 1n).toLowerCase();
      await commitRuntimeInput(env, {
        runtimeTxs: [
          createTestEntityImportRuntimeTx(env, {
            entityId: lateEntityId,
            signerId: LATE_SIGNER_ID,
            data: {
              isProposer: true,
              config: {
                mode: 'proposer-based',
                threshold: 1n,
                validators: [LATE_SIGNER_ID],
                shares: { [LATE_SIGNER_ID]: 1n },
                jurisdiction,
              },
            },
          }),
        ],
        entityInputs: [],
      });

      await processJEvents(env);

      const lateReplica = env.state.eReplicas.get(`${lateEntityId}:${LATE_SIGNER_ID}`);
      expect(lateReplica?.jHistory?.scannedThroughHeight).toBe(irrelevantLogHeight);
      expect(lateReplica?.state.lastFinalizedJHeight).toBeLessThan(irrelevantLogHeight);
      if (!lateReplica) throw new Error('J_WATCHER_BACKLOG_LATE_REPLICA_MISSING');
      expect(
        resolveObserverCertifiedBoardHash(lateReplica.state, getCertifiedBoardNodeStore(env), registeredEntityId),
      ).toBe(registeredBoardHash.toLowerCase());
      expect(env.state.eReplicas.get(`${entityId}:${SIGNER_ID}`)?.state.reserves.get(TOKEN_ID)).toBe(RESERVE_AMOUNT);

      await provider.send('anvil_mine', ['0x1']);
      const shutdownGate = rpcProxy.armBlockNumberGate();
      const inFlightPoll = adapter.pollNow?.();
      if (!inFlightPoll) throw new Error('J_WATCHER_BACKLOG_POLL_API_MISSING');
      await waitForGate('shutdown', shutdownGate, inFlightPoll);
      let shutdownComplete = false;
      const shutdown = adapter.stopWatchingAndWait().then(() => {
        shutdownComplete = true;
      });
      await Bun.sleep(25);
      expect(shutdownComplete).toBe(false);
      shutdownGate.release();
      await shutdown;
      await inFlightPoll;
      expect(adapter.isWatching()).toBe(false);

      // Exercise the actual automatic timer on the same real transport. The
      // manual call below only joins a request already held by the proxy.
      env.scenarioMode = false;
      const automaticFailureGate = rpcProxy.armHeaderBatchGate(429);
      adapter.startWatching(env);
      await waitForGate('automatic-first-poll', automaticFailureGate);
      const automaticFailure = pollWatcher();
      automaticFailureGate.release();
      await automaticFailure;
      const automaticRetryGate = rpcProxy.armHeaderBatchGate(429);
      const automaticRetryAt = performance.now();
      await waitForGate('automatic-retry', automaticRetryGate);
      const automaticRetry = pollWatcher();
      try {
        expect(performance.now() - automaticRetryAt).toBeGreaterThanOrEqual(900);
      } finally {
        automaticRetryGate.release();
      }
      await automaticRetry;

      const cancelledGate = rpcProxy.armBlockNumberGate();
      let requestedWhileCooling = false;
      void cancelledGate.entered.then(() => {
        requestedWhileCooling = true;
      });
      const coolingPoll = pollWatcher();
      const joinedCoolingPoll = pollWatcher();
      await Bun.sleep(25);
      const stopStartedAt = performance.now();
      try {
        await adapter.stopWatchingAndWait();
        await Promise.all([coolingPoll, joinedCoolingPoll]);
        expect(performance.now() - stopStartedAt).toBeLessThan(500);
        expect(requestedWhileCooling).toBe(false);
        expect(adapter.isWatching()).toBe(false);
      } finally {
        cancelledGate.release();
      }
    },
    60_000,
  );
});
