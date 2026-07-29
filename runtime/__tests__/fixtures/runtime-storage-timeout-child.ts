import {
  createEmptyEnv,
  enqueueRuntimeInput,
  processRuntime,
} from '../../runtime';
import { deriveSignerAddressSync } from '../../account/crypto';
import { generateLazyEntityId } from '../../entity/factory';
import { ensureRuntimeState } from '../../runtime/runtime-state';
import type { ConsensusConfig, JurisdictionConfig } from '../../entity/types';
import type { RuntimeTx } from '../../runtime/types';

const [seed] = Bun.argv.slice(2);
if (!seed) throw new Error('runtime storage timeout fixture requires a seed');

const env = createEmptyEnv(seed);
env.quietRuntimeLogs = true;
const jurisdiction: JurisdictionConfig = {
  name: 'runtime-storage-timeout',
  chainId: 31_337,
  depositoryAddress: '0x000000000000000000000000000000000000dead',
  entityProviderAddress: '0x000000000000000000000000000000000000beef',
};
const accountAddress = '0x000000000000000000000000000000000000aacc';
const deltaTransformerAddress = '0x000000000000000000000000000000000000da7a';
env.activeJurisdiction = jurisdiction.name;
env.jReplicas.set(jurisdiction.name, {
  ...jurisdiction,
  contracts: {
    depository: jurisdiction.depositoryAddress,
    entityProvider: jurisdiction.entityProviderAddress,
    account: accountAddress,
    deltaTransformer: deltaTransformerAddress,
  },
} as never);

const importTx = (index: string): RuntimeTx => {
  const signerId = deriveSignerAddressSync(seed, index).toLowerCase();
  const config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
    jurisdiction,
  };
  return {
    type: 'importReplica',
    entityId: generateLazyEntityId([signerId], 1n).toLowerCase(),
    signerId,
    data: { config, isProposer: true },
  };
};

process.env['XLN_STORAGE_WRITE_TIMEOUT_MS'] = '0';
enqueueRuntimeInput(env, { runtimeTxs: [importTx('1')], entityInputs: [] });
await processRuntime(env);
if (env.height !== 1) throw new Error(`fixture baseline height ${env.height}`);

process.env['XLN_STORAGE_WRITE_TIMEOUT_MS'] = '1';
enqueueRuntimeInput(env, { runtimeTxs: [importTx('2')], entityInputs: [] });
let failure = '';
try {
  await processRuntime(env);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}

const state = ensureRuntimeState(env);
console.log(`STORAGE_TIMEOUT_RESULT:${JSON.stringify({
  failure,
  height: env.height,
  timestamp: env.timestamp,
  lifecycle: state.lifecyclePhase,
  fatalHeight: state.fatalDebugPayload?.height,
})}`);

// The timed-out write is deliberately not canceled. Give the real LevelDB
// operation time to settle so the parent can prove restart follows WAL truth,
// not the deliberately stale in-memory Runtime.
await Bun.sleep(250);
process.exit(0);
