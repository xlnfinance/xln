import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, getBytes, hexlify } from 'ethers';

import { serializeTaggedJson, deserializeTaggedJson, safeStringify } from '../../../protocol/serialization';
import {
  buildPersistedRuntimeRecording,
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  openDetachedRuntimeRecording,
  processRuntime,
  restoreEnvFromCheckpointSnapshot,
  restoreEnvFromRecoveryBundles,
  readPersistedFrameJournal,
} from '../../../runtime.ts';
import {
  buildRuntimeRecoveryBundle,
  computeRuntimeRecoveryCheckpointHash,
  validateRuntimeRecoveryBundle,
} from '../../../storage/recovery/bundle';
import { buildRuntimeRecording, validateRuntimeRecording } from '../../../storage/recovery/bundle/recording';
import {
  buildTowerAppointmentOwnerMessage,
  decryptRuntimeRecoveryBundle,
  deriveRuntimeRecoveryActionLookupKey,
  deriveRuntimeRecoveryLookupKey,
  encryptRuntimeRecoveryBundle,
} from '../../../storage/recovery/bundle/crypto';
import type { TowerAppointmentV1 } from '../../../storage/recovery/bundle/types';
import { computeCanonicalStateHashFromEnv } from '../../../storage/canonical-hash';
import { buildRuntimeCheckpointSnapshot } from '../../../storage/wal';
import { createWatchtowerStore } from '../../../watchtower/store';
import { handleRecoveryDiscover, handleTowerAppointment, handleTowerRestore } from '../../../watchtower/http';
import type { JurisdictionConfig } from '../../../entity/types';
import type { Profile } from '../../../entity/profile';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../../../entity/consensus/state-root';
import { buildSingleSignerHanko } from '../../../hanko/batch';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../../../protocol/crypto/p2p-crypto';
import { computeProfileHash, signProfileRuntimeRoute } from '../../../entity/profile/profile-signing';
import { createTestJReplica } from '../.././helpers/j-replica';
import { buildEntityHashesToSign } from '../../../entity/consensus/input/hanko-witness';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import { requireEntityEncryptionPrivateKey } from '../../../entity/auth/crypto';
import { scheduleHook } from '../../../entity/scheduler/hook-state';
import { PersistentEntityCollectionMap } from '../../../entity/state/persistent-collection-map';
import {
  hydrateEntityStateFromStorage,
  projectEntityCoreDoc,
} from '../../../storage/read/projections';
import { validateStorageEntityCoreDocValue } from '../../../storage/schema/schema-state-docs';

const addr = (byte: string): string => `0x${byte.repeat(20)}`;
const x25519 = (byte: string): string => `0x${byte.repeat(32)}`;
let runtimeCounter = 0;
const trackedRuntimeEnvs = new Set<ReturnType<typeof createEmptyEnv>>();

const trackRuntimeEnv = <T extends ReturnType<typeof createEmptyEnv>>(env: T): T => {
  trackedRuntimeEnvs.add(env);
  return env;
};

afterEach(async () => {
  const errors: Error[] = [];
  for (const env of Array.from(trackedRuntimeEnvs).reverse()) {
    trackedRuntimeEnvs.delete(env);
    const results = await Promise.allSettled([closeRuntimeDb(env), closeInfraDb(env)]);
    for (const result of results) {
      if (result.status === 'rejected') {
        errors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
      }
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'RECOVERY_TOWER_TEST_ENV_CLEANUP_FAILED');
});

const installJurisdiction = (env: ReturnType<typeof createEmptyEnv>): JurisdictionConfig => {
  const jurisdiction: JurisdictionConfig = {
    name: 'RecoveryTestnet',
    address: 'browservm://recovery-testnet',
    chainId: 31337,
    depositoryAddress: addr('11'),
    entityProviderAddress: addr('12'),
  };
  env.activeJurisdiction = jurisdiction.name;
  env.state.jReplicas.set(jurisdiction.name, createTestJReplica({
    name: jurisdiction.name,
    rpcs: [],
    chainId: jurisdiction.chainId,
    contracts: { depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress },
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: addr('13'),
      deltaTransformer: addr('14'),
    },
  }));
  return jurisdiction;
};

const buildRuntimeEnv = async () => {
  const runtimeSeed = 'recovery tower runtime seed';
  runtimeCounter += 1;
  const env = trackRuntimeEnv(createEmptyEnv(runtimeSeed));
  const runtimeId = env.runtimeId!;
  const wallet = new Wallet(hexlify(deriveSignerKeySync(runtimeSeed, '1')));
  if (wallet.address.toLowerCase() !== runtimeId) {
    throw new Error('RECOVERY_TEST_TRUSTED_RUNTIME_SIGNER_MISMATCH');
  }
  env.dbNamespace = `${runtimeId}-${Date.now()}-${runtimeCounter}`;
  env.quietRuntimeLogs = true;

  const jurisdiction = installJurisdiction(env);
  const entityId = generateLazyEntityId([runtimeId], 1n, env).toLowerCase();

  enqueueRuntimeInput(env, {
    runtimeTxs: [createTestEntityImportRuntimeTx(env, {
      entityId,
      signerId: runtimeId,
      data: {
        config: {
          mode: 'proposer-based',
          threshold: 1n,
          validators: [runtimeId],
          shares: { [runtimeId]: 1n },
          jurisdiction,
        },
        isProposer: true,
        profileName: 'Recovery Test',
      },
    })],
    entityInputs: [],
  });

  await processRuntime(env);

  return { env, runtimeSeed, runtimeId, entityId, wallet, jurisdiction };
};

const buildRecoveryHubProfile = async (
  jurisdiction: JurisdictionConfig,
): Promise<Profile> => {
  const wallet = new Wallet(`0x${'66'.repeat(32)}`);
  const runtimeId = wallet.address.toLowerCase();
  const entityId = generateLazyEntityId([runtimeId], 1n).toLowerCase();
  const encryptionPublicKey = pubKeyToHex(
    deriveEncryptionKeyPair(`${wallet.privateKey}:${entityId}:htlc-v1`).publicKey,
  );
  const profile: Profile = {
    entityId,
    entityEncryptionPublicKey: encryptionPublicKey,
    name: 'Recovery Hub',
    avatar: '',
    bio: '',
    website: '',
    lastUpdated: 2,
    runtimeId,
    runtimeEncPubKey: x25519('66'),
    publicAccounts: [],
    wsUrl: null,
    relays: [],
    metadata: {
      isHub: true,
      routingFeePPM: 1,
      baseFee: 0n,
      jurisdiction: {
        name: jurisdiction.name,
        chainId: jurisdiction.chainId,
        entityProviderAddress: jurisdiction.entityProviderAddress,
        depositoryAddress: jurisdiction.depositoryAddress,
      },
    },
    accounts: [],
  };
  const profileHash = computeProfileHash(profile);
  profile.metadata.profileHanko = buildSingleSignerHanko(entityId, profileHash, wallet.privateKey);
  const signingEnv = createEmptyEnv('recovery-profile-route-fixture');
  registerSignerKey(signingEnv, runtimeId, getBytes(wallet.privateKey));
  return signProfileRuntimeRoute(signingEnv, profile, runtimeId);
};

describe('runtime recovery tower', () => {
  const journalTailBundle = (frame: Record<string, unknown>) => ({
    version: 1 as const,
    kind: 'journal_tail' as const,
    runtimeId: `0x${'11'.repeat(20)}`,
    runtimeHeight: 2,
    runtimeTimestamp: 2,
    createdAt: 2,
    signers: [{ index: 1, address: `0x${'22'.repeat(20)}`, name: 'Signer' }],
    baseRuntimeHeight: 1,
    baseCheckpointHash: `0x${'33'.repeat(32)}`,
    frames: [{ height: 2, ...frame }],
    signature: `0x${'44'.repeat(65)}`,
  });

  test('V1 recovery tail rejects retired runtimeStateHash even with a canonical root', () => {
    expect(() => validateRuntimeRecoveryBundle(journalTailBundle({
      canonicalStateHash: `0x${'55'.repeat(32)}`,
      runtimeStateHash: `0x${'55'.repeat(32)}`,
    }))).toThrow('RECOVERY_BUNDLE_JOURNAL_RUNTIME_STATE_HASH_RETIRED');
  });

  test('V1 recovery tail requires canonicalStateHash and rejects its absence', () => {
    expect(() => validateRuntimeRecoveryBundle(journalTailBundle({})))
      .toThrow('RECOVERY_BUNDLE_JOURNAL_CANONICAL_STATE_HASH_REQUIRED:height=2');
  });

  test('action lookup keys stay deterministic and separate from blind backup lookup keys', async () => {
    const runtimeId = Wallet.createRandom().address.toLowerCase();
    const seed = 'tower-action-lookup-seed';
    const entityId = `0x${'11'.repeat(32)}`;
    const counterentity = `0x${'22'.repeat(32)}`;
    const blindLookup = deriveRuntimeRecoveryLookupKey(runtimeId, seed);
    const actionLookupA = deriveRuntimeRecoveryActionLookupKey(runtimeId, seed, entityId, counterentity);
    const actionLookupB = deriveRuntimeRecoveryActionLookupKey(runtimeId, seed, entityId, counterentity);
    const actionLookupOther = deriveRuntimeRecoveryActionLookupKey(runtimeId, seed, entityId, `0x${'33'.repeat(32)}`);
    expect(actionLookupA).toBe(actionLookupB);
    expect(actionLookupA).not.toBe(blindLookup);
    expect(actionLookupOther).not.toBe(actionLookupA);
  });

  test('recovery bundle round-trips checkpoint restore', async () => {
    const { env, runtimeSeed, runtimeId, entityId, jurisdiction } = await buildRuntimeEnv();
    const queuedInput = {
      runtimeTxs: [],
      entityInputs: [],
      jInputs: [{ jurisdictionName: jurisdiction.name, jTxs: [] }],
      timestamp: 5_600,
      queuedAt: 5_500,
    };
    env.runtimeMempool = queuedInput;
    env.runtimeConfig = { minFrameDelayMs: 25 };
    env.infrastructure = {
      ...(env.infrastructure ?? {}),
      maxEntityInputsPerFrame: 123,
    };
    env.pendingOutputs = [{ entityId, signerId: runtimeId, runtimeId, entityTxs: [] }];
    env.networkInbox = [{ entityId, signerId: runtimeId, runtimeId, entityTxs: [] }];
    const bundle = buildRuntimeRecoveryBundle(env, {
      signers: [{
        index: 0,
        derivationIndex: 0,
        address: runtimeId,
        name: 'Signer 1',
        entityId,
        jurisdiction: jurisdiction.name,
      }],
      meta: {
        label: 'Recovered runtime',
        activeSignerIndex: 0,
        loginType: 'manual',
        requiresOnboarding: false,
        createdAt: 1234,
      },
      createdAt: 5678,
    });

    const encrypted = await encryptRuntimeRecoveryBundle(bundle, runtimeSeed);
    const decrypted = await decryptRuntimeRecoveryBundle(encrypted, runtimeSeed);
    const restoredEnv = trackRuntimeEnv(await restoreEnvFromCheckpointSnapshot(decrypted.checkpoint!, {
      runtimeSeed,
      runtimeId,
    }));

    const originalPersistedHash = computeCanonicalStateHashFromEnv(env);
    const restoredPersistedHash = computeCanonicalStateHashFromEnv(restoredEnv);

    expect(decrypted.checkpointHash).toBe(bundle.checkpointHash);
    expect(restoredPersistedHash).toBe(originalPersistedHash);
    expect(restoredEnv.runtimeId).toBe(runtimeId);
    expect(restoredEnv.state.height).toBe(env.state.height);
    expect(restoredEnv.state.eReplicas.size).toBe(env.state.eReplicas.size);
    expect(restoredEnv.state.jReplicas.size).toBe(env.state.jReplicas.size);
    // Ephemeral: a restored process starts with an empty input queue even
    // though the live source env still holds unframed work.
    expect(env.runtimeMempool?.jInputs?.length).toBeGreaterThan(0);
    expect(restoredEnv.runtimeMempool).toEqual({ runtimeTxs: [], entityInputs: [] });
    expect(restoredEnv.runtimeConfig).toEqual(env.runtimeConfig);
    expect(restoredEnv.infrastructure?.maxEntityInputsPerFrame).toBe(123);
    expect(requireEntityEncryptionPrivateKey(restoredEnv, entityId))
      .toBe(requireEntityEncryptionPrivateKey(env, entityId));
    expect(env.pendingOutputs).toHaveLength(1);
    expect(env.networkInbox).toHaveLength(1);
    expect(restoredEnv.pendingOutputs).toEqual([]);
    expect(restoredEnv.networkInbox).toEqual([]);
  });

  test('portable Entity projection preserves persistent crontab hooks', async () => {
    const { env, runtimeId, entityId } = await buildRuntimeEnv();
    const source = env.state.eReplicas.get(`${entityId}:${runtimeId}`)?.state;
    if (!source?.crontabState) throw new Error('RECOVERY_TEST_CRONTAB_STATE_MISSING');
    const hook = {
      id: 'watchdog:recovery-roundtrip',
      triggerAt: 5_900,
      type: 'watchdog' as const,
      data: {},
    };
    scheduleHook(source.crontabState, hook);

    const wire = serializeTaggedJson(projectEntityCoreDoc(source));
    const core = validateStorageEntityCoreDocValue(deserializeTaggedJson(wire));
    const restored = hydrateEntityStateFromStorage({ core, accounts: new Map(), books: new Map() });

    expect(restored.crontabState?.hooks).toBeInstanceOf(PersistentEntityCollectionMap);
    expect(restored.crontabState?.hooks.get(hook.id)).toEqual(hook);
  });

  test('recovery checkpoint carries gossip profiles needed for restored openAccount routing', async () => {
    const { env, runtimeSeed, runtimeId, entityId, jurisdiction } = await buildRuntimeEnv();
    const hubProfile = await buildRecoveryHubProfile(jurisdiction);
    const hubEntityId = hubProfile.entityId;
    const hubRuntimeId = hubProfile.runtimeId;
    env.gossip!.announce(hubProfile);

    const bundle = buildRuntimeRecoveryBundle(env, {
      signers: [{
        index: 0,
        derivationIndex: 0,
        address: runtimeId,
        name: 'Signer 1',
        entityId,
        jurisdiction: jurisdiction.name,
      }],
      createdAt: 5678,
    });
    const checkpointGossip = bundle.checkpoint?.['gossip'] as { profiles?: Array<{ entityId?: string }> } | undefined;
    expect(checkpointGossip?.profiles?.some((profile) => profile.entityId === hubEntityId)).toBe(true);

    const restoredEnv = trackRuntimeEnv(await restoreEnvFromRecoveryBundles([bundle], {
      runtimeSeed,
      runtimeId,
    }));
    const restoredHub = restoredEnv.gossip?.getProfiles?.()
      .find((profile) => profile.entityId === hubEntityId);

    expect(restoredHub?.runtimeId).toBe(hubRuntimeId);
    expect(restoredHub?.metadata.isHub).toBe(true);
    expect(restoredHub?.metadata.jurisdiction?.chainId).toBe(jurisdiction.chainId);
    expect(restoredHub?.metadata.jurisdiction?.depositoryAddress).toBe(jurisdiction.depositoryAddress);
  });

  test('recovery bundle omits in-flight consensus work and reconstructs committed state', async () => {
    const { env, runtimeSeed, runtimeId, entityId, wallet, jurisdiction } = await buildRuntimeEnv();
    const replicaKey = `${entityId}:${runtimeId}`;
    const replica = env.state.eReplicas.get(replicaKey);
    expect(replica, 'test replica must exist').toBeTruthy();
    const committedHeight = replica!.state.height;
    // Entity graphs are persistent values; a same-root shell is the only valid
    // test mutation workspace. structuredClone would erase private Patricia nodes.
    const bloatedState = { ...replica!.state };
    bloatedState.messages = Array.from({ length: 100 }, (_, index) => `transient-${index}-${'x'.repeat(512)}`);
    const pendingHeight = Number(replica!.state.height || 0) + 1;
    const pendingHash = `0x${'a1'.repeat(32)}`;
    bloatedState.height = pendingHeight;
    const entityContext = {
      version: 1 as const,
      proposerReplicaId: replicaKey,
      entityId,
      proposerSignerId: replica!.signerId,
      parentFrameHash: replica!.state.height === 0 ? 'genesis' : replica!.state.prevFrameHash!,
      height: pendingHeight,
      gossipProfiles: [],
      peerAssertions: [],
      htlc: { version: 1 as const, entries: [], originated: [] },
    };
    const pendingFrame = {
      height: pendingHeight,
      parentFrameHash: replica!.state.height === 0 ? 'genesis' : replica!.state.prevFrameHash!,
      stateRoot: computeCanonicalEntityConsensusStateHash(bloatedState),
      authorityRoot: computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(bloatedState)),
      timestamp: replica!.state.timestamp,
      txs: [],
      events: [],
      entityContext,
      hash: pendingHash,
      leader: {
        proposerSignerId: replica!.signerId,
        view: replica!.state.leaderState?.view ?? 0,
      },
      hashesToSign: buildEntityHashesToSign(entityId, pendingHeight, computeCanonicalEntityConsensusStateHash(bloatedState)),
    };
    replica!.proposal = pendingFrame;
    replica!.lockedFrame = structuredClone(pendingFrame);
    replica!.candidate = {
      frameHash: pendingHash,
      height: pendingHeight,
      state: bloatedState,
      outputs: [],
      jOutputs: [],
      hashesToSign: [],
      candidateEffects: [],
      storageChanges: [],
    };
    env.browserVMState = {
      stateRoot: `0x${'c3'.repeat(32)}`,
      trieData: Array.from({ length: 2_000 }, (_, index) => [
        `0x${index.toString(16).padStart(64, '0')}`,
        `0x${'ab'.repeat(64)}`,
      ]),
    };

    const bundle = buildRuntimeRecoveryBundle(env, {
      signers: [{
        index: 0,
        derivationIndex: 0,
        address: runtimeId,
        name: 'Signer 1',
        entityId,
        jurisdiction: jurisdiction.name,
      }],
      createdAt: 5678,
    });
    const checkpoint = buildRuntimeCheckpointSnapshot(env);
    expect(checkpoint['runtimeSeed']).toBeUndefined();
    expect(bundle.checkpoint?.['runtimeSeed']).toBeUndefined();
    expect(serializeTaggedJson(bundle)).not.toContain(runtimeSeed);

    const checkpointReplica = (bundle.checkpoint!['eReplicas'] as Array<[string, Record<string, unknown>]>)[0]?.[1];
    expect(replica!.proposal).toBeDefined();
    expect(replica!.lockedFrame).toBeDefined();
    expect(replica!.candidate).toBeDefined();
    expect(checkpointReplica?.proposal).toBeUndefined();
    expect(checkpointReplica?.lockedFrame).toBeUndefined();
    expect(checkpointReplica?.candidate).toBeUndefined();
    expect(checkpointReplica?.mempool).toBeUndefined();
    const portableCore = (checkpointReplica?.state as { core?: { height?: number } } | undefined)?.core;
    expect(portableCore?.height).toBe(committedHeight);
    expect(portableCore?.height).not.toBe(pendingHeight);
    expect(serializeTaggedJson(bundle).length, 'test fixture must exceed the tower JSON body cap before compression').toBeGreaterThan(128 * 1024);

    const encrypted = await encryptRuntimeRecoveryBundle(bundle, runtimeSeed);
    expect(encrypted.compression).toBe('gzip');
    const signedAt = Date.now();
    const signature = await wallet.signMessage(
      buildTowerAppointmentOwnerMessage(
        runtimeId,
        'blind_backup',
        encrypted.lookupKey,
        0,
        encrypted,
        signedAt,
        undefined,
      ),
    );
    const appointment: TowerAppointmentV1 = {
      type: 'tower_appointment',
      version: 1,
      towerMode: 'blind_backup',
      lookupKey: encrypted.lookupKey,
      slot: 0,
      bundle: encrypted,
      ownerProof: {
        runtimeId,
        signedAt,
        signature,
      },
    };
    expect(safeStringify(appointment).length, 'compressed appointment must fit the default tower HTTP body cap').toBeLessThan(128 * 1024);

    const decrypted = await decryptRuntimeRecoveryBundle(encrypted, runtimeSeed);
    expect(decrypted.checkpointHash).toBe(bundle.checkpointHash);
    expect(decrypted.checkpoint!['runtimeId']).toBe(runtimeId);
  });

  test('snapshot plus journal tail restores the latest runtime height', async () => {
    const { env, runtimeSeed, runtimeId, entityId, jurisdiction } = await buildRuntimeEnv();
    // A recovery tail is accepted only when every journal frame carries its
    // independently verifiable canonical root. Ordinary sparse WAL remains
    // valid for local replay, but it is not a portable recovery authority.
    env.runtimeConfig = {
      ...(env.runtimeConfig || {}),
      storage: {
        ...(env.runtimeConfig?.storage || {}),
        canonicalHashPeriodFrames: 1,
      },
    };
    const signers = [{
      index: 0,
      derivationIndex: 0,
      address: runtimeId,
      name: 'Signer 1',
      entityId,
      jurisdiction: jurisdiction.name,
    }];
    const snapshotBundle = buildRuntimeRecoveryBundle(env, {
      signers,
      createdAt: 10_000,
    });
    const baseHeight = snapshotBundle.runtimeHeight;
    const baseHash = snapshotBundle.checkpointHash!;
    const secondSignerId = deriveSignerAddressSync(runtimeSeed, '2').toLowerCase();
    const secondEntityId = generateLazyEntityId([secondSignerId], 1n, env).toLowerCase();

    enqueueRuntimeInput(env, {
      runtimeTxs: [createTestEntityImportRuntimeTx(env, {
        entityId: secondEntityId,
        signerId: secondSignerId,
        data: {
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [secondSignerId],
            shares: { [secondSignerId]: 1n },
            jurisdiction,
          },
          isProposer: true,
          profileName: 'Recovery Tail',
        },
      })],
      entityInputs: [],
    });
    await processRuntime(env);

    const frame = await readPersistedFrameJournal(env, env.state.height);
    expect(frame, 'journal frame must be persisted before building tail bundle').toBeTruthy();
    expect(frame?.runtimeMachine, 'portable recovery frame must carry its verifiable R-machine').toBeDefined();
    expect(frame?.canonicalStateHash).toMatch(/^0x[0-9a-f]{64}$/);
    const tailBundle = buildRuntimeRecoveryBundle(env, {
      signers,
      kind: 'journal_tail',
      baseCheckpoint: { height: baseHeight, hash: baseHash },
      frames: [frame!],
      createdAt: 10_001,
    });

    const restoredEnv = trackRuntimeEnv(await restoreEnvFromRecoveryBundles([snapshotBundle, tailBundle], {
      runtimeSeed,
      runtimeId,
    }));

    const originalPersistedHash = computeCanonicalStateHashFromEnv(env);
    const restoredPersistedHash = computeCanonicalStateHashFromEnv(restoredEnv);

    expect(tailBundle.baseRuntimeHeight).toBe(baseHeight);
    expect(tailBundle.baseCheckpointHash).toBe(baseHash);
    expect(tailBundle.runtimeHeight).toBe(env.state.height);
    expect(restoredPersistedHash).toBe(originalPersistedHash);
    expect(restoredEnv.state.height).toBe(env.state.height);
    expect(restoredEnv.state.eReplicas.size).toBe(env.state.eReplicas.size);
    for (const restored of restoredEnv.state.eReplicas.values()) {
      expect(restored.mempool).toEqual([]);
      expect(restored.proposal).toBeUndefined();
      expect(restored.lockedFrame).toBeUndefined();
      expect(restored.candidate).toBeUndefined();
    }

    const recording = buildRuntimeRecording([snapshotBundle, tailBundle], 10_002);
    expect(validateRuntimeRecording(recording).manifestHash).toBe(recording.manifestHash);
    const detached = openDetachedRuntimeRecording(recording, runtimeSeed);
    const baseProjection = await detached.readAtHeight(baseHeight);
    expect(baseProjection.state.height).toBe(baseHeight);
    const targetProjection = await detached.readAtHeight(env.state.height);
    expect(targetProjection.state.height).toBe(env.state.height);
    expect(computeCanonicalStateHashFromEnv(targetProjection))
      .toBe(originalPersistedHash);
    await detached.close();
    await expect(detached.readAtHeight(baseHeight)).rejects.toThrow('RUNTIME_RECORDING_ADAPTER_CLOSED');

    const persistedRecording = await buildPersistedRuntimeRecording(env, {
      signers,
      createdAt: 10_003,
    });
    expect(validateRuntimeRecording(persistedRecording).targetHeight).toBe(env.state.height);
    const tamperedRecording = structuredClone(persistedRecording);
    tamperedRecording.targetHeight += 1;
    expect(() => validateRuntimeRecording(tamperedRecording))
      .toThrow('RUNTIME_RECORDING_MANIFEST_MISMATCH');
  });

  test('tower stores blind backup appointments and serves restore payloads', async () => {
    const { env, runtimeSeed, runtimeId, entityId, wallet, jurisdiction } = await buildRuntimeEnv();
    const bundle = buildRuntimeRecoveryBundle(env, {
      signers: [{
        index: 0,
        derivationIndex: 0,
        address: runtimeId,
        name: 'Signer 1',
        entityId,
        jurisdiction: jurisdiction.name,
      }],
      meta: {
        label: 'Tower runtime',
        activeSignerIndex: 0,
        loginType: 'manual',
        requiresOnboarding: false,
        createdAt: 1234,
      },
    });
    const encrypted = await encryptRuntimeRecoveryBundle(bundle, runtimeSeed);
    const signedAt = Date.now();
    const signature = await wallet.signMessage(
      buildTowerAppointmentOwnerMessage(
        runtimeId,
        'blind_backup',
        encrypted.lookupKey,
        0,
        encrypted,
        signedAt,
        undefined,
      ),
    );

    const appointment: TowerAppointmentV1 = {
      type: 'tower_appointment',
      version: 1,
      towerMode: 'blind_backup',
      lookupKey: encrypted.lookupKey,
      slot: 0,
      bundle: encrypted,
      ownerProof: {
        runtimeId,
        signedAt,
        signature,
      },
    };

    const tempRoot = join(process.cwd(), '.tmp-tests', `tower-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });
    const store = createWatchtowerStore({
      towerId: 'tower-test',
      dbPath: join(tempRoot, 'tower.level'),
      now: () => 1000,
    });

    const malformedAppointmentResponse = await handleTowerAppointment(
      new Request('http://xln.test/api/tower/appointment', {
        method: 'PUT',
        body: safeStringify({ ...appointment, untrustedExtra: true }),
      }),
      store,
    );
    expect(malformedAppointmentResponse.status).toBe(400);

    const appointmentResponse = await handleTowerAppointment(
      new Request('http://xln.test/api/tower/appointment', {
        method: 'PUT',
        body: safeStringify(appointment),
      }),
      store,
    );
    const appointmentPayload = deserializeTaggedJson<{ ok: boolean; receipt?: { lookupKey: string; height: number } }>(
      await appointmentResponse.text(),
    );
    expect(appointmentPayload.ok).toBe(true);
    expect(appointmentPayload.receipt?.lookupKey).toBe(encrypted.lookupKey);
    expect(appointmentPayload.receipt?.height).toBe(encrypted.height);

    const discoverResponse = await handleRecoveryDiscover(
      new Request('http://xln.test/api/recovery/discover', {
        method: 'POST',
        body: safeStringify({ lookupKey: encrypted.lookupKey }),
      }),
      store,
    );
    const discoverPayload = deserializeTaggedJson<{ ok: boolean; available: boolean }>(
      await discoverResponse.text(),
    );
    expect(discoverPayload.ok).toBe(true);
    expect(discoverPayload.available).toBe(true);

    const restoreResponse = await handleTowerRestore(
      new Request('http://xln.test/api/tower/restore', {
        method: 'POST',
        body: safeStringify({ lookupKey: encrypted.lookupKey }),
      }),
      store,
    );
    const restorePayload = deserializeTaggedJson<{ ok: boolean; bundle?: typeof encrypted }>(
      await restoreResponse.text(),
    );
    expect(restorePayload.ok).toBe(true);
    expect(restorePayload.bundle?.lookupKey).toBe(encrypted.lookupKey);

    const restoredBundle = await decryptRuntimeRecoveryBundle(restorePayload.bundle!, runtimeSeed);
    expect(restoredBundle.checkpointHash).toBe(bundle.checkpointHash);
    expect(serializeTaggedJson(restoredBundle.signers)).toBe(serializeTaggedJson(bundle.signers));
    await store.close();
  });
});
