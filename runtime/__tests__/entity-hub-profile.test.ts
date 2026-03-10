import { describe, expect, test } from 'bun:test';
import { createEmptyEnv, enqueueRuntimeInput, process } from '../runtime';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { encodeBoard, hashBoard } from '../entity-factory';
import { buildLocalEntityProfile } from '../networking/gossip-helper';
import type { ConsensusConfig, EntityState, HubRebalanceConfig } from '../types';

const ENTITY_SEED = 'entity-hub-profile-test-seed';
const SIGNER_LABEL = 'signer-1';

const buildConsensusConfig = (signerId: string): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
});

const findEntityState = (env: ReturnType<typeof createEmptyEnv>, entityId: string): EntityState => {
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    if (replicaKey.startsWith(`${entityId}:`)) {
      return replica.state;
    }
  }
  throw new Error(`ENTITY_STATE_NOT_FOUND: ${entityId}`);
};

const DEFAULT_HUB_CONFIG: HubRebalanceConfig = {
  matchingStrategy: 'amount',
  policyVersion: 1,
  routingFeePPM: 1000,
  baseFee: 0n,
  rebalanceBaseFee: 10n ** 17n,
  rebalanceLiquidityFeeBps: 1n,
  rebalanceGasFee: 0n,
  rebalanceTimeoutMs: 10 * 60 * 1000,
};

describe('entity hub profile classification', () => {
  test('hub status is explicit state, not implied by hub config alone', async () => {
    const env = createEmptyEnv('entity-hub-profile-runtime');
    const signerKey = deriveSignerKeySync(ENTITY_SEED, SIGNER_LABEL);
    const signerId = deriveSignerAddressSync(ENTITY_SEED, SIGNER_LABEL).toLowerCase();
    registerSignerKey(signerId, signerKey);

    const config = buildConsensusConfig(signerId);
    const entityId = hashBoard(encodeBoard(config));

    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          config,
          isProposer: true,
          profileName: 'Test Entity',
        },
      }],
      entityInputs: [],
    });
    await process(env);

    const stateBefore = findEntityState(env, entityId);
    expect(stateBefore.profile.isHub).toBe(false);
    expect(buildLocalEntityProfile(env, stateBefore, 1).metadata.isHub).toBe(false);

    stateBefore.hubRebalanceConfig = { ...DEFAULT_HUB_CONFIG };
    expect(buildLocalEntityProfile(env, stateBefore, 2).metadata.isHub).toBe(false);

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'setHubConfig',
          data: { ...DEFAULT_HUB_CONFIG },
        }],
      }],
    });
    await process(env);

    const stateAfter = findEntityState(env, entityId);
    expect(stateAfter.profile.isHub).toBe(true);
    expect(buildLocalEntityProfile(env, stateAfter, 3).metadata.isHub).toBe(true);
    expect(env.gossip.getHubs().some((profile) => profile.entityId === entityId)).toBe(true);
  });
});
