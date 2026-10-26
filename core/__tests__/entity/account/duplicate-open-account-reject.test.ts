import { expect, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import { createEmptyEnv, enqueueRuntimeInput, processRuntime } from '../../../runtime';
import { createTestJReplica } from '../../helpers/j-replica';

// A wallet host opens the first hub Account automatically while the user (or
// another tab) may open the same Account. The second openAccount is a typed
// reject of that one tx: the Runtime keeps running and keeps the first Account.
test('a duplicate openAccount is rejected without halting the Runtime', async () => {
  const seed = `duplicate-open-account-${process.pid}-${Date.now()}`;
  const env = createEmptyEnv(seed);
  env.quietRuntimeLogs = true;
  env.state.timestamp = 1_000;
  env.runtimeConfig = { ...env.runtimeConfig, storage: { ...env.runtimeConfig?.storage, enabled: false } };
  const [user, hub] = [1, 2].map(index => {
    const signerId = deriveSignerAddressSync(seed, String(index)).toLowerCase();
    registerSignerKey(env, signerId, deriveSignerKeySync(seed, String(index)));
    return { signerId, entityId: generateLazyEntityId([signerId], 1n).toLowerCase() };
  });
  if (!user || !hub) throw new Error('DUPLICATE_OPEN_OWNERS_MISSING');
  const jurisdiction = {
    name: 'duplicate-open-account', address: 'browservm://duplicate-open-account', chainId: 31337,
    depositoryAddress: '0x000000000000000000000000000000000000dEaD',
    entityProviderAddress: '0x000000000000000000000000000000000000bEEF',
  };
  env.activeJurisdiction = jurisdiction.name;
  env.state.jReplicas.set(jurisdiction.name, createTestJReplica({
    name: jurisdiction.name, chainId: jurisdiction.chainId,
    contracts: { depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress,
      account: '0x000000000000000000000000000000000000ac01',
      deltaTransformer: '0x000000000000000000000000000000000000de17' },
  }));
  const drain = async () => {
    for (let step = 0; step < 12; step += 1) await processRuntime(env, []);
  };
  enqueueRuntimeInput(env, {
    runtimeTxs: [user, hub].map(({ entityId, signerId }) => createTestEntityImportRuntimeTx(env, {
      entityId, signerId, data: { isProposer: true, config: {
        mode: 'proposer-based', threshold: 1n, validators: [signerId], shares: { [signerId]: 1n }, jurisdiction,
      } },
    })), entityInputs: [],
  });
  await processRuntime(env, []);
  const openAccount = (creditAmount: bigint) => ({ type: 'openAccount' as const, data: {
    targetEntityId: hub.entityId, creditAmount, tokenId: 1,
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  } });
  enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{ ...user, entityTxs: [openAccount(1000n)] }] });
  await drain();
  const userReplica = () => [...env.state.eReplicas.values()].find(replica => replica.entityId === user.entityId);
  const opened = userReplica()?.state.accounts.get(hub.entityId);
  expect(opened).toBeDefined();

  enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{ ...user, entityTxs: [openAccount(5n)] }] });
  await drain();
  expect(env.infrastructure?.halted).toBeFalsy();
  expect(userReplica()?.mempool ?? []).toHaveLength(0);
  expect(userReplica()?.state.accounts.get(hub.entityId)?.state.deltas)
    .toEqual(opened?.state.deltas);
}, 30_000);
