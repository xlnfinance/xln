import { expect, test } from 'bun:test';

import {
  createEmptyEnv,
  enqueueRuntimeInput,
  process as processRuntime,
} from '../runtime';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import { buildCanonicalEnvSnapshot } from '../wal/snapshot';
import {
  appendRecentRuntimeSnapshot,
  RECENT_RUNTIME_HISTORY_LIMIT,
  startRuntimeHistoryTraceForTesting,
} from '../history-retention';

test('recent snapshot helper enforces its exact bound and rejects invalid limits', () => {
  const first = { height: 1 } as never;
  const second = { height: 2 } as never;
  expect(appendRecentRuntimeSnapshot([first], second, 1)).toEqual([second]);
  expect(() => appendRecentRuntimeSnapshot([], second, 0))
    .toThrow('RUNTIME_HISTORY_LIMIT_INVALID:0');
});

test('production Env retains only the latest 256 canonical snapshots', async () => {
  const seed = 'bounded runtime history alpha beta gamma';
  const env = createEmptyEnv(seed);
  env.runtimeConfig = {
    ...(env.runtimeConfig || {}),
    storage: { ...(env.runtimeConfig?.storage || {}), enabled: false },
  };
  if (env.runtimeState) env.runtimeState.persistencePaused = true;
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;

  const seedSnapshot = buildCanonicalEnvSnapshot(env, {
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    runtimeOutputs: [],
    description: 'seed-0',
    logs: [],
    gossipProfiles: [],
  });
  env.history = Array.from({ length: RECENT_RUNTIME_HISTORY_LIMIT }, (_, index) => ({
    ...seedSnapshot,
    description: `seed-${index}`,
  }));

  const signer = deriveSignerAddressSync(seed, '1');
  registerSignerKey(env, signer, deriveSignerKeySync(seed, '1'));
  const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
  const jurisdiction = {
    name: 'bounded-history-test',
    chainId: 31_337,
    depositoryAddress: '0x000000000000000000000000000000000000dEaD',
    entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
  };
  env.activeJurisdiction = jurisdiction.name;
  env.jReplicas.set(jurisdiction.name, {
    ...jurisdiction,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
    },
  } as never);
  enqueueRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importReplica',
      entityId,
      signerId: signer,
      data: {
        isProposer: true,
        config: {
          mode: 'proposer-based',
          threshold: 1n,
          validators: [signer],
          shares: { [signer]: 1n },
          jurisdiction,
        },
      },
    }],
    entityInputs: [],
  });

  const trace = startRuntimeHistoryTraceForTesting(env);
  await processRuntime(env, []);
  trace.stop();

  expect(env.height).toBe(1);
  expect(env.history).toHaveLength(RECENT_RUNTIME_HISTORY_LIMIT);
  expect(env.history[0]?.description).toBe('seed-1');
  expect(env.history.at(-1)?.height).toBe(1);
  expect(trace.snapshots).toHaveLength(1);
  expect(trace.snapshots[0]?.height).toBe(1);
});
