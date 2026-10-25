import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { ethers } from 'ethers';

import { deriveSignerAddressSync, getSignerPrivateKey } from '../../../../account/crypto';
import { generateLazyEntityId } from '../../../../entity/factory';
import { createJAdapter, createXlnJsonRpcProvider, type JAdapter } from '../../../../jurisdiction/adapter';
import { safeStringify } from '../../../../protocol/serialization';
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

// Wallet cold import cost is the root latency: a runtime with no checkpoint
// authenticates every header from the EntityProvider deployment. Two fresh
// runtimes import the same Entity, the second after EMPTY_BLOCKS empty blocks.
// Its financial state must equal the first one, and its header reads must not
// grow with those blocks. Real chain; a forwarding proxy only counts the
// JSON-RPC methods that the import sends.
const CHAIN_ID = 31_337;
const RUNTIME_SEED = 'cold-import-chain-age';
const JURISDICTION_NAME = 'Cold Import Chain Age';
const EMPTY_BLOCKS = 2_000;
// Chain-age-independent allowance for a tip proof plus its fences.
const HEADER_READ_GROWTH_BOUND = 256;

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
let proxy: ReturnType<typeof Bun.serve> | null = null;
let adapter: JAdapter | null = null;
let anvilUrl = '';
let rpcUrl = '';
const methodCounts = new Map<string, number>();

const countMethods = (body: string): void => {
  const parsed: unknown = JSON.parse(body);
  for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
    const method = String((call as { method?: unknown }).method);
    methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);
  }
};

beforeAll(async () => {
  const port = await reservePort();
  anvilUrl = `http://127.0.0.1:${port}`;
  anvil = spawn('anvil', [
    '--host', '127.0.0.1', '--port', String(port), '--chain-id', String(CHAIN_ID),
    '--block-gas-limit', '60000000', '--silent',
  ], { stdio: 'ignore' });
  const probe = createXlnJsonRpcProvider(anvilUrl);
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
  proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.text();
      countMethods(body);
      const upstream = await fetch(anvilUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  rpcUrl = `http://127.0.0.1:${proxy.port}`;
  adapter = await createJAdapter({ mode: 'rpc', chainId: CHAIN_ID, rpcUrl, watchPollMs: 100 });
  await adapter.deployStack();
}, 60_000);

afterAll(async () => {
  await adapter?.stopWatchingAndWait();
  await adapter?.close();
  proxy?.stop(true);
  anvil?.kill('SIGKILL');
});

test('a cold import reads a chain-age-independent number of headers and folds the same state', async () => {
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

  const coldImport = async (label: string) => {
    const env = createEmptyEnv(RUNTIME_SEED);
    env.scenarioMode = true;
    env.state.timestamp = 1;
    setScenarioStorageEnabled(env, false);
    ensureSignerKeysFromSeed(env, ['2'], RUNTIME_SEED);
    const privateKey = ethers.hexlify(getSignerPrivateKey(env, signerId));
    const entityId = generateLazyEntityId([new ethers.Wallet(privateKey).address], 1n).toLowerCase();
    const jReplica = createJReplica(env, JURISDICTION_NAME, jAdapter.addresses.depository);
    jReplica.chainId = CHAIN_ID;
    jReplica.watcherConfirmationDepth = 0;
    jReplica.rpcs = [rpcUrl];
    jReplica.contracts = { ...jAdapter.addresses };
    // Each fresh runtime owns its own adapter on the deployed stack.
    const coldAdapter = await createJAdapter({
      mode: 'rpc',
      chainId: CHAIN_ID,
      rpcUrl,
      watchPollMs: 100,
      fromReplica: { ...jReplica, entityProviderDeploymentBlock: jAdapter.entityProviderDeploymentBlock },
    });
    attachLiveJAdapter(env, JURISDICTION_NAME, coldAdapter);
    const tip = await provider.getBlockNumber();
    methodCounts.clear();
    const startedAt = performance.now();
    coldAdapter.startWatching(env);
    const state = () => {
      const replica = env.state.eReplicas.get(`${entityId}:${signerId}`);
      if (!replica) throw new Error(`COLD_IMPORT_REPLICA_MISSING:${entityId}`);
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
    const headerReads = methodCounts.get('eth_getBlockByNumber') ?? 0;
    console.log(`[cold-import-chain-age] ${label} tip=${tip} finalized=${Number(state().lastFinalizedJHeight)} ` +
      `headerReads=${headerReads} ms=${Math.round(performance.now() - startedAt)} ` +
      `methods=${safeStringify(Object.fromEntries(methodCounts))}`);
    return { entityId, tip, headerReads, state: state() };
  };

  const young = await coldImport('young');
  await jAdapter.debugFundReserves(young.entityId, 1, 1_000n);
  // Re-import after the funding so both runtimes must fold the same reserve.
  const funded = await coldImport('funded');
  await provider.send('anvil_mine', [ethers.toQuantity(EMPTY_BLOCKS)]);
  const aged = await coldImport('aged');

  expect(Number(funded.state.lastFinalizedJHeight)).toBeGreaterThanOrEqual(funded.tip);
  expect(Number(aged.state.lastFinalizedJHeight)).toBeGreaterThanOrEqual(aged.tip);
  expect(funded.state.reserves.get(1)).toBe(1_000n);
  expect(aged.state.reserves).toEqual(funded.state.reserves);
  expect(aged.state.accounts.size).toBe(funded.state.accounts.size);
  expect(aged.state.outDebtsByToken).toEqual(funded.state.outDebtsByToken);
  expect(aged.state.inDebtsByToken).toEqual(funded.state.inDebtsByToken);
  expect(aged.state.jBatchState).toEqual(funded.state.jBatchState);
  expect(aged.state.entityProviderActionState).toEqual(funded.state.entityProviderActionState);
  expect(aged.state.certifiedBoardState?.boardRegistryRoot)
    .toBe(funded.state.certifiedBoardState?.boardRegistryRoot);
  expect(aged.headerReads - funded.headerReads).toBeLessThanOrEqual(HEADER_READ_GROWTH_BOUND);
}, 60_000);
