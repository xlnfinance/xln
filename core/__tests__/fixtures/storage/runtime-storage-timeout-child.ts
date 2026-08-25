import {
  createEmptyEnv,
  enqueueRuntimeInput,
  getRuntimeWalDb,
  processRuntime,
} from '../../../runtime';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import { ensureRuntimeInfrastructure } from '../../../runtime/envelope/replica-envelope';
import type { ConsensusConfig, JurisdictionConfig } from '../../../entity/types';
import type { RuntimeTx } from '../../../runtime/types';
import { createTestJReplica } from '../../helpers/j-replica';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';

const [seed] = Bun.argv.slice(2);
if (!seed) throw new Error('runtime storage timeout fixture requires a seed');

const env = createEmptyEnv(seed);
env.quietRuntimeLogs = true;
const jurisdiction: JurisdictionConfig = {
  name: 'runtime-storage-timeout',
  address: 'browservm://runtime-storage-timeout',
  chainId: 31_337,
  depositoryAddress: '0x000000000000000000000000000000000000dead',
  entityProviderAddress: '0x000000000000000000000000000000000000beef',
};
const accountAddress = '0x000000000000000000000000000000000000aacc';
const deltaTransformerAddress = '0x000000000000000000000000000000000000da7a';
env.activeJurisdiction = jurisdiction.name;
env.state.jReplicas.set(jurisdiction.name, createTestJReplica({
  ...jurisdiction,
  contracts: {
    depository: jurisdiction.depositoryAddress,
    entityProvider: jurisdiction.entityProviderAddress,
    account: accountAddress,
    deltaTransformer: deltaTransformerAddress,
  },
}));

const importTx = (index: string): RuntimeTx => {
  const signerId = deriveSignerAddressSync(seed, index).toLowerCase();
  const config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
    jurisdiction,
  };
  return createTestEntityImportRuntimeTx(env, {
    entityId: generateLazyEntityId([signerId], 1n).toLowerCase(),
    signerId,
    data: { config, isProposer: true },
  });
};

process.env['XLN_STORAGE_WRITE_TIMEOUT_MS'] = '0';
enqueueRuntimeInput(env, { runtimeTxs: [importTx('1')], entityInputs: [] });
await processRuntime(env);
if (env.state.height !== 1) throw new Error(`fixture baseline height ${env.state.height}`);

// Delay the real next LevelDB write past the deadline. A one-millisecond
// deadline alone races a fast filesystem and does not prove the timeout path.
const walDb = getRuntimeWalDb(env);
const originalBatch = walDb.batch.bind(walDb);
Object.defineProperty(walDb, 'batch', {
  configurable: true,
  value: () => {
    Object.defineProperty(walDb, 'batch', {
      configurable: true,
      value: originalBatch,
    });
    const batch = originalBatch();
    const originalWrite = batch.write.bind(batch);
    Object.defineProperty(batch, 'write', {
      configurable: true,
      value: async (options?: { sync?: boolean }): Promise<void> => {
        await Bun.sleep(50);
        await originalWrite(options);
      },
    });
    return batch;
  },
});

process.env['XLN_STORAGE_WRITE_TIMEOUT_MS'] = '5';
enqueueRuntimeInput(env, { runtimeTxs: [importTx('2')], entityInputs: [] });
let failure = '';
try {
  await processRuntime(env);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}

const state = ensureRuntimeInfrastructure(env);
console.log(`STORAGE_TIMEOUT_RESULT:${JSON.stringify({
  failure,
  height: env.state.height,
  timestamp: env.state.timestamp,
  lifecycle: state.lifecyclePhase,
  fatalHeight: state.fatalDebugPayload?.height,
})}`);

// The timed-out write is deliberately not canceled. Give the real LevelDB
// operation time to settle so the parent can prove restart follows WAL truth,
// not the deliberately stale in-memory Runtime.
await Bun.sleep(250);
process.exit(0);
