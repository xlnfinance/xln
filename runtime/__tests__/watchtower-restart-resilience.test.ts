import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, ethers } from 'ethers';

import { createEmptyEnv, enqueueRuntimeInput, process as processRuntime } from '../runtime.ts';
import { buildRuntimeRecoveryBundle } from '../recovery/bundle';
import {
  buildTowerAppointmentOwnerMessage,
  deriveRuntimeRecoveryActionLookupKey,
  encryptRuntimeRecoveryBundle,
} from '../recovery/crypto';
import type { JReplica, JurisdictionConfig, TowerLastResortPayloadV1, TowerAppointmentV1 } from '../xln-api';
import {
  encodeTowerCounterDisputeRemedy,
  runWatchtowerSweep,
} from '../watchtower/action';
import { startStandaloneWatchtowerServer, type StandaloneWatchtowerServer } from '../watchtower/standalone-server';

const addr = (byte: string): string => `0x${byte.repeat(20)}`;
const servers: StandaloneWatchtowerServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
});

const installJurisdiction = (env: ReturnType<typeof createEmptyEnv>, name = 'TowerRestart'): JurisdictionConfig => {
  const jurisdiction: JurisdictionConfig = {
    name,
    address: 'rpc://tower-restart',
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
  const runtimeSeed = 'watchtower-restart-seed';
  const wallet = Wallet.createRandom();
  const runtimeId = wallet.address.toLowerCase();
  const env = createEmptyEnv(runtimeSeed);
  env.runtimeId = runtimeId;
  env.dbNamespace = `${runtimeId}-${Date.now()}-restart`;
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
        profileName: 'Watchtower Restart',
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
  const signedAt = 123_456;
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
  return { appointment, encrypted, runtimeId };
};

describe('watchtower restart resilience', () => {
  test('persists blind backup, last-resort appointments, and action receipts across standalone server restart', async () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-restart-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });

    const towerPrivateKey = Wallet.createRandom().privateKey;
    const dbPath = join(tempRoot, 'tower.level');
    const { appointment: backupAppointment, encrypted, runtimeId } = await createBackupAppointment();

    let server = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-restart-test',
      dbPath,
      towerPrivateKey,
      maxStoredBytesPerLookupKey: 64 * 1024,
    });
    servers.push(server);

    const towerWallet = new Wallet(towerPrivateKey);
    const lastResortLookupKey = deriveRuntimeRecoveryActionLookupKey(
      runtimeId,
      'restart-action-seed',
      `0x${'12'.repeat(32)}`,
      `0x${'34'.repeat(32)}`,
    );
    const lastResortOwner = Wallet.createRandom();
    const lastResortRuntimeId = lastResortOwner.address.toLowerCase();
    const watchSeed = `0x${'12'.repeat(32)}`;
    const watchedEntityId = `0x${'12'.repeat(32)}`;
    const counterentity = `0x${'34'.repeat(32)}`;
    const lastResortPayload: TowerLastResortPayloadV1 = {
      triggerHint: 'restart-test',
      encryptedRemedy: encodeTowerCounterDisputeRemedy({
        version: 1,
        type: 'counter_dispute_remedy',
        rpcUrl: 'http://127.0.0.1:1',
        chainId: 31337,
        depositoryAddress: addr('55'),
        watchedEntityId,
        towerAddress: towerWallet.address.toLowerCase(),
        lastResortWindowBlocks: 8,
        appointmentSequence: 3,
        ownerAuthorizationHanko: '0x1234',
        latestProof: {
          counterentity,
          finalNonce: 7,
          finalProofbody: { watchSeed, tokenIds: [1], offdeltas: [-5n], transformers: [] },
          leftArguments: '0x',
          rightArguments: '0x',
          starterIncrementedArguments: '0x',
          sig: '0x5678',
        },
      }),
      watch: {
        rpcUrl: 'http://127.0.0.1:1',
        chainId: 31337,
        depositoryAddress: addr('55'),
        watchedEntityId,
        counterentity,
      },
      actionKind: 'counter_dispute_only',
      appointmentSequence: 3,
      proofNonce: 7,
      proofBodyHash: `0x${'56'.repeat(32)}`,
      responseMode: 'last_resort',
      lastResortWindowBlocks: 8,
      safetyMarginBlocks: 0,
    };
    const lastResortSignedAt = 999_001;
    const lastResortAppointment: TowerAppointmentV1 = {
      type: 'tower_appointment',
      version: 1,
      towerMode: 'delayed_last_resort',
      lookupKey: lastResortLookupKey,
      slot: 0,
      bundle: {
        ...encrypted,
        runtimeId: lastResortRuntimeId,
        lookupKey: lastResortLookupKey,
        bundleHash: ethers.keccak256(ethers.toUtf8Bytes('restart-active-bundle')),
      },
      lastResortPayload,
      ownerProof: {
        runtimeId: lastResortRuntimeId,
        signedAt: lastResortSignedAt,
        signature: '',
      },
    };
    lastResortAppointment.ownerProof.signature = await lastResortOwner.signMessage(
      buildTowerAppointmentOwnerMessage(
        lastResortRuntimeId,
        'delayed_last_resort',
        lastResortLookupKey,
        0,
        lastResortAppointment.bundle.bundleHash,
        lastResortAppointment.bundle.height,
        lastResortSignedAt,
        lastResortPayload,
      ),
    );

    await server.store.upsertAppointment(backupAppointment);
    await server.store.upsertAppointment(lastResortAppointment);
    await server.store.appendActionReceipt({
      id: `${lastResortLookupKey}:seeded`,
      lookupKey: lastResortLookupKey,
      runtimeId: lastResortRuntimeId,
      towerMode: 'delayed_last_resort',
      actionKind: 'counter_dispute_only',
      triggerHint: 'restart-test',
      appointmentSequence: 3,
      status: 'skipped',
      createdAt: 101,
    });

    const firstHealth = await fetch(`http://127.0.0.1:${server.server.port}/healthz`);
    expect(firstHealth.ok).toBe(true);
    const firstHealthPayload = await firstHealth.json() as {
      ok: boolean;
      signerAddress?: string;
      stats?: { lookupCount?: number; lastResortAppointmentCount?: number; actionReceiptCount?: number };
    };
    expect(firstHealthPayload.signerAddress).toBe(server.store.signerAddress);
    expect(firstHealthPayload.stats).toMatchObject({
      lookupCount: 2,
      lastResortAppointmentCount: 1,
      actionReceiptCount: 1,
    });

    await server.close();
    servers.pop();

    server = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-restart-test',
      dbPath,
      towerPrivateKey,
      maxStoredBytesPerLookupKey: 64 * 1024,
    });
    servers.push(server);

    const secondHealth = await fetch(`http://127.0.0.1:${server.server.port}/healthz`);
    expect(secondHealth.ok).toBe(true);
    const secondHealthPayload = await secondHealth.json() as {
      ok: boolean;
      signerAddress?: string;
      stats?: { lookupCount?: number; lastResortAppointmentCount?: number; actionReceiptCount?: number };
    };
    expect(secondHealthPayload.signerAddress).toBe(server.store.signerAddress);
    expect(secondHealthPayload.stats).toMatchObject({
      lookupCount: 2,
      lastResortAppointmentCount: 1,
      actionReceiptCount: 1,
    });

    const restore = await fetch(`http://127.0.0.1:${server.server.port}/api/tower/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lookupKey: encrypted.lookupKey }),
    });
    expect(restore.ok).toBe(true);
    const restorePayload = await restore.json() as { ok: boolean; bundle?: { lookupKey: string } };
    expect(restorePayload.ok).toBe(true);
    expect(restorePayload.bundle?.lookupKey).toBe(encrypted.lookupKey);

    const publicActions = await fetch(`http://127.0.0.1:${server.server.port}/api/watchtower/actions/${lastResortLookupKey}`);
    expect(publicActions.status).toBe(404);
    const storedActions = await server.store.listActionReceipts(lastResortLookupKey);
    expect(storedActions[0]?.status).toBe('skipped');

    const sweep = await runWatchtowerSweep(server.store, {
      lookupKey: lastResortLookupKey,
      towerPrivateKey,
      providerFactory: () => ({
        getBlockNumber: async () => 1,
        getLogs: async () => [],
      }),
      contractFactory: () => ({
        accountKey: async () => '0xfeed',
        _accounts: async () => ({
          nonce: 0n,
          disputeHash: ethers.ZeroHash,
          disputeTimeout: 0n,
        }),
        watchtowerCounterDispute: async () => ({
          hash: '0xnever',
          wait: async () => ({ blockNumber: 0 }),
        }),
      }),
    });
    expect(sweep).toEqual({
      scanned: 1,
      submitted: 0,
      skipped: 1,
      errors: 0,
    });
  });
});
