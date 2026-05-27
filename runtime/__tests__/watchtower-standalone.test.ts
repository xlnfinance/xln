import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, keccak256, toUtf8Bytes } from 'ethers';

import { createEmptyEnv, enqueueRuntimeInput, process as processRuntime } from '../runtime.ts';
import { buildRuntimeRecoveryBundle } from '../recovery/bundle';
import { buildTowerAppointmentOwnerMessage, encryptRuntimeRecoveryBundle } from '../recovery/crypto';
import type { JReplica, JurisdictionConfig, TowerAppointmentV1 } from '../xln-api';
import { startStandaloneWatchtowerServer, type StandaloneWatchtowerServer } from '../watchtower/standalone-server';

const addr = (byte: string): string => `0x${byte.repeat(20)}`;
const servers: StandaloneWatchtowerServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
});

const installJurisdiction = (env: ReturnType<typeof createEmptyEnv>): JurisdictionConfig => {
  const jurisdiction: JurisdictionConfig = {
    name: 'TowerHTTP',
    address: 'rpc://tower-http',
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

const createRuntimeAppointment = async () => {
  const runtimeSeed = 'watchtower-http-seed';
  const wallet = Wallet.createRandom();
  const runtimeId = wallet.address.toLowerCase();
  const env = createEmptyEnv(runtimeSeed);
  env.runtimeId = runtimeId;
  env.dbNamespace = `${runtimeId}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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
        profileName: 'Watchtower HTTP',
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
  return { appointment, encrypted };
};

describe('standalone watchtower service', () => {
  test('stores and restores bundles over HTTP', async () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-http-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });

    const server = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-http-test',
      dbPath: join(tempRoot, 'tower.level'),
      maxStoredBytesPerLookupKey: 64 * 1024,
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.server.port}`;
    const { appointment, encrypted } = await createRuntimeAppointment();
    for (const healthPath of ['/', '/api/tower/healthz']) {
      const health = await fetch(`${base}${healthPath}`);
      expect(health.ok).toBe(true);
      const healthPayload = await health.json() as {
        ok: boolean;
        signerAddress?: string;
        actionPublicKey?: string;
        sweep?: { enabled?: boolean };
      };
      expect(healthPayload.ok).toBe(true);
      expect(healthPayload.signerAddress).toBe(server.store.signerAddress);
      expect(healthPayload.actionPublicKey).toBe(server.store.actionPublicKey);
      expect(healthPayload.sweep?.enabled).toBe(false);
    }

    const put = await fetch(`${base}/api/tower/appointment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(appointment),
    });
    expect(put.ok).toBe(true);

    const restore = await fetch(`${base}/api/tower/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lookupKey: encrypted.lookupKey }),
    });
    expect(restore.ok).toBe(true);
    const payload = await restore.json() as { ok: boolean; bundle?: { lookupKey: string }; receipt?: { towerSignature?: string } };
    expect(payload.ok).toBe(true);
    expect(payload.bundle?.lookupKey).toBe(encrypted.lookupKey);
    expect(typeof payload.receipt?.towerSignature).toBe('string');
  });

  test('rejects oversize free-tier bundles with quota error', async () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-quota-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });

    const server = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-quota-test',
      dbPath: join(tempRoot, 'tower.level'),
      maxStoredBytesPerLookupKey: 256,
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.server.port}`;
    const { appointment } = await createRuntimeAppointment();

    const put = await fetch(`${base}/api/tower/appointment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(appointment),
    });
    expect(put.status).toBe(413);
    const payload = await put.json() as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(String(payload.error || '')).toContain('TOWER_QUOTA_EXCEEDED');
  });

  test('rejects plaintext active remedies over HTTP', async () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-active-plaintext-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });

    const server = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-active-plaintext-test',
      dbPath: join(tempRoot, 'tower.level'),
      maxStoredBytesPerLookupKey: 64 * 1024,
    });
    servers.push(server);

    const runtimeWallet = Wallet.createRandom();
    const runtimeId = runtimeWallet.address.toLowerCase();
    const lookupKey = keccak256(toUtf8Bytes('tower:plaintext-active'));
    const activePayload = {
      triggerHint: 'chain:31337:acct:plaintext',
      encryptedRemedy: JSON.stringify({ type: 'counter_dispute_remedy' }),
      actionKind: 'counter_dispute_only' as const,
      appointmentSequence: 1,
      proofNonce: 1,
      proofBodyHash: keccak256(toUtf8Bytes('proof-body')),
      responseMode: 'last_resort' as const,
      lastResortWindowBlocks: 8,
      safetyMarginBlocks: 2,
    };
    const bundle = {
      version: 1 as const,
      runtimeId,
      lookupKey,
      height: 3,
      createdAt: 123_456,
      bundleHash: keccak256(toUtf8Bytes('bundle:plaintext-active')),
      iv: '0x1234',
      ciphertext: '0xabcd',
    };
    const signedAt = 123_456;
    const signature = await runtimeWallet.signMessage(
      buildTowerAppointmentOwnerMessage(
        runtimeId,
        'delayed_last_resort',
        lookupKey,
        0,
        bundle.bundleHash,
        bundle.height,
        signedAt,
        activePayload,
      ),
    );

    const response = await fetch(`http://127.0.0.1:${server.server.port}/api/tower/appointment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'tower_appointment',
        version: 1,
        towerMode: 'delayed_last_resort',
        lookupKey,
        slot: 0,
        bundle,
        activePayload,
        ownerProof: {
          runtimeId,
          signedAt,
          signature,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json() as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(String(payload.error || '')).toContain('TOWER_ACTIVE_PAYLOAD_REMEDY_NOT_ENCRYPTED');
  });

  test('rejects oversized JSON bodies before request handling', async () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-body-cap-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });

    const server = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-body-cap-test',
      dbPath: join(tempRoot, 'tower.level'),
      maxStoredBytesPerLookupKey: 64 * 1024,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.server.port}/api/tower/appointment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(129 * 1024) }),
    });
    expect(response.status).toBe(413);
    const payload = await response.json() as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(String(payload.error || '')).toContain('TOWER_BODY_TOO_LARGE');
  });

  test('keeps the write-only recovery complaint sink disabled by default', async () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-complaint-disabled-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });

    const server = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-complaint-disabled-test',
      dbPath: join(tempRoot, 'tower.level'),
      maxStoredBytesPerLookupKey: 64 * 1024,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.server.port}/api/recovery/complaint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test' }),
    });
    expect(response.status).toBe(404);
    const payload = await response.json() as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('TOWER_COMPLAINTS_DISABLED');
  });

  test('reports scheduler enabled when an action key is configured', async () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-scheduler-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });

    const server = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-scheduler-test',
      dbPath: join(tempRoot, 'tower.level'),
      maxStoredBytesPerLookupKey: 64 * 1024,
      towerPrivateKey: Wallet.createRandom().privateKey,
      sweepIntervalMs: 60_000,
    });
    servers.push(server);

    const health = await fetch(`http://127.0.0.1:${server.server.port}/api/tower/healthz`);
    expect(health.ok).toBe(true);
    const payload = await health.json() as { sweep?: { enabled?: boolean; intervalMs?: number } };
    expect(payload.sweep?.enabled).toBe(true);
    expect(payload.sweep?.intervalMs).toBe(60_000);
  });
});
