import { describe, expect, test } from 'bun:test';

import { getAccountStateDomain } from '../account/consensus/helpers';
import { createEmptyEnv } from '../runtime';
import type { EntityReplica, JurisdictionConfig, Profile } from '../types';

const FROM = `0x${'11'.repeat(32)}`;
const TO = `0x${'22'.repeat(32)}`;
const TRUSTED = {
  name: 'Trusted',
  chainId: 8453,
  depositoryAddress: '0x1111111111111111111111111111111111111111',
  entityProviderAddress: '0x2222222222222222222222222222222222222222',
} satisfies JurisdictionConfig;
const HOSTILE = {
  name: 'Hostile',
  chainId: 1,
  depositoryAddress: '0x3333333333333333333333333333333333333333',
  entityProviderAddress: '0x4444444444444444444444444444444444444444',
} satisfies JurisdictionConfig;
const ACCOUNT = { proofHeader: { fromEntity: FROM, toEntity: TO } };

const installReplica = (
  env: ReturnType<typeof createEmptyEnv>,
  key: string,
  entityId: string,
  jurisdiction: JurisdictionConfig,
): void => {
  env.eReplicas.set(key, {
    entityId,
    signerId: key.slice(-40),
    isProposer: true,
    mempool: [],
    state: { entityId, config: { jurisdiction } },
    hankoWitness: new Map(),
  } as EntityReplica);
};

const hostileProfile = (): Profile => ({
  entityId: FROM,
  name: 'Hostile peer metadata',
  avatar: '',
  bio: '',
  website: '',
  lastUpdated: 1,
  runtimeId: '0x5555555555555555555555555555555555555555',
  runtimeEncPubKey: `0x${'66'.repeat(32)}`,
  publicAccounts: [],
  wsUrl: null,
  relays: [],
  accounts: [],
  metadata: {
    entityEncPubKey: `0x${'77'.repeat(32)}`,
    isHub: false,
    routingFeePPM: 0,
    baseFee: 0n,
    jurisdiction: HOSTILE,
    board: {
      threshold: 1,
      validators: [{
        signer: '0x8888888888888888888888888888888888888888',
        weight: 1,
        signerId: '0x8888888888888888888888888888888888888888',
        publicKey: `0x${'99'.repeat(32)}`,
      }],
    },
  },
});

describe('account Hanko trusted domain boundary', () => {
  test('ignores hostile gossip and active jurisdiction metadata', () => {
    const env = createEmptyEnv('account-hanko-trusted-domain');
    installReplica(env, `${FROM}:validator-a`, FROM, TRUSTED);
    env.activeJurisdiction = HOSTILE.name;
    env.gossip.announce(hostileProfile());

    expect(env.gossip.getProfiles()[0]?.metadata.jurisdiction).toEqual(HOSTILE);
    expect(getAccountStateDomain(env, ACCOUNT)).toEqual({
      chainId: TRUSTED.chainId,
      depositoryAddress: TRUSTED.depositoryAddress,
    });
  });

  test('fails closed when local validator replicas certify conflicting domains', () => {
    const env = createEmptyEnv('account-hanko-conflicting-domain');
    installReplica(env, `${FROM}:validator-a`, FROM, TRUSTED);
    installReplica(env, `${TO}:validator-b`, TO, HOSTILE);

    expect(() => getAccountStateDomain(env, ACCOUNT)).toThrow(
      'ACCOUNT_STATE_DOMAIN_CONFLICT:8453:0x1111111111111111111111111111111111111111:1:0x3333333333333333333333333333333333333333',
    );
  });

  test('never falls back when no certified local Entity config exists', () => {
    const env = createEmptyEnv('account-hanko-missing-domain');
    env.activeJurisdiction = HOSTILE.name;
    env.gossip.announce(hostileProfile());
    env.browserVM = {
      getChainId: () => HOSTILE.chainId,
      getDepositoryAddress: () => HOSTILE.depositoryAddress,
    } as typeof env.browserVM;
    env.jReplicas.set(HOSTILE.name, {
      name: HOSTILE.name,
      chainId: HOSTILE.chainId,
      depositoryAddress: HOSTILE.depositoryAddress,
      blockNumber: 0n,
      stateRoot: null,
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 },
    });

    expect(() => getAccountStateDomain(env, ACCOUNT)).toThrow(
      'ACCOUNT_STATE_DOMAIN_TRUSTED_CONFIG_MISSING',
    );
  });
});
