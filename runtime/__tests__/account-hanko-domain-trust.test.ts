import { describe, expect, test } from 'bun:test';
import { SigningKey, computeAddress } from 'ethers';

import { deriveSignerKeySync } from '../account/crypto';
import {
  getAccountStateDomain,
  requireAccountDeltaTransformerAddress,
} from '../account/consensus/helpers';
import { computeValidatorEncryptionAttestationDigest } from '../protocol/htlc/validator-encryption';
import { createEmptyEnv } from '../runtime';
import type { EntityReplica, JurisdictionConfig, JReplica, Profile } from '../types';

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
const ACCOUNT = {
  domain: {
    chainId: TRUSTED.chainId,
    depositoryAddress: TRUSTED.depositoryAddress,
  },
  proofHeader: { fromEntity: FROM, toEntity: TO },
};
const TRUSTED_ACCOUNT = '0x7777777777777777777777777777777777777777';
const TRUSTED_TRANSFORMER = '0x5555555555555555555555555555555555555555';
const HOSTILE_TRANSFORMER = '0x6666666666666666666666666666666666666666';
const HOSTILE_SIGNING_KEY = new SigningKey(
  `0x${Buffer.from(deriveSignerKeySync('account-hanko-hostile-profile', '1')).toString('hex')}`,
);
const HOSTILE_SIGNER = computeAddress(HOSTILE_SIGNING_KEY.publicKey).toLowerCase();
const HOSTILE_ATTESTATION_BODY = {
  version: 'xln:validator-encryption-key:v1' as const,
  entityId: FROM,
  signerId: HOSTILE_SIGNER,
  signer: HOSTILE_SIGNER,
  publicKey: HOSTILE_SIGNING_KEY.publicKey.toLowerCase(),
  weight: 1,
  encryptionPublicKey: `0x${'77'.repeat(32)}`,
};
const HOSTILE_ATTESTATION = {
  ...HOSTILE_ATTESTATION_BODY,
  signature: HOSTILE_SIGNING_KEY.sign(
    computeValidatorEncryptionAttestationDigest(HOSTILE_ATTESTATION_BODY),
  ).serialized.toLowerCase(),
};

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

const installJurisdictionReplica = (
  env: ReturnType<typeof createEmptyEnv>,
  key: string,
  jurisdiction: JurisdictionConfig,
  deltaTransformer?: string,
): void => {
  env.jReplicas.set(key, {
    name: key,
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: TRUSTED_ACCOUNT,
      ...(deltaTransformer ? { deltaTransformer } : {}),
    },
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
  });
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
    isHub: false,
    routingFeePPM: 0,
    baseFee: 0n,
    jurisdiction: HOSTILE,
    board: {
      threshold: 1,
      validators: [{
        signer: HOSTILE_SIGNER,
        weight: 1,
        signerId: HOSTILE_SIGNER,
        publicKey: HOSTILE_SIGNING_KEY.publicKey.toLowerCase(),
      }],
      encryptionAttestations: [HOSTILE_ATTESTATION],
    },
  },
});

describe('account Hanko trusted domain boundary', () => {
  test('derives the Hanko domain from committed Account state without local Entity replicas', () => {
    const env = createEmptyEnv('account-hanko-committed-domain');
    env.activeJurisdiction = HOSTILE.name;
    env.gossip.announce(hostileProfile());

    expect(getAccountStateDomain({
      domain: {
        chainId: TRUSTED.chainId,
        depositoryAddress: TRUSTED.depositoryAddress,
      },
      proofHeader: ACCOUNT.proofHeader,
    })).toEqual({
      chainId: TRUSTED.chainId,
      depositoryAddress: TRUSTED.depositoryAddress,
    });
  });

  test('ignores hostile gossip and active jurisdiction metadata', () => {
    const env = createEmptyEnv('account-hanko-trusted-domain');
    installReplica(env, `${FROM}:validator-a`, FROM, TRUSTED);
    env.activeJurisdiction = HOSTILE.name;
    env.gossip.announce(hostileProfile());
    installJurisdictionReplica(env, TRUSTED.name, TRUSTED, TRUSTED_TRANSFORMER);
    installJurisdictionReplica(env, HOSTILE.name, HOSTILE, HOSTILE_TRANSFORMER);

    expect(env.gossip.getProfiles()[0]?.metadata.jurisdiction).toEqual(HOSTILE);
    expect(getAccountStateDomain(ACCOUNT)).toEqual({
      chainId: TRUSTED.chainId,
      depositoryAddress: TRUSTED.depositoryAddress,
    });
    expect(requireAccountDeltaTransformerAddress(env, ACCOUNT)).toBe(TRUSTED_TRANSFORMER);
  });

  test('ignores conflicting local Entity replica domains', () => {
    const env = createEmptyEnv('account-hanko-conflicting-domain');
    installReplica(env, `${FROM}:validator-a`, FROM, TRUSTED);
    installReplica(env, `${TO}:validator-b`, TO, HOSTILE);

    expect(getAccountStateDomain(ACCOUNT)).toEqual({
      chainId: TRUSTED.chainId,
      depositoryAddress: TRUSTED.depositoryAddress,
    });
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

    expect(() => getAccountStateDomain({ domain: undefined } as never)).toThrow(
      'ACCOUNT_STATE_DOMAIN_INVALID',
    );
  });

  test('fails closed on a missing or duplicate exact jurisdiction contract record', () => {
    const missing = createEmptyEnv('account-proof-transformer-missing');
    installReplica(missing, `${FROM}:validator-a`, FROM, TRUSTED);
    installJurisdictionReplica(missing, TRUSTED.name, TRUSTED);
    expect(() => requireAccountDeltaTransformerAddress(missing, ACCOUNT)).toThrow(
      'JURISDICTION_DURABLE_STACK_DELTA_TRANSFORMER_MISSING',
    );

    const duplicate = createEmptyEnv('account-proof-transformer-duplicate');
    installReplica(duplicate, `${FROM}:validator-a`, FROM, TRUSTED);
    installJurisdictionReplica(duplicate, 'trusted-a', TRUSTED, TRUSTED_TRANSFORMER);
    installJurisdictionReplica(duplicate, 'trusted-b', TRUSTED, TRUSTED_TRANSFORMER);
    expect(() => requireAccountDeltaTransformerAddress(duplicate, ACCOUNT)).toThrow(
      'ACCOUNT_PROOF_JURISDICTION_AMBIGUOUS',
    );
  });

  test('never accepts live adapter identity as durable proof authority', () => {
    const env = createEmptyEnv('account-proof-adapter-is-not-authority');
    installReplica(env, `${FROM}:validator-a`, FROM, TRUSTED);
    env.jReplicas.set(TRUSTED.name, {
      name: TRUSTED.name,
      contracts: { deltaTransformer: TRUSTED_TRANSFORMER },
      jadapter: {
        chainId: TRUSTED.chainId,
        addresses: { depository: TRUSTED.depositoryAddress },
      },
      blockNumber: 0n,
      stateRoot: null,
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 },
    } as unknown as JReplica);

    expect(() => requireAccountDeltaTransformerAddress(env, ACCOUNT)).toThrow(
      'ACCOUNT_PROOF_JURISDICTION_NOT_FOUND',
    );
  });

  test('rejects a split durable stack instead of trusting address aliases', () => {
    const env = createEmptyEnv('account-proof-split-stack');
    installReplica(env, `${FROM}:validator-a`, FROM, TRUSTED);
    env.jReplicas.set(TRUSTED.name, {
      name: TRUSTED.name,
      chainId: TRUSTED.chainId,
      depositoryAddress: TRUSTED.depositoryAddress,
      entityProviderAddress: TRUSTED.entityProviderAddress,
      contracts: {
        depository: HOSTILE.depositoryAddress,
        entityProvider: TRUSTED.entityProviderAddress,
        account: TRUSTED_ACCOUNT,
        deltaTransformer: TRUSTED_TRANSFORMER,
      },
      blockNumber: 0n,
      stateRoot: null,
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 },
    });

    expect(() => requireAccountDeltaTransformerAddress(env, ACCOUNT)).toThrow(
      'JURISDICTION_DURABLE_STACK_DEPOSITORY_ALIAS_CONFLICT',
    );
  });
});
