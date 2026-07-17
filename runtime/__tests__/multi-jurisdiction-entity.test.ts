import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';

import {
  buildDebtEnforcementRuntimeInput,
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  process as processRuntime,
} from '../runtime';
import { applyEntityTx } from '../entity/tx/apply';
import {
  getJReplicaByJurisdictionRef,
  getJurisdictionIdentityRef,
  sameJurisdictionIdentity,
} from '../jurisdiction/jurisdiction-runtime';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  getLocalSignerPrivateKey,
  getSignerAddress,
  registerSignerKey,
} from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import { getEntityConfigBoardHash } from '../hanko/signing';
import { DEFAULT_ACCOUNT_TOKEN_IDS } from '../account/default-tokens';
import { accountStateDomainFromJurisdiction } from '../account/state-root';
import type { JAdapter } from '../jadapter/types';
import { canonicalizeProfile, parseProfile } from '../networking/gossip';
import { computeValidatorEncryptionAttestationDigest } from '../protocol/htlc/validator-encryption';
import type { ConsensusConfig, Env, JReplica, JurisdictionConfig } from '../types';
import { installCanonicalRegistrationEvidence } from './helpers/registration-evidence';
import { resolveDbPath } from '../storage/runtime-dbs';
import { SigningKey, computeAddress } from 'ethers';

const addr = (byte: string): string => `0x${byte.repeat(20)}`;
const entity = (byte: string): string => `0x${byte.repeat(32)}`;
let envSequence = 0;
const createdEnvs: Env[] = [];

const cleanupEnvStorage = (env: Env): void => {
  const base = resolveDbPath(env, 'core');
  for (const suffix of ['', '-storage-current', '-storage-previous', '-frames', '-events', '-infra']) {
    rmSync(`${base}${suffix}`, { recursive: true, force: true });
  }
};

afterEach(async () => {
  while (createdEnvs.length > 0) {
    const env = createdEnvs.pop()!;
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    cleanupEnvStorage(env);
  }
});

const makeJurisdiction = (name: string, chainId: number, depByte: string, epByte: string): JurisdictionConfig => ({
  name,
  address: `rpc://${name}`,
  chainId,
  depositoryAddress: addr(depByte),
  entityProviderAddress: addr(epByte),
});

const installJurisdiction = (env: Env, jurisdiction: JurisdictionConfig, jadapter?: Partial<JAdapter>): void => {
  const adapter = jadapter
    ? {
        setBlockTimestamp: () => {},
        isWatching: () => false,
        startWatching: () => {},
        stopWatching: () => {},
        stopWatchingAndWait: async () => {},
        ...jadapter,
      } as Partial<JAdapter> & { setBlockTimestamp: () => void }
    : undefined;
  env.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    rpcs: [jurisdiction.address],
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: addr('aa'),
      deltaTransformer: addr('bb'),
    },
    ...(jurisdiction.blockTimeMs !== undefined ? { blockTimeMs: jurisdiction.blockTimeMs } : {}),
    watcherConfirmationDepth: 0,
    ...(adapter ? { jadapter: adapter as JAdapter } : {}),
  } as JReplica);
};

const makeConfig = (signerId: string, jurisdiction: JurisdictionConfig): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
  jurisdiction,
});

const makeEnv = (label: string): Env => {
  const unique = `${label}-${process.pid}-${++envSequence}`;
  const env = createEmptyEnv(unique);
  env.dbNamespace = unique;
  env.quietRuntimeLogs = true;
  cleanupEnvStorage(env);
  createdEnvs.push(env);
  return env;
};

const canonicalLocalSigner = (env: Env, signerId: string): string => {
  const privateKey = getLocalSignerPrivateKey(env, signerId);
  if (!privateKey) throw new Error(`TEST_SIGNER_KEY_MISSING:${signerId}`);
  const address = getSignerAddress(env, signerId);
  if (!address) throw new Error(`TEST_SIGNER_ADDRESS_MISSING:${signerId}`);
  return address.toLowerCase();
};

const evidenceActivationHeight = (entityId: string): number =>
  5 + Number(BigInt(entityId) & 0xff_ffffn);

const profileBoard = (entityId: string, label: string) => {
  const key = new SigningKey(deriveSignerKeySync(`multi-j-profile:${label}`, '1'));
  const publicKey = key.publicKey.toLowerCase();
  const signer = computeAddress(publicKey).toLowerCase();
  const body = {
    version: 'xln:validator-encryption-key:v1' as const,
    entityId,
    signerId: signer,
    signer,
    publicKey,
    weight: 1,
    encryptionPublicKey: `0x${'61'.repeat(32)}`,
  };
  return {
    threshold: 1,
    validators: [{ signer, signerId: signer, weight: 1, publicKey }],
    encryptionAttestations: [{
      ...body,
      signature: key.sign(computeValidatorEncryptionAttestationDigest(body)).serialized,
    }],
  };
};

describe('multi-jurisdiction entity binding', () => {
  test('jurisdiction identity uses stack refs before display names', () => {
    const canonical = makeJurisdiction('Testnet', 31337, '11', '12');
    const relabeled = { ...canonical, name: 'Renamed Local Chain' };
    const conflicting = makeJurisdiction('Testnet', 31338, '21', '22');

    expect(getJurisdictionIdentityRef(canonical)).toBe(`stack:31337:${addr('11')}`);
    expect(sameJurisdictionIdentity(canonical, relabeled)).toBe(true);
    expect(sameJurisdictionIdentity(canonical, { name: canonical.name })).toBe(false);
    expect(sameJurisdictionIdentity(canonical, conflicting)).toBe(false);
    expect(sameJurisdictionIdentity({ name: canonical.name }, { name: 'testnet' })).toBe(false);
  });

  test('stack ref lookup cannot be captured by a display-name collision', () => {
    const env = createEmptyEnv('jurisdiction-stack-ref-name-collision');
    const canonical = makeJurisdiction('Canonical', 31337, '11', '12');
    const canonicalRef = getJurisdictionIdentityRef(canonical);
    const collision = {
      ...makeJurisdiction(canonicalRef, 31338, '21', '22'),
      name: canonicalRef,
    };
    installJurisdiction(env, collision);
    installJurisdiction(env, canonical);

    const resolved = getJReplicaByJurisdictionRef(env, canonicalRef);

    expect(resolved?.name).toBe('Canonical');
    expect(resolved?.depositoryAddress).toBe(canonical.depositoryAddress);
    expect(getJReplicaByJurisdictionRef(env, 'Canonical')).toBeUndefined();
  });

  test('importReplica preserves committed block time over a validator-local estimate', async () => {
    const env = makeEnv('jurisdiction-block-time-binding');
    const trusted = { ...makeJurisdiction('J1', 31337, '11', '12'), blockTimeMs: 1_234 };
    installJurisdiction(env, trusted);
    env.activeJurisdiction = trusted.name;

    const incoming: JurisdictionConfig = { ...trusted, blockTimeMs: 9_876 };
    const entityId = entity('03');
    await importEntity(env, entityId, '33', incoming);

    expect(findState(env, entityId)?.config.jurisdiction?.blockTimeMs).toBe(9_876);
  });

  const importEntity = async (
    env: Env,
    entityId: string,
    signerId: string,
    jurisdiction: JurisdictionConfig,
  ): Promise<string> => {
    const canonicalSignerId = canonicalLocalSigner(env, signerId);
    const config = makeConfig(canonicalSignerId, jurisdiction);
    const boardHash = await getEntityConfigBoardHash(env, config);
    if (boardHash !== entityId.toLowerCase()) {
      await installCanonicalRegistrationEvidence(env, jurisdiction, entityId, boardHash, {
        activationHeight: evidenceActivationHeight(entityId),
      });
    }
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId: canonicalSignerId,
        data: {
          isProposer: true,
          config,
        },
      }],
      entityInputs: [],
    });
    await processRuntime(env);
    return canonicalSignerId;
  };

  const findState = (env: Env, entityId: string) =>
    Array.from(env.eReplicas.values()).find((replica) => replica.state.entityId === entityId)?.state;

  test('rejects importing the same entity into a second jurisdiction', async () => {
    const env = makeEnv('multi-jurisdiction-conflict');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    const j2 = makeJurisdiction('J2', 31338, '21', '22');
    installJurisdiction(env, j1);
    installJurisdiction(env, j2);
    env.activeJurisdiction = 'J1';

    const entityId = entity('01');
    const signerId = await importEntity(env, entityId, '31', j1);

    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          isProposer: true,
          config: makeConfig(signerId, j2),
        },
      }],
      entityInputs: [],
    });
    await expect(processRuntime(env)).rejects.toThrow('ENTITY_JURISDICTION_CONFLICT');
  });

  test('openAccount permits only same-jurisdiction counterparties', async () => {
    const env = makeEnv('multi-jurisdiction-open-ok');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    installJurisdiction(env, j1);
    env.activeJurisdiction = 'J1';

    const entityA = entity('05');
    const entityB = entity('06');
    const signerA = '35';
    const signerB = '36';
    await importEntity(env, entityA, signerA, j1);
    await importEntity(env, entityB, signerB, j1);

    const result = await applyEntityTx(env, findState(env, entityA)!, {
      type: 'openAccount',
      data: {
        targetEntityId: entityB,
        accountDomain: accountStateDomainFromJurisdiction(j1),
        watchSeed: `0x${'51'.repeat(32)}`,
      },
    });

    expect(result.newState.accounts.has(entityB.toLowerCase())).toBe(true);
  });

  test('openAccount replay is identical with and without the counterparty replica', async () => {
    const full = makeEnv('account-domain-topology-full');
    const sparse = makeEnv('account-domain-topology-sparse');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    installJurisdiction(full, j1);
    installJurisdiction(sparse, j1);
    const entityA = entity('61');
    const entityB = entity('62');
    await importEntity(full, entityA, '71', j1);
    await importEntity(full, entityB, '72', j1);
    await importEntity(sparse, entityA, '71', j1);
    const tx = {
      type: 'openAccount' as const,
      data: {
        targetEntityId: entityB,
        accountDomain: accountStateDomainFromJurisdiction(j1),
        watchSeed: `0x${'63'.repeat(32)}`,
      },
    };

    const [fullResult, sparseResult] = await Promise.all([
      applyEntityTx(full, findState(full, entityA)!, tx),
      applyEntityTx(sparse, findState(sparse, entityA)!, tx),
    ]);

    expect(sparseResult.newState.accounts.get(entityB)).toEqual(
      fullResult.newState.accounts.get(entityB),
    );
  });

  test('openAccount seeds default token deltas and rebalance policies', async () => {
    const env = makeEnv('multi-jurisdiction-open-default-tokens');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    installJurisdiction(env, j1);
    env.activeJurisdiction = 'J1';

    const entityA = entity('15');
    const entityB = entity('16');
    const signerA = '45';
    const signerB = '46';
    await importEntity(env, entityA, signerA, j1);
    await importEntity(env, entityB, signerB, j1);

    const result = await applyEntityTx(env, findState(env, entityA)!, {
      type: 'openAccount',
      data: {
        targetEntityId: entityB,
        accountDomain: accountStateDomainFromJurisdiction(j1),
        watchSeed: `0x${'52'.repeat(32)}`,
        tokenId: 1,
        creditAmount: 1_000n,
      },
    });

    const account = result.newState.accounts.get(entityB.toLowerCase());
    expect(account).toBeTruthy();
    const expectedTokenIds = [...DEFAULT_ACCOUNT_TOKEN_IDS].sort((a, b) => a - b);
    const addDeltaTokenIds = account!.mempool
      .filter((tx) => tx.type === 'add_delta')
      .map((tx) => tx.data.tokenId)
      .sort((a, b) => a - b);
    const policyTokenIds = Array.from(account!.shadow.rebalance.policy.keys()).sort((a, b) => a - b);
    expect(addDeltaTokenIds).toEqual(expectedTokenIds);
    expect(policyTokenIds).toEqual(expectedTokenIds);
    expect(account!.shadow.rebalance.policy.get(1)).toEqual({
      r2cRequestSoftLimit: 500n * 10n ** 6n,
      hardLimit: 10_000n * 10n ** 6n,
      maxAcceptableFee: 15n * 10n ** 6n,
    });
    expect(account!.shadow.rebalance.policy.get(2)).toEqual({
      r2cRequestSoftLimit: 500n * 10n ** 18n,
      hardLimit: 10_000n * 10n ** 18n,
      maxAcceptableFee: 15n * 10n ** 18n,
    });
  });

  test('openAccount commits the first bilateral frame for local same-jurisdiction entities', async () => {
    const env = makeEnv('multi-jurisdiction-open-handshake');
    env.scenarioMode = true;
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    installJurisdiction(env, j1);
    env.activeJurisdiction = 'J1';

    const seed = `multi-jurisdiction-open-handshake-${Date.now()}`;
    const signerA = deriveSignerAddressSync(seed, '1');
    const signerB = deriveSignerAddressSync(seed, '2');
    registerSignerKey(env, signerA, deriveSignerKeySync(seed, '1'));
    registerSignerKey(env, signerB, deriveSignerKeySync(seed, '2'));
    const entityA = generateLazyEntityId([signerA], 1n).toLowerCase();
    const entityB = generateLazyEntityId([signerB], 1n).toLowerCase();
    await importEntity(env, entityA, signerA, j1);
    await importEntity(env, entityB, signerB, j1);

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: entityA,
        signerId: signerA,
        entityTxs: [{
          type: 'openAccount',
          data: { targetEntityId: entityB, tokenId: 1, creditAmount: 1_000n },
        }],
      }],
    });

    for (let i = 0; i < 6; i += 1) {
      await processRuntime(env);
      const accountA = findState(env, entityA)?.accounts.get(entityB);
      const accountB = findState(env, entityB)?.accounts.get(entityA);
      if (Number(accountA?.currentHeight ?? 0) > 0 && Number(accountB?.currentHeight ?? 0) > 0) break;
    }

    const accountA = findState(env, entityA)?.accounts.get(entityB);
    const accountB = findState(env, entityB)?.accounts.get(entityA);
    expect(accountA?.currentHeight).toBe(1);
    expect(accountB?.currentHeight).toBe(1);
    expect(accountA?.pendingFrame).toBeUndefined();
    expect(accountB?.pendingFrame).toBeUndefined();
  });

  test('configured Hub publishes fee policy only after inbound Account genesis commits', async () => {
    const env = makeEnv('multi-jurisdiction-open-hub-policy');
    env.scenarioMode = true;
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    installJurisdiction(env, j1);
    env.activeJurisdiction = 'J1';

    const seed = 'multi-jurisdiction-open-hub-policy';
    const signerUser = deriveSignerAddressSync(seed, '1');
    const signerHub = deriveSignerAddressSync(seed, '2');
    registerSignerKey(env, signerUser, deriveSignerKeySync(seed, '1'));
    registerSignerKey(env, signerHub, deriveSignerKeySync(seed, '2'));
    const userId = generateLazyEntityId([signerUser], 1n).toLowerCase();
    const hubId = generateLazyEntityId([signerHub], 1n).toLowerCase();
    await importEntity(env, userId, signerUser, j1);
    await importEntity(env, hubId, signerHub, j1);
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: hubId,
        signerId: signerHub,
        entityTxs: [{
          type: 'setHubConfig',
          data: { policyVersion: 3, routingFeePPM: 1, rebalanceLiquidityFeeBps: 5n },
        }],
      }],
    });
    for (let i = 0; i < 3 && !findState(env, hubId)?.hubRebalanceConfig; i += 1) {
      await processRuntime(env);
    }
    expect(findState(env, hubId)?.hubRebalanceConfig?.policyVersion).toBe(3);

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: userId,
        signerId: signerUser,
        entityTxs: [{ type: 'openAccount', data: { targetEntityId: hubId, tokenId: 1 } }],
      }],
    });

    for (let i = 0; i < 12; i += 1) {
      await processRuntime(env);
      const userAccount = findState(env, userId)?.accounts.get(hubId);
      const hubAccount = findState(env, hubId)?.accounts.get(userId);
      if (
        Number(userAccount?.currentHeight ?? 0) >= 2 && !userAccount?.pendingFrame &&
        Number(hubAccount?.currentHeight ?? 0) >= 2 && !hubAccount?.pendingFrame
      ) break;
    }

    const userAccount = findState(env, userId)?.accounts.get(hubId);
    const hubAccount = findState(env, hubId)?.accounts.get(userId);
    expect(userAccount?.currentHeight).toBe(2);
    expect(hubAccount?.currentHeight).toBe(2);
    expect(userAccount?.currentFrame.accountTxs.every((tx) => tx.type === 'rebalance_policy')).toBe(true);
    const hubSide = hubId === userAccount?.leftEntity ? 'left' : 'right';
    expect(userAccount?.rebalanceFeePolicies?.get(1)?.[hubSide]).toEqual({
      policyVersion: 3,
      baseFee: 100_000n,
      liquidityFeeBps: 5n,
      gasFee: 0n,
      updatedAt: userAccount?.currentFrame.timestamp,
    });
    expect(hubAccount?.rebalanceFeePolicies).toEqual(userAccount?.rebalanceFeePolicies);
  });

  test('incoming Account genesis rejects a domain from another jurisdiction', async () => {
    const env = makeEnv('multi-jurisdiction-open-cross');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    const j2 = makeJurisdiction('J2', 31338, '21', '22');
    installJurisdiction(env, j1);
    installJurisdiction(env, j2);

    const entityA = entity('07');
    const entityB = entity('08');
    const signerA = '37';
    const signerB = '38';
    await importEntity(env, entityA, signerA, j1);
    await importEntity(env, entityB, signerB, j2);

    const result = await applyEntityTx(env, findState(env, entityB)!, {
      type: 'accountInput',
      data: {
        kind: 'frame',
        fromEntityId: entityA,
        toEntityId: entityB,
        domain: accountStateDomainFromJurisdiction(j1),
        watchSeed: `0x${'73'.repeat(32)}`,
        proposal: {
          frameHanko: '0x',
          frame: {
            height: 1,
            timestamp: 1,
            jHeight: 0,
            accountTxs: [],
            prevFrameHash: 'genesis',
            accountStateRoot: `0x${'00'.repeat(32)}`,
            stateHash: `0x${'01'.repeat(32)}`,
            deltas: [],
            byLeft: true,
          },
        },
      },
    } as never);

    expect(result.skippedError).toContain('ACCOUNT_INPUT_DOMAIN_MISMATCH');
    expect(result.newState.accounts.has(entityA.toLowerCase())).toBe(false);
  });

  test('accountInput for an unknown non-genesis account requires account-chain sync', async () => {
    const env = makeEnv('multi-jurisdiction-account-input-sync-required');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    installJurisdiction(env, j1);

    const entityA = entity('17');
    const entityB = entity('18');
    await importEntity(env, entityA, '47', j1);
    await importEntity(env, entityB, '48', j1);

    const overlayStart = env.overlay?.length ?? 0;
    const result = await applyEntityTx(env, findState(env, entityA)!, {
      type: 'accountInput',
      data: {
        kind: 'frame',
        fromEntityId: entityB,
        toEntityId: entityA,
        domain: accountStateDomainFromJurisdiction(j1),
        proposal: {
          frameHanko: '0x',
          frame: {
            height: 2,
            timestamp: 1,
            jHeight: 0,
            accountTxs: [],
            prevFrameHash: `0x${'aa'.repeat(32)}`,
            accountStateRoot: `0x${'cc'.repeat(32)}`,
            stateHash: `0x${'bb'.repeat(32)}`,
            deltas: [],
            byLeft: false,
          },
        },
      },
    } as never);

    expect(result.skippedError).toContain('ACCOUNT_SYNC_REQUIRED');
    expect(result.newState.messages.some((message) => message.includes('ACCOUNT_SYNC_REQUIRED'))).toBe(true);
    expect(result.newState.accounts.has(entityB.toLowerCase())).toBe(false);
    expect((env.overlay ?? []).slice(overlayStart).some((record) => record.family === 'account')).toBe(false);
  });

  test('debt enforcement RuntimeInput uses the entity jurisdiction instead of active jurisdiction', async () => {
    const env = makeEnv('multi-jurisdiction-debt');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    const j2 = makeJurisdiction('J2', 31338, '21', '22');
    let j1Calls = 0;
    let j2Calls = 0;

    installJurisdiction(env, j1, {
      enforceDebts: async () => {
        j1Calls += 1;
      },
      submitTx: async (jTx) => {
        if (jTx.type === 'debtEnforcement') j1Calls += 1;
        return { success: true };
      },
    });
    installJurisdiction(env, j2, {
      enforceDebts: async () => {
        j2Calls += 1;
      },
      submitTx: async (jTx) => {
        if (jTx.type === 'debtEnforcement') j2Calls += 1;
        return { success: true };
      },
    });
    env.activeJurisdiction = 'J1';

    const entityId = entity('02');
    const signerId = await importEntity(env, entityId, '32', j2);

    enqueueRuntimeInput(env, buildDebtEnforcementRuntimeInput(env, {
      entityId,
      signerId,
      tokenId: 1,
      maxIterations: 10n,
    }));
    await processRuntime(env);

    expect(j1Calls).toBe(0);
    expect(j2Calls).toBe(1);
  });

  test('gossip profile metadata carries jurisdiction mirrors under the profile signature envelope', () => {
    const parsed = parseProfile({
      entityId: entity('03'),
      name: 'Alice Base',
      avatar: '',
      bio: '',
      website: '',
      lastUpdated: 1,
      runtimeId: addr('41'),
      runtimeEncPubKey: `0x${'42'.repeat(32)}`,
      publicAccounts: [],
      wsUrl: null,
      relays: [],
      metadata: {
        isHub: false,
        routingFeePPM: 1,
        baseFee: 0n,
        jurisdiction: {
          name: 'Base',
          chainId: 8453,
          entityProviderAddress: addr('44'),
          depositoryAddress: addr('45'),
        },
        mirrors: [{
          entityId: entity('04'),
          jurisdiction: {
            name: 'Ethereum',
            chainId: 1,
            entityProviderAddress: addr('46'),
            depositoryAddress: addr('47'),
          },
        }],
        board: profileBoard(entity('03'), 'jurisdiction-mirrors'),
      },
      accounts: [],
    });

    const canonical = canonicalizeProfile(parsed);

    expect(canonical.metadata.jurisdiction?.name).toBe('Base');
    expect(canonical.metadata.mirrors?.[0]?.entityId).toBe(entity('04'));
    expect(canonical.metadata.mirrors?.[0]?.jurisdiction.chainId).toBe(1);
  });
});
