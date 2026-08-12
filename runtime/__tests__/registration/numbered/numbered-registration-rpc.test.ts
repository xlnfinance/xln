import { expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';

import { getSignerPrivateKey } from '../../../account/crypto';
import { deriveRuntimeAdapterCapabilityToken } from '../../../api/runtime-adapter/security/auth';
import {
  decodeRuntimeAdapterBrowserMessage,
  decodeRuntimeAdapterMessage,
} from '../../../api/runtime-adapter/codec';
import { buildRuntimeAdapterOwnerBindingDigest } from '../../../api/runtime-adapter/security/owner-binding';
import { RemoteRuntimeAdapter } from '../../../api/runtime-adapter/remote';
import { handleRuntimeAdapterMessage } from '../../../api/runtime-adapter/server';
import { createJAdapter, createXlnJsonRpcProvider } from '../../../jurisdiction/adapter';
import { requireRuntimeJurisdictionConfigByName } from '../../../jurisdiction/machine/jurisdiction-runtime';
import { attachLiveJAdapter, getLiveJAdapter } from '../../../runtime/jurisdiction/live-jadapters';
import {
  buildNumberedRegistrationRequest,
  prepareNumberedRegistrationIntent,
  getNumberedRegistrationRecord,
} from '../../../runtime/registration/numbered-registration-intent';
import { markLocalNumberedRegistrationTx } from '../../../runtime/registration/numbered-registration-auth';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  loadEnvFromDB,
  readPersistedFrameJournals,
  startJurisdictionWatchers,
  startRuntimeLoop,
  stopRuntimeLoopAndWait,
} from '../../../runtime';
import { dbRootPath } from '../../../runtime/platform';
import type { RuntimeReplica } from '../../../runtime/types';
import { commitRuntimeInput, setScenarioStorageEnabled } from '../../../scenarios/harness/helpers';
import type { JurisdictionConfig } from '../../../entity/types';
import type { JAdapter } from '../../../jurisdiction/adapter/types';
import type { JReplica } from '../../../types/jurisdiction-runtime';

const CHAIN_ID = 31_337;

type ManagedAnvil = {
  child: ChildProcessWithoutNullStreams;
  rpcUrl: string;
  root: string;
  stderr: string;
};

const reservePort = async (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      reject(new Error('NUMBERED_REGISTRATION_RPC_PORT_RESERVATION_FAILED'));
      return;
    }
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});

const startAnvil = async (): Promise<ManagedAnvil> => {
  const port = await reservePort();
  const root = await mkdtemp(join(tmpdir(), 'xln-numbered-registration-rpc-'));
  const managed: ManagedAnvil = {
    child: spawn('anvil', [
      '--host', '127.0.0.1',
      '--port', String(port),
      '--chain-id', String(CHAIN_ID),
      '--block-gas-limit', '60000000',
      '--prune-history', '256',
      '--silent',
      '--state', join(root, 'state.json'),
    ], { env: { ...process.env, TMPDIR: root } }),
    rpcUrl: `http://127.0.0.1:${port}`,
    root,
    stderr: '',
  };
  managed.child.stderr.on('data', chunk => { managed.stderr += chunk.toString(); });
  const provider = createXlnJsonRpcProvider(managed.rpcUrl);
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await provider.getNetwork()).chainId === BigInt(CHAIN_ID)) return managed;
      } catch {
        // The process is still starting; the bounded loop below is the timeout.
      }
      await Bun.sleep(50);
    }
    throw new Error(`NUMBERED_REGISTRATION_RPC_ANVIL_NOT_READY:${managed.stderr}`);
  } finally {
    await provider.destroy();
  }
};

const stopAnvil = async (managed: ManagedAnvil): Promise<void> => {
  if (managed.child.exitCode === null && managed.child.signalCode === null) {
    managed.child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>(resolve => managed.child.once('exit', () => resolve())),
      Bun.sleep(3_000).then(() => managed.child.kill('SIGKILL')),
    ]);
  }
  await rm(managed.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
};

const attach = (env: RuntimeReplica, adapter: JAdapter, jurisdiction: JurisdictionConfig): void => {
  const replica: JReplica = {
    name: jurisdiction.name,
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    chainId: adapter.chainId,
    position: { x: 0, y: 0, z: 0 },
    depositoryAddress: adapter.addresses.depository,
    entityProviderAddress: adapter.addresses.entityProvider,
    entityProviderDeploymentBlock: adapter.entityProviderDeploymentBlock,
    watcherConfirmationDepth: 0,
    contracts: { ...adapter.addresses },
    rpcs: [jurisdiction.address],
  };
  env.state.jReplicas.set(jurisdiction.name, replica);
  attachLiveJAdapter(env, jurisdiction.name, adapter);
};

test('production RPC registration resumes exact WAL bytes after restart and imports certified evidence', async () => {
  const anvil = await startAnvil();
  let adapter: JAdapter | null = null;
  let env: RuntimeReplica | null = null;
  let restored: RuntimeReplica | null = null;
  let originalDbClosed = false;
  let namespace = '';
  try {
    adapter = await createJAdapter({ mode: 'rpc', chainId: CHAIN_ID, rpcUrl: anvil.rpcUrl });
    await adapter.deployStack();
    const seed = `numbered-registration:rpc:${process.pid}:${anvil.rpcUrl}`;
    env = createEmptyEnv(seed);
    if (!env.runtimeId) throw new Error('NUMBERED_REGISTRATION_RPC_RUNTIME_ID_MISSING');
    namespace = join(dbRootPath, env.runtimeId);
    for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-events', '-infra']) {
      await rm(`${namespace}${suffix}`, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    setScenarioStorageEnabled(env, true);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const jurisdiction: JurisdictionConfig = {
      name: 'NumberedRegistrationRpc',
      address: anvil.rpcUrl,
      chainId: CHAIN_ID,
      depositoryAddress: adapter.addresses.depository,
      entityProviderAddress: adapter.addresses.entityProvider,
    };
    attach(env, adapter, jurisdiction);
    adapter.startWatching(env);
    await (await adapter.signer.sendTransaction({
      to: env.runtimeId,
      value: ethers.parseEther('1'),
    })).wait();

    const committedJurisdiction = requireRuntimeJurisdictionConfigByName(env, jurisdiction.name);
    const request = buildNumberedRegistrationRequest(env, {
      jurisdiction: committedJurisdiction,
      payerSignerId: env.runtimeId,
      entities: [{
        name: 'rpc-production',
        validators: [{ name: env.runtimeId, weight: 1 }],
        threshold: 1n,
        localSignerId: env.runtimeId,
      }],
    });
    const registrationData = adapter.entityProvider.interface.encodeFunctionData(
      'registerNumberedEntitiesBatch',
      [request.entities.map(entity => entity.boardHash)],
    );

    let rejectedNonce = -1;
    await expect(adapter.prepareDurableTransaction(
      getSignerPrivateKey(env, env.runtimeId),
      { to: request.entityProviderAddress, data: registrationData },
      async prepared => {
        rejectedNonce = prepared.transactionNonce;
        return 'rejected';
      },
    )).rejects.toThrow('DURABLE_TRANSACTION_ACCEPTANCE_REJECTED');

    const pending = await prepareNumberedRegistrationIntent(
      env,
      adapter,
      request,
      async prepared => {
        await commitRuntimeInput(env!, {
          runtimeTxs: [markLocalNumberedRegistrationTx({
            type: 'recordNumberedRegistrationIntent',
            data: prepared,
          })],
          entityInputs: [],
        });
        return 'accepted';
      },
    );
    expect([rejectedNonce, pending.transactionNonce]).toEqual([0, 0]);
    expect(await adapter.provider.getTransaction(pending.transactionHash)).toBeNull();
    expect(await adapter.provider.getTransactionCount(env.runtimeId, 'latest')).toBe(0);
    const intentJournals = await readPersistedFrameJournals(env, {
      fromHeight: 1,
      toHeight: env.state.height,
      limit: env.state.height,
    });
    const recorded = intentJournals
      .flatMap(journal => journal.runtimeInput.runtimeTxs)
      .find(tx => tx.type === 'recordNumberedRegistrationIntent');
    expect(recorded?.type === 'recordNumberedRegistrationIntent' ? recorded.data : null).toEqual(pending);

    await adapter.stopWatchingAndWait();
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    originalDbClosed = true;
    await adapter.close();
    adapter = null;

    restored = await loadEnvFromDB(env.runtimeId, seed);
    if (!restored) throw new Error('NUMBERED_REGISTRATION_RPC_RESTORE_MISSING');
    restored.quietRuntimeLogs = true;
    const restoredAdapter = getLiveJAdapter(restored, jurisdiction.name);
    if (!restoredAdapter) throw new Error('NUMBERED_REGISTRATION_RPC_ADAPTER_RESTORE_MISSING');
    adapter = restoredAdapter;
    startJurisdictionWatchers(restored);
    startRuntimeLoop(restored, { tickDelayMs: 0 });

    const previousWebSocket = globalThis.WebSocket;
    const previousAuthSeed = process.env['XLN_RADAPTER_AUTH_SEED'];
    const authSeed = 'numbered-registration-rpc-auth-seed-32-bytes-minimum';
    process.env['XLN_RADAPTER_AUTH_SEED'] = authSeed;
    class RpcBridgeWebSocket {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      binaryType = 'arraybuffer';
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      private readonly serverSocket = {
        send: (message: unknown) => setTimeout(() => this.onmessage?.({ data: message }), 0),
        close: () => {
          this.readyState = RpcBridgeWebSocket.CLOSED;
          this.onclose?.();
        },
        getBufferedAmount: () => 0,
      };
      constructor(readonly url: string) {
        setTimeout(() => {
          this.readyState = RpcBridgeWebSocket.OPEN;
          this.onopen?.();
        }, 0);
      }
      send(raw: unknown): void {
        const message = (typeof raw === 'string'
          ? decodeRuntimeAdapterBrowserMessage(raw)
          : decodeRuntimeAdapterMessage(raw)) as Parameters<typeof handleRuntimeAdapterMessage>[1];
        void handleRuntimeAdapterMessage(this.serverSocket, message, restored, {
          isMutatingIngressReady: () => true,
        });
      }
      close(): void {
        this.readyState = RpcBridgeWebSocket.CLOSED;
        this.onclose?.();
      }
    }
    globalThis.WebSocket = RpcBridgeWebSocket as unknown as typeof WebSocket;
    const remote = new RemoteRuntimeAdapter();
    try {
      const runtimeId = restored.runtimeId!;
      const capability = deriveRuntimeAdapterCapabilityToken(
        authSeed,
        'full',
        Date.now() + 60_000,
        { audience: runtimeId },
      );
      await remote.connect({
        mode: 'remote',
        wsUrl: 'ws://127.0.0.1:1/rpc',
        runtimeId,
        authKey: capability,
        ownerBindingSigner: ({ challenge }) => new ethers.SigningKey(
          ethers.hexlify(getSignerPrivateKey(restored!, runtimeId)),
        ).sign(buildRuntimeAdapterOwnerBindingDigest(runtimeId, challenge, capability)).serialized,
        requestTimeoutMs: 5_000,
        reconnectMaxMs: 5_000,
      });
      const remoteResult = await remote.registerNumberedEntities({
        jurisdictionRef: jurisdiction.name,
        payerSignerId: runtimeId,
        entities: [{
          name: 'rpc-production',
          validators: [{ name: runtimeId, weight: 1 }],
          threshold: 1n,
          localSignerId: runtimeId,
        }],
      });
      expect(remote.authLevel).toBe('admin');
      expect(remoteResult.intentId).toBe(request.intentId);
      expect(remoteResult.entities[0]?.imported).toBe(true);
    } finally {
      remote.disconnect();
      globalThis.WebSocket = previousWebSocket;
      if (previousAuthSeed === undefined) delete process.env['XLN_RADAPTER_AUTH_SEED'];
      else process.env['XLN_RADAPTER_AUTH_SEED'] = previousAuthSeed;
    }

    const completed = getNumberedRegistrationRecord(restored, request.intentId);
    const chainTx = await adapter.provider.getTransaction(pending.transactionHash);
    expect(completed?.status).toBe('completed');
    expect(restored.state.eReplicas.size).toBe(1);
    expect(await adapter.entityProvider.nextNumber()).toBe(3n);
    expect(chainTx?.hash.toLowerCase()).toBe(pending.transactionHash);
    expect(chainTx?.from.toLowerCase()).toBe(env.runtimeId);
    expect(chainTx?.to?.toLowerCase()).toBe(request.entityProviderAddress);
    expect(chainTx?.data.toLowerCase()).toBe(registrationData.toLowerCase());
    expect(chainTx?.nonce).toBe(pending.transactionNonce);

    const completedJournals = await readPersistedFrameJournals(restored, {
      fromHeight: 1,
      toHeight: restored.state.height,
      limit: restored.state.height,
    });
    const intentFrame = completedJournals.find(journal => journal.runtimeInput.runtimeTxs.some(
      tx => tx.type === 'recordNumberedRegistrationIntent',
    ));
    const evidenceFrame = completedJournals.find(journal => journal.runtimeInput.runtimeTxs.some(
      tx => tx.type === 'recordAuthenticatedJAuthority',
    ));
    const completionFrame = completedJournals.find(journal => journal.runtimeInput.runtimeTxs.some(
      tx => tx.type === 'resolveNumberedRegistrationIntent',
    ));
    expect(intentFrame?.height).toBeLessThan(evidenceFrame?.height ?? 0);
    expect(evidenceFrame?.height).toBeLessThan(completionFrame?.height ?? 0);
    expect(completionFrame?.runtimeInput.runtimeTxs.map(tx => tx.type)).toContain('importReplica');

    await expect(adapter.prepareDurableTransaction(
      getSignerPrivateKey(restored, restored.runtimeId!),
      { to: request.entityProviderAddress, data: registrationData },
      async () => { throw new Error('WAL_ACCEPTANCE_OUTCOME_UNKNOWN'); },
    )).rejects.toThrow('WAL_ACCEPTANCE_OUTCOME_UNKNOWN');
    await expect(adapter.prepareDurableTransaction(
      getSignerPrivateKey(restored, restored.runtimeId!),
      { to: request.entityProviderAddress, data: registrationData },
      async () => 'accepted',
    )).rejects.toThrow('SIGNER_NONCE_SEQUENCER_POISONED');
    expect(await adapter.provider.getTransactionCount(restored.runtimeId!, 'latest')).toBe(1);
  } finally {
    if (restored) {
      await stopRuntimeLoopAndWait(restored).catch(() => false);
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    } else if (env && !originalDbClosed) {
      await closeRuntimeDb(env);
      await closeInfraDb(env);
    }
    await adapter?.close();
    if (namespace) {
      for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-events', '-infra']) {
        await rm(`${namespace}${suffix}`, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
    await stopAnvil(anvil);
  }
}, 120_000);
