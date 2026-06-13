import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet } from 'ethers';

import { serializeTaggedJson, deserializeTaggedJson } from '../serialization-utils';
import {
  createEmptyEnv,
  enqueueRuntimeInput,
  process as processRuntime,
  restoreEnvFromCheckpointSnapshot,
} from '../runtime.ts';
import {
  buildRuntimeRecoveryBundle,
  computeRuntimeRecoveryCheckpointHash,
} from '../recovery/bundle';
import {
  buildTowerAppointmentOwnerMessage,
  decryptRuntimeRecoveryBundle,
  deriveRuntimeRecoveryActionLookupKey,
  deriveRuntimeRecoveryLookupKey,
  encryptRuntimeRecoveryBundle,
} from '../recovery/crypto';
import type { TowerAppointmentV1 } from '../recovery/types';
import { buildRuntimeCheckpointSnapshot } from '../wal';
import { computePersistedEnvStateHash } from '../wal/hash';
import { createWatchtowerStore } from '../watchtower/store';
import { handleRecoveryDiscover, handleTowerAppointment, handleTowerRestore } from '../watchtower/http';
import type { JReplica, JurisdictionConfig } from '../types';

const addr = (byte: string): string => `0x${byte.repeat(20)}`;
let runtimeCounter = 0;

const installJurisdiction = (env: ReturnType<typeof createEmptyEnv>): JurisdictionConfig => {
  const jurisdiction: JurisdictionConfig = {
    name: 'RecoveryTestnet',
    address: 'rpc://recovery-testnet',
    chainId: 31337,
    depositoryAddress: addr('11'),
    entityProviderAddress: addr('12'),
  };
  env.activeJurisdiction = jurisdiction.name;
  env.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    rpcs: [jurisdiction.address],
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: addr('13'),
      deltaTransformer: addr('14'),
    },
  } as JReplica);
  return jurisdiction;
};

const buildRuntimeEnv = async () => {
  const runtimeSeed = 'recovery tower runtime seed';
  runtimeCounter += 1;
  const wallet = Wallet.createRandom();
  const runtimeId = wallet.address.toLowerCase();
  const env = createEmptyEnv(runtimeSeed);
  env.runtimeId = runtimeId;
  env.dbNamespace = `${runtimeId}-${Date.now()}-${runtimeCounter}`;
  env.quietRuntimeLogs = true;

  const jurisdiction = installJurisdiction(env);
  const entityId = `0x${'cd'.repeat(32)}`;

  enqueueRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importReplica',
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
    }],
    entityInputs: [],
  });

  await processRuntime(env);

  return { env, runtimeSeed, runtimeId, entityId, wallet, jurisdiction };
};

describe('runtime recovery tower', () => {
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
    const restoredEnv = await restoreEnvFromCheckpointSnapshot(decrypted.checkpoint, {
      runtimeSeed,
      runtimeId,
    });

    const originalPersistedHash = computePersistedEnvStateHash(buildRuntimeCheckpointSnapshot(env));
    const restoredPersistedHash = computePersistedEnvStateHash(buildRuntimeCheckpointSnapshot(restoredEnv));

    expect(decrypted.checkpointHash).toBe(bundle.checkpointHash);
    expect(restoredPersistedHash).toBe(originalPersistedHash);
    expect(restoredEnv.runtimeId).toBe(runtimeId);
    expect(restoredEnv.height).toBe(env.height);
    expect(restoredEnv.eReplicas.size).toBe(env.eReplicas.size);
    expect(restoredEnv.jReplicas.size).toBe(env.jReplicas.size);
  });

  test('recovery bundle omits transient consensus caches and compresses large checkpoints below tower body cap', async () => {
    const { env, runtimeSeed, runtimeId, entityId, wallet, jurisdiction } = await buildRuntimeEnv();
    const replicaKey = `${entityId}:${runtimeId}`;
    const replica = env.eReplicas.get(replicaKey);
    expect(replica, 'test replica must exist').toBeTruthy();
    const bloatedState = structuredClone(replica!.state);
    bloatedState.messages = Array.from({ length: 400 }, (_, index) => `transient-${index}-${'x'.repeat(512)}`);
    replica!.proposal = {
      height: Number(replica!.state.height || 0) + 1,
      txs: [],
      hash: `0x${'a1'.repeat(32)}`,
      newState: bloatedState,
    };
    replica!.lockedFrame = {
      height: Number(replica!.state.height || 0) + 1,
      txs: [],
      hash: `0x${'b2'.repeat(32)}`,
      newState: bloatedState,
    };
    replica!.validatorComputedState = bloatedState;
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
    const checkpointReplica = (bundle.checkpoint['eReplicas'] as Array<[string, Record<string, unknown>]>)[0]?.[1];
    expect(checkpointReplica?.proposal).toBeUndefined();
    expect(checkpointReplica?.lockedFrame).toBeUndefined();
    expect(checkpointReplica?.validatorComputedState).toBeUndefined();
    expect(serializeTaggedJson(bundle).length, 'test fixture must exceed the tower JSON body cap before compression').toBeGreaterThan(128 * 1024);

    const encrypted = await encryptRuntimeRecoveryBundle(bundle, runtimeSeed);
    expect(encrypted.compression).toBe('gzip');
    const signedAt = 42_001;
    const signature = await wallet.signMessage(
      buildTowerAppointmentOwnerMessage(
        runtimeId,
        'blind_backup',
        encrypted.lookupKey,
        0,
        encrypted.bundleHash,
        encrypted.height,
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
    expect(JSON.stringify(appointment).length, 'compressed appointment must fit the default tower HTTP body cap').toBeLessThan(128 * 1024);

    const decrypted = await decryptRuntimeRecoveryBundle(encrypted, runtimeSeed);
    expect(decrypted.checkpointHash).toBe(bundle.checkpointHash);
    expect(decrypted.checkpoint['runtimeId']).toBe(runtimeId);
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
    const signedAt = 42_000;
    const signature = await wallet.signMessage(
      buildTowerAppointmentOwnerMessage(
        runtimeId,
        'blind_backup',
        encrypted.lookupKey,
        0,
        encrypted.bundleHash,
        encrypted.height,
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

    const appointmentResponse = await handleTowerAppointment(
      new Request('http://xln.test/api/tower/appointment', {
        method: 'PUT',
        body: JSON.stringify(appointment),
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
        body: JSON.stringify({ lookupKey: encrypted.lookupKey }),
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
        body: JSON.stringify({ lookupKey: encrypted.lookupKey }),
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
