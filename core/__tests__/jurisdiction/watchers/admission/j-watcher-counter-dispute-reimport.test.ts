import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { ethers } from 'ethers';

import { deriveSignerAddressSync, getSignerPrivateKey } from '../../../../account/crypto';
import { generateLazyEntityId } from '../../../../entity/factory';
import { createJAdapter, createXlnJsonRpcProvider, type JAdapter } from '../../../../jurisdiction/adapter';
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
import { counterShortfallDispute, startShortfallDispute } from '../../../fixtures/jurisdiction/real-dispute-shortfall';

// A mnemonic re-imported without a checkpoint folds its full Jurisdiction
// history. If that Entity disputed on another device and the peer answered
// with a counter-proof, the history names it in DisputeStarted and
// CounterDisputeRegistered although the fresh runtime has no Account for the
// pair. Real chain, real signed dispute and counter; nothing mocked on the
// fold path.
const CHAIN_ID = 31_337;
const RUNTIME_SEED = 'counter-dispute-reimport';
const JURISDICTION_NAME = 'Counter Dispute Reimport';

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
let rpcUrl = '';

beforeAll(async () => {
  const port = await reservePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  anvil = spawn('anvil', [
    '--host', '127.0.0.1', '--port', String(port), '--chain-id', String(CHAIN_ID),
    '--block-gas-limit', '60000000', '--silent',
  ], { stdio: 'ignore' });
  const probe = createXlnJsonRpcProvider(rpcUrl);
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
  adapter = await createJAdapter({ mode: 'rpc', chainId: CHAIN_ID, rpcUrl, watchPollMs: 100 });
  await adapter.deployStack();
}, 60_000);

afterAll(async () => {
  await adapter?.stopWatchingAndWait();
  await adapter?.close();
  anvil?.kill('SIGKILL');
});

test('a fresh import folds a counter-dispute naming the Entity without a local Account', async () => {
  const jAdapter = adapter!;
  const provider = jAdapter.provider as ethers.JsonRpcProvider;

  const env = createEmptyEnv(RUNTIME_SEED);
  env.scenarioMode = true;
  env.state.timestamp = 1;
  setScenarioStorageEnabled(env, false);
  ensureSignerKeysFromSeed(env, ['2', '3'], RUNTIME_SEED);
  const jReplica = createJReplica(env, JURISDICTION_NAME, jAdapter.addresses.depository);
  jReplica.chainId = CHAIN_ID;
  jReplica.watcherConfirmationDepth = 0;
  jReplica.rpcs = [rpcUrl];
  jReplica.contracts = { ...jAdapter.addresses };
  attachLiveJAdapter(env, JURISDICTION_NAME, jAdapter);
  const jurisdiction = createJurisdictionConfig(
    JURISDICTION_NAME,
    jAdapter.addresses.depository,
    jAdapter.addresses.entityProvider,
    rpcUrl,
    CHAIN_ID,
  );

  // Two lazy single-signer Entities; the Depository dispute fixture needs the
  // debtor on the LEFT.
  const parties = ['2', '3'].map(signerIndex => {
    const signerId = deriveSignerAddressSync(RUNTIME_SEED, signerIndex).toLowerCase();
    const privateKey = ethers.hexlify(getSignerPrivateKey(env, signerId));
    const entityId = generateLazyEntityId([new ethers.Wallet(privateKey).address], 1n).toLowerCase();
    return { signerId, entityId, wallet: { privateKey } };
  }).sort((a, b) => (a.entityId < b.entityId ? -1 : 1));
  const [debtor, creditor] = parties as [typeof parties[number], typeof parties[number]];

  // On another device: the creditor starts a dispute over a debtor-signed N1,
  // the debtor registers a creditor-signed N2 as counter-proof.
  await startShortfallDispute(jAdapter, CHAIN_ID, debtor, creditor, -1_000n, 'c1');
  const counteredAt = await counterShortfallDispute(
    jAdapter, CHAIN_ID, debtor, creditor,
    { offdelta: -1_000n, seedByte: 'c1' },
    { offdelta: -400n, seedByte: 'c2' },
  );

  // The starter's mnemonic is re-imported on a fresh runtime with no
  // checkpoint; its watcher folds history from the EntityProvider deployment.
  const fatal: string[] = [];
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    fatal.push(`exit:${code}`);
  }) as typeof process.exit);
  const state = () => {
    const replica = env.state.eReplicas.get(`${creditor.entityId}:${creditor.signerId}`);
    if (!replica) throw new Error(`COUNTER_REIMPORT_REPLICA_MISSING:${creditor.entityId}`);
    return replica.state;
  };
  try {
    jAdapter.startWatching(env);
    await commitRuntimeInput(env, {
      runtimeTxs: [
        createTestEntityImportRuntimeTx(env, {
          entityId: creditor.entityId,
          signerId: creditor.signerId,
          data: {
            isProposer: true,
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [creditor.signerId],
              shares: { [creditor.signerId]: 1n },
              jurisdiction,
            },
          },
        }),
      ],
      entityInputs: [],
    });
    for (let attempt = 0; attempt < 10 && fatal.length === 0 && Number(state().lastFinalizedJHeight) < counteredAt; attempt += 1) {
      await provider.send('evm_mine', []);
      await processJEvents(env);
    }
  } catch (error) {
    fatal.push(`throw:${error instanceof Error ? error.message : String(error)}`);
  } finally {
    exitSpy.mockRestore();
  }

  console.log(`[counter-dispute-reimport] counteredAt=${counteredAt} ` +
    `finalized=${Number(state().lastFinalizedJHeight)} watching=${jAdapter.isWatching()} fatal=${fatal.join(' | ').slice(0, 600)}`);
  expect(fatal).toEqual([]);
  expect(Number(state().lastFinalizedJHeight)).toBeGreaterThanOrEqual(counteredAt);
  expect(state().accounts.has(debtor.entityId)).toBe(false);
  expect(jAdapter.isWatching()).toBe(true);
}, 60_000);
