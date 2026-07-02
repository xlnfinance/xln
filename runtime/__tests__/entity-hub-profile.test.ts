import { describe, expect, test } from 'bun:test';
import { createEmptyEnv, enqueueRuntimeInput, process } from '../runtime';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { encodeBoard, hashBoard } from '../entity-factory';
import { buildLocalEntityProfile } from '../networking/gossip-helper';
import type { ConsensusConfig, EntityState, HubRebalanceConfig } from '../types';

const ENTITY_SEED = 'entity-hub-profile-test-seed';
const SIGNER_LABEL = 'signer-1';
const TEST_RUN_ID = `${Date.now().toString(36)}-${process.pid}`;
let envCounter = 0;
const TEST_JURISDICTION = {
  address: 'rpc://entity-hub-profile',
  name: 'Testnet',
  chainId: 31337,
  entityProviderAddress: '0x00000000000000000000000000000000000000e1',
  depositoryAddress: '0x00000000000000000000000000000000000000d1',
};

const buildConsensusConfig = (signerId: string): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
  jurisdiction: TEST_JURISDICTION,
});

const findEntityState = (env: ReturnType<typeof createEmptyEnv>, entityId: string): EntityState => {
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    if (replicaKey.startsWith(`${entityId}:`)) {
      return replica.state;
    }
  }
  throw new Error(`ENTITY_STATE_NOT_FOUND: ${entityId}`);
};

const createHubProfileEnv = (label: string): ReturnType<typeof createEmptyEnv> => {
  const env = createEmptyEnv(`${label}-${TEST_RUN_ID}-${++envCounter}`);
  env.quietRuntimeLogs = true;
  return env;
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
    const env = createHubProfileEnv('entity-hub-profile-runtime');
    env.activeJurisdiction = TEST_JURISDICTION.name;
    env.jReplicas.set(TEST_JURISDICTION.name, {
      name: TEST_JURISDICTION.name,
      blockNumber: 0n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 },
      depositoryAddress: TEST_JURISDICTION.depositoryAddress,
      entityProviderAddress: TEST_JURISDICTION.entityProviderAddress,
      contracts: {
        account: '0x00000000000000000000000000000000000000a1',
        depository: TEST_JURISDICTION.depositoryAddress,
        entityProvider: TEST_JURISDICTION.entityProviderAddress,
        deltaTransformer: '0x00000000000000000000000000000000000000f1',
      },
      rpcs: [TEST_JURISDICTION.address],
      chainId: TEST_JURISDICTION.chainId,
    });
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

  test('hub gossip metadata carries stable hub name across display profile updates', async () => {
    const env = createHubProfileEnv('entity-hub-profile-hub-name-runtime');
    env.activeJurisdiction = TEST_JURISDICTION.name;
    env.jReplicas.set(TEST_JURISDICTION.name, {
      name: TEST_JURISDICTION.name,
      blockNumber: 0n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 },
      depositoryAddress: TEST_JURISDICTION.depositoryAddress,
      entityProviderAddress: TEST_JURISDICTION.entityProviderAddress,
      contracts: {
        account: '0x00000000000000000000000000000000000000a1',
        depository: TEST_JURISDICTION.depositoryAddress,
        entityProvider: TEST_JURISDICTION.entityProviderAddress,
        deltaTransformer: '0x00000000000000000000000000000000000000f1',
      },
      rpcs: [TEST_JURISDICTION.address],
      chainId: TEST_JURISDICTION.chainId,
    });
    const signerKey = deriveSignerKeySync(`${ENTITY_SEED}-hub-name`, SIGNER_LABEL);
    const signerId = deriveSignerAddressSync(`${ENTITY_SEED}-hub-name`, SIGNER_LABEL).toLowerCase();
    registerSignerKey(signerId, signerKey);

    const config = buildConsensusConfig(signerId);
    const entityId = hashBoard(encodeBoard(config));
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId,
        data: { config, isProposer: true, profileName: 'H1' },
      }],
      entityInputs: [],
    });
    await process(env);

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId,
        entityTxs: [{ type: 'setHubConfig', data: { ...DEFAULT_HUB_CONFIG, hubName: 'H1' } }],
      }],
    });
    await process(env);

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'profile-update',
          data: {
            profile: {
              entityId,
              name: 'Renamed Hub Display',
              avatar: '',
              bio: '',
              website: '',
            },
          },
        }],
      }],
    });
    await process(env);

    const stateAfterRename = findEntityState(env, entityId);
    const profile = buildLocalEntityProfile(env, stateAfterRename, 4);
    expect(profile.name).toBe('Renamed Hub Display');
    expect(profile.metadata.hubName).toBe('H1');
    expect(profile.metadata.isHub).toBe(true);
  });
});
