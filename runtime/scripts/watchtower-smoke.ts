#!/usr/bin/env bun

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet } from 'ethers';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  process as processRuntime,
} from '../runtime';
import { buildRuntimeRecoveryBundle } from '../recovery/bundle';
import {
  buildTowerAppointmentOwnerMessage,
  encryptRuntimeRecoveryBundle,
} from '../recovery/crypto';
import type { JReplica, JurisdictionConfig, TowerAppointmentV1 } from '../xln-api';
import { startStandaloneWatchtowerServer } from '../watchtower/standalone-server';

const addr = (byte: string): string => `0x${byte.repeat(20)}`;

const installJurisdiction = (env: ReturnType<typeof createEmptyEnv>, name = 'TowerSmoke'): JurisdictionConfig => {
  const jurisdiction: JurisdictionConfig = {
    name,
    address: 'rpc://tower-smoke',
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

const createBackupAppointment = async () => {
  const runtimeSeed = 'watchtower-smoke-seed';
  const wallet = Wallet.createRandom();
  const runtimeId = wallet.address.toLowerCase();
  const env = createEmptyEnv(runtimeSeed);
  env.runtimeId = runtimeId;
  env.dbNamespace = `${runtimeId}-${Date.now()}-watchtower-smoke`;
  env.quietRuntimeLogs = true;
  const jurisdiction = installJurisdiction(env);
  const entityId = `0x${'ab'.repeat(32)}`;
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
        profileName: 'Watchtower Smoke',
      },
    }],
    entityInputs: [],
  });
  await processRuntime(env);
  const bundle = buildRuntimeRecoveryBundle(env, {
    signers: [{
      index: 0,
      derivationIndex: 0,
      address: runtimeId,
      name: 'Signer 1',
      entityId,
      jurisdiction: jurisdiction.name,
    }],
  });
  const encrypted = await encryptRuntimeRecoveryBundle(bundle, runtimeSeed);
  await closeRuntimeDb(env);
  await closeInfraDb(env);
  const signedAt = Date.now();
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
  return { encrypted, appointment };
};

const requireOk = async (response: Response, context: string): Promise<unknown> => {
  if (!response.ok) {
    throw new Error(`${context} HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json();
};

const main = async (): Promise<void> => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'xln-watchtower-smoke-'));
  const towerPrivateKey = Wallet.createRandom().privateKey;
  const dbPath = join(tempRoot, 'tower.level');
  const { encrypted, appointment } = await createBackupAppointment();

  let server = startStandaloneWatchtowerServer({
    host: '127.0.0.1',
    port: 0,
    towerId: 'watchtower-smoke',
    dbPath,
    towerPrivateKey,
    maxStoredBytesPerLookupKey: 64 * 1024,
  });

  try {
    const base = `http://127.0.0.1:${server.server.port}`;
    const initialHealth = await requireOk(await fetch(`${base}/healthz`), 'initial health') as {
      signerAddress?: string;
      stats?: { lookupCount?: number };
    };
    if (initialHealth.signerAddress !== server.store.signerAddress) {
      throw new Error('WATCHTOWER_SMOKE_SIGNER_MISMATCH');
    }
    await requireOk(await fetch(`${base}/api/tower/appointment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(appointment),
    }), 'appointment upload');

    const uploadedHealth = await requireOk(await fetch(`${base}/healthz`), 'post-upload health') as {
      stats?: { lookupCount?: number };
    };
    if (uploadedHealth.stats?.lookupCount !== 1) {
      throw new Error(`WATCHTOWER_SMOKE_LOOKUP_COUNT_INVALID:${uploadedHealth.stats?.lookupCount ?? 'missing'}`);
    }

    await server.close();
    server = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'watchtower-smoke',
      dbPath,
      towerPrivateKey,
      maxStoredBytesPerLookupKey: 64 * 1024,
    });
    const restartBase = `http://127.0.0.1:${server.server.port}`;
    const restartedHealth = await requireOk(await fetch(`${restartBase}/healthz`), 'restarted health') as {
      signerAddress?: string;
      stats?: { lookupCount?: number };
    };
    if (restartedHealth.signerAddress !== server.store.signerAddress) {
      throw new Error('WATCHTOWER_SMOKE_RESTART_SIGNER_MISMATCH');
    }
    if (restartedHealth.stats?.lookupCount !== 1) {
      throw new Error(`WATCHTOWER_SMOKE_RESTART_LOOKUP_COUNT_INVALID:${restartedHealth.stats?.lookupCount ?? 'missing'}`);
    }

    const restore = await requireOk(await fetch(`${restartBase}/api/tower/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lookupKey: encrypted.lookupKey }),
    }), 'restore') as { bundle?: { lookupKey?: string } };
    if (restore.bundle?.lookupKey !== encrypted.lookupKey) {
      throw new Error('WATCHTOWER_SMOKE_RESTORE_LOOKUP_MISMATCH');
    }

    console.log('✅ watchtower-smoke passed');
    console.log(JSON.stringify({
      signerAddress: server.store.signerAddress,
      dbPath,
      lookupKey: encrypted.lookupKey,
      stats: restartedHealth.stats ?? null,
    }, null, 2));
  } finally {
    await server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error('❌ watchtower-smoke failed:', error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
