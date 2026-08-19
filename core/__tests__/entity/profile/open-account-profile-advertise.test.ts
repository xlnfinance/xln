import { describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { deriveDelta } from '../../../account/utils';
import { getAccountPerspective } from '../../../account/state/perspective';
import { encodeBoard, hashBoard } from '../../../entity/factory';
import {
  buildEntityProfileDescriptor,
  computeEntityProfileDescriptorHash,
} from '../../../entity/profile/profile-descriptor';
import { computeProfileHash } from '../../../entity/profile/profile-signing';
import { buildLocalEntityProfile } from '../../../network/p2p/gossip/helper';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import { createEmptyEnv, enqueueRuntimeInput, processRuntime } from '../../../runtime';
import type { EntityReplica } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import { createTestJReplica } from '../../helpers/j-replica';

const TEST_JURISDICTION = {
  name: 'open-account-profile-advertise',
  address: 'rpc://open-account-profile-advertise',
  chainId: 31337,
  entityProviderAddress: '0x00000000000000000000000000000000000000e1',
  depositoryAddress: '0x00000000000000000000000000000000000000d1',
};

const replicaFor = (env: RuntimeReplica, entityId: string): EntityReplica => {
  for (const replica of env.state.eReplicas.values()) {
    if (replica.entityId.toLowerCase() === entityId.toLowerCase()) return replica;
  }
  throw new Error(`ENTITY_REPLICA_MISSING:${entityId}`);
};

const profileDump = (env: RuntimeReplica, replica: EntityReplica, hubId: string) => {
  const account = replica.state.accounts.get(hubId);
  const delta = account?.state.deltas.get(1);
  const derived = delta
    ? deriveDelta(delta, getAccountPerspective(account!.state, replica.state.entityId).iAmLeft)
    : null;
  const descriptor = buildEntityProfileDescriptor(replica.state);
  const descriptorHash = computeEntityProfileDescriptorHash(descriptor);
  const gossip = env.gossip.getProfiles().find(profile =>
    profile.entityId.toLowerCase() === replica.entityId.toLowerCase(),
  );
  const profileWitnesses = [...(replica.hankoWitness?.entries() ?? [])]
    .filter(([, entry]) => entry.type === 'profile')
    .map(([hash, entry]) => ({
      hash: hash.slice(0, 18),
      height: entry.entityHeight,
    }));
  return {
    entityHeight: replica.state.height,
    pinned: account?.publicPinned === true,
    accountHeight: account?.currentHeight ?? 0,
    pending: Boolean(account?.pendingFrame),
    leftCredit: delta?.leftCreditLimit?.toString() ?? null,
    rightCredit: delta?.rightCreditLimit?.toString() ?? null,
    liquidity: derived ? (derived.inCapacity + derived.outCapacity).toString() : null,
    descriptorAccounts: descriptor.accounts.map(row => row.counterpartyId.toLowerCase()),
    descriptorHash: descriptorHash.slice(0, 18),
    gossipAccounts: (gossip?.accounts ?? []).map(row => String(row.counterpartyId || '').toLowerCase()),
    witnessAtCurrentHeight: profileWitnesses.some(entry => entry.height === replica.state.height),
    witnessHasDescriptorHash: replica.hankoWitness?.get(descriptorHash)?.type === 'profile',
    localProfileHash: computeProfileHash(buildLocalEntityProfile(env, replica.state, 1)).slice(0, 18),
    profileWitnesses,
  };
};

describe('openAccount profile advertise', () => {
  test('committed hub account is pinned, liquid, signed, and gossiped', async () => {
    const env = createEmptyEnv(`open-account-profile-advertise-${process.pid}`);
    env.quietRuntimeLogs = true;
    env.activeJurisdiction = TEST_JURISDICTION.name;
    env.state.jReplicas.set(TEST_JURISDICTION.name, createTestJReplica({
      name: TEST_JURISDICTION.name,
      chainId: TEST_JURISDICTION.chainId,
      rpcs: [TEST_JURISDICTION.address],
      contracts: {
        depository: TEST_JURISDICTION.depositoryAddress,
        entityProvider: TEST_JURISDICTION.entityProviderAddress,
        account: '0x00000000000000000000000000000000000000a1',
        deltaTransformer: '0x00000000000000000000000000000000000000f1',
      },
    }));

    const userSigner = deriveSignerAddressSync('user-seed', '1').toLowerCase();
    const hubSigner = deriveSignerAddressSync('hub-seed', '1').toLowerCase();
    registerSignerKey(env, userSigner, deriveSignerKeySync('user-seed', '1'));
    registerSignerKey(env, hubSigner, deriveSignerKeySync('hub-seed', '1'));

    const consensus = (signerId: string) => ({
      mode: 'proposer-based' as const,
      threshold: 1n,
      validators: [signerId],
      shares: { [signerId]: 1n },
      jurisdiction: TEST_JURISDICTION,
    });
    const userEntityId = hashBoard(encodeBoard(consensus(userSigner))).toLowerCase();
    const hubEntityId = hashBoard(encodeBoard(consensus(hubSigner))).toLowerCase();

    enqueueRuntimeInput(env, {
      runtimeTxs: [
        createTestEntityImportRuntimeTx(env, {
          entityId: userEntityId,
          signerId: userSigner,
          data: { config: consensus(userSigner), isProposer: true, profileName: 'User' },
        }),
        createTestEntityImportRuntimeTx(env, {
          entityId: hubEntityId,
          signerId: hubSigner,
          data: { config: consensus(hubSigner), isProposer: true, profileName: 'Hub' },
        }),
      ],
      entityInputs: [],
    });
    await processRuntime(env);
    await processRuntime(env);

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: userEntityId,
        signerId: userSigner,
        entityTxs: [{
          type: 'openAccount',
          data: {
            targetEntityId: hubEntityId,
            creditAmount: 10_000n,
            tokenId: 1,
            disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
          },
        }],
      }],
    });

    for (let i = 0; i < 24; i += 1) {
      await processRuntime(env, []);
      const user = replicaFor(env, userEntityId);
      const account = user.state.accounts.get(hubEntityId);
      if (account && account.currentHeight > 0 && !account.pendingFrame) break;
    }

    const user = replicaFor(env, userEntityId);
    const dump = profileDump(env, user, hubEntityId);
    expect(dump.pinned, `pinned ${JSON.stringify(dump)}`).toBe(true);
    expect(dump.accountHeight, `accountHeight ${JSON.stringify(dump)}`).toBeGreaterThan(0);
    expect(dump.pending, `pending ${JSON.stringify(dump)}`).toBe(false);
    expect(dump.witnessHasDescriptorHash, `descriptor hash unsigned ${JSON.stringify(dump)}`).toBe(true);
    expect(dump.descriptorAccounts, `descriptor ${JSON.stringify(dump)}`).toContain(hubEntityId);
    expect(dump.gossipAccounts, `gossip ${JSON.stringify(dump)}`).toContain(hubEntityId);
    expect(BigInt(dump.liquidity ?? '0'), `liquidity ${JSON.stringify(dump)}`).toBeGreaterThan(0n);
  });
});
