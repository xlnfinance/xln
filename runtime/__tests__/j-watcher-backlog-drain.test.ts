import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';

import { createEmptyEnv } from '../runtime';
import { deriveSignerAddressSync, getSignerPrivateKey } from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import { createJAdapter, createXlnJsonRpcProvider, type JAdapter } from '../jadapter';
import { createJReplica, createJurisdictionConfig } from '../scenarios/boot';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../jurisdiction/board-registry';
import {
  commitRuntimeInput,
  ensureSignerKeysFromSeed,
  processJEvents,
  setScenarioStorageEnabled,
} from '../scenarios/helpers';
import {
  buildCanonicalEntityReplicaSnapshot,
  buildDurableRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../wal/snapshot';

const CHAIN_ID = 31_337;
const RUNTIME_SEED = 'j-watcher-backlog-drain';
const SIGNER_ID = deriveSignerAddressSync(RUNTIME_SEED, '2').toLowerCase();
const LATE_SIGNER_ID = deriveSignerAddressSync(RUNTIME_SEED, '3').toLowerCase();
const TOKEN_ID = 1;
const RESERVE_AMOUNT = 123_456n;
const BACKLOG_BLOCKS = 700;

const singleSignerBoardHash = (privateKey: Uint8Array): string => {
  const signerAddress = new ethers.Wallet(ethers.hexlify(privateKey)).address;
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
    [[1n, [ethers.zeroPadValue(signerAddress, 32)], [1n], 0n, 0n, 0n]],
  ));
};

type ManagedAnvil = {
  child: ChildProcessWithoutNullStreams;
  rpcUrl: string;
  tmpRoot: string;
  stderr: string;
};

type RpcGateControl = {
  entered: Promise<void>;
  release(): void;
};

type RpcGateProxy = {
  rpcUrl: string;
  armBlockNumberGate(): RpcGateControl;
  close(): Promise<void>;
};

let managedAnvil: ManagedAnvil | null = null;
let adapter: JAdapter | null = null;
let rpcProxy: RpcGateProxy | null = null;

const reservePort = async (): Promise<number> => await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      reject(new Error('J_WATCHER_BACKLOG_PORT_RESERVATION_FAILED'));
      return;
    }
    server.close((error) => error ? reject(error) : resolve(address.port));
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
  throw new Error(`J_WATCHER_BACKLOG_RPC_NOT_READY:${lastError}\nanvil=${managed.stderr}`);
};

const startAnvil = async (): Promise<ManagedAnvil> => {
  const port = await reservePort();
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xln-j-watcher-backlog-'));
  const child = spawn('anvil', [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--chain-id', String(CHAIN_ID),
    '--block-gas-limit', '60000000',
    '--prune-history', '1024',
    '--silent',
    '--state', join(tmpRoot, 'state.json'),
  ], { env: { ...process.env, TMPDIR: tmpRoot } });
  const managed: ManagedAnvil = {
    child,
    rpcUrl: `http://127.0.0.1:${port}`,
    tmpRoot,
    stderr: '',
  };
  child.stderr.on('data', (chunk) => {
    managed.stderr += chunk.toString();
  });
  await waitForRpc(managed);
  return managed;
};

const startRpcGateProxy = (upstreamUrl: string): RpcGateProxy => {
  let gateArmed = false;
  let enteredResolve: (() => void) | null = null;
  let releasePromise: Promise<void> | null = null;
  let releaseResolve: (() => void) | null = null;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const payload = JSON.parse(body) as { method?: string } | Array<{ method?: string }>;
      const methods = Array.isArray(payload) ? payload.map((entry) => entry.method) : [payload.method];
      if (gateArmed && methods.includes('eth_blockNumber')) {
        gateArmed = false;
        enteredResolve?.();
        if (!releasePromise) throw new Error('J_WATCHER_RPC_GATE_RELEASE_MISSING');
        await releasePromise;
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
    armBlockNumberGate(): RpcGateControl {
      if (gateArmed || releasePromise) throw new Error('J_WATCHER_RPC_GATE_ALREADY_ARMED');
      gateArmed = true;
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
      releasePromise = new Promise<void>((resolve) => { releaseResolve = resolve; });
      return {
        entered,
        release() {
          const resolve = releaseResolve;
          if (!resolve) throw new Error('J_WATCHER_RPC_GATE_NOT_ARMED');
          releaseResolve = null;
          releasePromise = null;
          enteredResolve = null;
          resolve();
        },
      };
    },
    async close(): Promise<void> {
      await server.stop(true);
    },
  };
};

const stopAnvil = async (managed: ManagedAnvil): Promise<void> => {
  if (managed.child.exitCode === null && managed.child.signalCode === null) {
    const exited = new Promise<void>((resolve) => managed.child.once('exit', () => resolve()));
    managed.child.kill('SIGTERM');
    const graceful = await Promise.race([
      exited.then(() => true),
      Bun.sleep(3_000).then(() => false),
    ]);
    if (!graceful && managed.child.exitCode === null && managed.child.signalCode === null) {
      managed.child.kill('SIGKILL');
      await exited;
    }
  }
  await rm(managed.tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
};

afterAll(async () => {
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
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'J_WATCHER_BACKLOG_CLEANUP_FAILED');
});

describe('RPC J-watcher backlog drain', () => {
  test('delivers an authenticated event beyond two 256-block pages before returning', async () => {
    managedAnvil = await startAnvil();
    rpcProxy = startRpcGateProxy(managedAnvil.rpcUrl);
    adapter = await createJAdapter({ mode: 'rpc', chainId: CHAIN_ID, rpcUrl: rpcProxy.rpcUrl });
    await adapter.deployStack();

    const env = createEmptyEnv(RUNTIME_SEED);
    env.scenarioMode = true;
    env.timestamp = 1;
    setScenarioStorageEnabled(env, false);
    ensureSignerKeysFromSeed(env, ['2', '3'], RUNTIME_SEED);

    const jurisdictionName = 'Backlog Drain';
    const jReplica = createJReplica(env, jurisdictionName, adapter.addresses.depository);
    jReplica.jadapter = adapter;
    jReplica.depositoryAddress = adapter.addresses.depository;
    jReplica.entityProviderAddress = adapter.addresses.entityProvider;
    jReplica.chainId = CHAIN_ID;
    jReplica.watcherConfirmationDepth = 0;
    jReplica.rpcs = [managedAnvil.rpcUrl];
    jReplica.contracts = { ...adapter.addresses };
    env.jAdapter = adapter;
    adapter.startWatching(env);

    const jurisdiction = createJurisdictionConfig(
      jurisdictionName,
      adapter.addresses.depository,
      adapter.addresses.entityProvider,
      managedAnvil.rpcUrl,
      CHAIN_ID,
    );
    const signerPrivateKey = getSignerPrivateKey(env, SIGNER_ID);
    const registeredBoardHash = singleSignerBoardHash(signerPrivateKey);
    const nextEntityNumber = await adapter.entityProvider.nextNumber();
    const registerReceipt = await (await adapter.entityProvider.registerNumberedEntitiesBatch([
      registeredBoardHash,
    ])).wait();
    if (!registerReceipt || registerReceipt.status !== 1) {
      throw new Error('J_WATCHER_BACKLOG_ENTITY_REGISTRATION_FAILED');
    }
    const registeredEntityId = ethers.zeroPadValue(ethers.toBeHex(nextEntityNumber), 32).toLowerCase();
    const signerAddress = new ethers.Wallet(ethers.hexlify(signerPrivateKey)).address;
    const entityId = generateLazyEntityId([signerAddress], 1n).toLowerCase();
    await commitRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
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
      }],
      entityInputs: [],
    });

    const provider = adapter.provider as ethers.JsonRpcProvider;
    await provider.send('anvil_mine', [ethers.toQuantity(BACKLOG_BLOCKS)]);
    const receiptEvents = await adapter.debugFundReserves(entityId, TOKEN_ID, RESERVE_AMOUNT);
    const reserveEvent = receiptEvents.find((event) => event.name === 'ReserveUpdated');
    expect(Number(reserveEvent?.blockNumber ?? 0)).toBeGreaterThan(2 * 256);

    await processJEvents(env);

    const replica = env.eReplicas.get(`${entityId}:${SIGNER_ID}`);
    expect(replica?.state.reserves.get(TOKEN_ID)).toBe(RESERVE_AMOUNT);
    expect(Number(env.jReplicas.get(jurisdictionName)?.blockNumber ?? 0n))
      .toBeGreaterThanOrEqual(Number(reserveEvent?.blockNumber ?? 0));
    expect(replica?.state.lastFinalizedJHeight).toBeGreaterThanOrEqual(Number(reserveEvent?.blockNumber ?? 0));

    await provider.send('anvil_mine', ['0x1']);
    const authenticatedEmptyTail = await provider.getBlockNumber();
    await processJEvents(env);

    expect(Number(env.jReplicas.get(jurisdictionName)?.blockNumber ?? 0n)).toBe(authenticatedEmptyTail);
    const currentReplica = env.eReplicas.get(`${entityId}:${SIGNER_ID}`);
    expect(currentReplica?.jHistory?.scannedThroughHeight).toBe(authenticatedEmptyTail);
    expect(currentReplica?.state.lastFinalizedJHeight).toBe(Number(reserveEvent?.blockNumber ?? 0));

    // A watched ERC20 receipt can be perfectly authentic yet irrelevant to
    // every Entity in this Runtime. The watcher must still durably advance the
    // authenticated header prefix; otherwise it re-reads the same range on
    // every poll because the global cursor outruns validator-local history.
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

    const afterIrrelevantLog = env.eReplicas.get(`${entityId}:${SIGNER_ID}`);
    expect(afterIrrelevantLog?.jHistory?.scannedThroughHeight).toBe(irrelevantLogHeight);
    expect(afterIrrelevantLog?.jHistory?.contiguousThroughHeight).toBe(irrelevantLogHeight);

    const restored = createEmptyEnv(RUNTIME_SEED);
    if (!afterIrrelevantLog) throw new Error('J_WATCHER_BACKLOG_REPLICA_MISSING');
    restored.eReplicas.set(`${entityId}:${SIGNER_ID}`, buildCanonicalEntityReplicaSnapshot(afterIrrelevantLog));
    restoreDurableRuntimeSnapshot(restored, buildDurableRuntimeMachineSnapshot(env));

    expect(Number(restored.jReplicas.get(jurisdictionName)?.blockNumber ?? 0n)).toBe(irrelevantLogHeight);
    expect(restored.eReplicas.get(`${entityId}:${SIGNER_ID}`)?.jHistory?.scannedThroughHeight)
      .toBe(irrelevantLogHeight);

    const lateSignerPrivateKey = getSignerPrivateKey(env, LATE_SIGNER_ID);
    const lateSignerAddress = new ethers.Wallet(ethers.hexlify(lateSignerPrivateKey)).address;
    const lateEntityId = generateLazyEntityId([lateSignerAddress], 1n).toLowerCase();
    await commitRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
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
      }],
      entityInputs: [],
    });

    await processJEvents(env);

    const lateReplica = env.eReplicas.get(`${lateEntityId}:${LATE_SIGNER_ID}`);
    expect(lateReplica?.jHistory?.scannedThroughHeight).toBe(irrelevantLogHeight);
    expect(lateReplica?.state.lastFinalizedJHeight).toBe(irrelevantLogHeight);
    if (!lateReplica) throw new Error('J_WATCHER_BACKLOG_LATE_REPLICA_MISSING');
    expect(resolveObserverCertifiedBoardHash(
      lateReplica.state,
      getCertifiedBoardNodeStore(env),
      registeredEntityId,
    )).toBe(registeredBoardHash.toLowerCase());
    expect(env.eReplicas.get(`${entityId}:${SIGNER_ID}`)?.state.reserves.get(TOKEN_ID))
      .toBe(RESERVE_AMOUNT);

    await provider.send('anvil_mine', ['0x1']);
    const shutdownGate = rpcProxy.armBlockNumberGate();
    const inFlightPoll = adapter.pollNow?.();
    if (!inFlightPoll) throw new Error('J_WATCHER_BACKLOG_POLL_API_MISSING');
    await shutdownGate.entered;
    let shutdownComplete = false;
    const shutdown = adapter.stopWatchingAndWait().then(() => { shutdownComplete = true; });
    await Bun.sleep(25);
    expect(shutdownComplete).toBe(false);
    shutdownGate.release();
    await shutdown;
    await inFlightPoll;
    expect(adapter.isWatching()).toBe(false);
  }, 60_000);
});
