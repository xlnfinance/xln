import { expect, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { encodeBoard, hashBoard } from '../../../entity/factory';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import { createEmptyEnv, enqueueRuntimeInput, processRuntime } from '../../../runtime';
import { setScenarioStorageEnabled } from '../../../scenarios/harness/helpers';
import type { EntityReplica } from '../../../entity/types';
import type { EntityTx } from '../../../types/entity-tx';

const TEST_JURISDICTION = {
  address: 'rpc://profile-recertify',
  name: 'ProfileRecertify',
  chainId: 31_337,
  entityProviderAddress: `0x${'e1'.repeat(20)}`,
  depositoryAddress: `0x${'d1'.repeat(20)}`,
};

const hubConfigTx = (): EntityTx => ({
  type: 'setHubConfig',
  data: {
    hubName: 'H1',
    matchingStrategy: 'amount',
    routingFeePPM: 1,
    baseFee: 0n,
    rebalanceLiquidityFeeBps: 1n,
    rebalanceTimeoutMs: 10 * 60 * 1000,
  },
});

const profileWitnessAt = (replica: EntityReplica, height: number): number =>
  [...(replica.hankoWitness?.values() ?? [])]
    .filter(entry => entry.type === 'profile' && entry.entityHeight === height)
    .length;

const findReplica = (env: ReturnType<typeof createEmptyEnv>, entityId: string): EntityReplica => {
  for (const replica of env.state.eReplicas.values()) {
    if (replica.entityId.toLowerCase() === entityId.toLowerCase()) return replica;
  }
  throw new Error(`TEST_PROFILE_RECERTIFY_REPLICA_MISSING:${entityId}`);
};

const drive = async (
  env: ReturnType<typeof createEmptyEnv>,
  entityId: string,
  signerId: string,
  entityTxs: EntityTx[],
): Promise<EntityReplica> => {
  enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: [{ entityId, signerId, entityTxs }],
  });
  await processRuntime(env);
  return findReplica(env, entityId);
};

test('gossip profile Hanko recertifies at genesis and when the advertised descriptor changes', async () => {
  const env = createEmptyEnv(`profile-recertify-${process.pid}`);
  env.quietRuntimeLogs = true;
  env.scenarioMode = true;
  setScenarioStorageEnabled(env, false);
  env.activeJurisdiction = TEST_JURISDICTION.name;
  env.state.jReplicas.set(TEST_JURISDICTION.name, {
    name: TEST_JURISDICTION.name,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
    contracts: {
      account: `0x${'a1'.repeat(20)}`,
      depository: TEST_JURISDICTION.depositoryAddress,
      entityProvider: TEST_JURISDICTION.entityProviderAddress,
      deltaTransformer: `0x${'f1'.repeat(20)}`,
    },
    rpcs: [TEST_JURISDICTION.address],
    chainId: TEST_JURISDICTION.chainId,
  });
  const signerId = deriveSignerAddressSync('profile-recertify-seed', 'signer-1').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync('profile-recertify-seed', 'signer-1'));
  const config = {
    mode: 'proposer-based' as const,
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
    jurisdiction: TEST_JURISDICTION,
  };
  const entityId = hashBoard(encodeBoard(config));
  enqueueRuntimeInput(env, {
    runtimeTxs: [createTestEntityImportRuntimeTx(env, {
      entityId,
      signerId,
      data: { config, isProposer: true, profileName: 'hub-under-test' },
    })],
    entityInputs: [],
  });
  await processRuntime(env);

  const genesis = await drive(env, entityId, signerId, [
    { type: 'chat', data: { from: signerId, message: 'genesis' } },
  ]);
  expect(genesis.state.height).toBe(1);
  expect(profileWitnessAt(genesis, 1)).toBe(1);

  const idle = await drive(env, entityId, signerId, [
    { type: 'chat', data: { from: signerId, message: 'idle' } },
  ]);
  expect(idle.state.height).toBe(2);
  expect(profileWitnessAt(idle, 2)).toBe(0);

  const recertified = await drive(env, entityId, signerId, [hubConfigTx()]);
  expect(recertified.state.height).toBe(3);
  expect(recertified.state.profile.isHub).toBe(true);
  expect(profileWitnessAt(recertified, 3)).toBe(1);
  expect(env.gossip.getHubs().some(profile => profile.entityId === entityId)).toBe(true);
});
