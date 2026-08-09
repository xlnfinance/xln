import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, hexlify, keccak256, toUtf8Bytes } from 'ethers';

import { deriveSignerKeySync } from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import { createEmptyEnv, enqueueRuntimeInput, processRuntime } from '../runtime.ts';
import { buildRuntimeRecoveryBundle } from '../storage/recovery/bundle';
import { buildTowerAppointmentOwnerMessage, encryptRuntimeRecoveryBundle } from '../storage/recovery/crypto';
import { serializeTaggedJson } from '../protocol/serialization';
import type { JurisdictionConfig, TowerAppointmentV1 } from '../api/public/runtime-module';
import { decodeStoredLookupDoc } from '../watchtower/store-decode';
import { startStandaloneWatchtowerServer, type StandaloneWatchtowerServer } from '../watchtower/standalone-server';
import { createTestJReplica } from './helpers/j-replica';

const addr = (byte: string): string => `0x${byte.repeat(20)}`;
const servers: StandaloneWatchtowerServer[] = [];

test('watchtower disk decoder rejects partial lookup records instead of defaulting fields', () => {
  const partial = serializeTaggedJson({
    lookupKey: `0x${'11'.repeat(32)}`,
    runtimeId: addr('22'),
    updatedAt: 0,
    receipts: [],
  });
  expect(() => decodeStoredLookupDoc(partial)).toThrow(
    'TOWER_STORED_LOOKUP_FIELDS_INVALID:missing=bundles:extra=none',
  );
});

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
  env.state.jReplicas.set(jurisdiction.name, createTestJReplica({
    name: jurisdiction.name,
    rpcs: [jurisdiction.address],
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

const createRuntimeAppointment = async () => {
  const runtimeSeed = 'watchtower-http-seed';
  const env = createEmptyEnv(runtimeSeed);
  const runtimeId = env.runtimeId!;
  const wallet = new Wallet(hexlify(deriveSignerKeySync(runtimeSeed, '1')));
  env.dbNamespace = `${runtimeId}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  env.quietRuntimeLogs = true;
  const jurisdiction = installJurisdiction(env);
  const entityId = generateLazyEntityId([runtimeId], 1n, env).toLowerCase();
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
  test('uses structured logging without direct console output', () => {
    const source = readFileSync(join(process.cwd(), 'runtime/watchtower/standalone-server.ts'), 'utf8');

    expect(source).toContain("createStructuredLogger('watchtower.standalone')");
    expect(source).toContain('WATCHTOWER_CORS_HEADERS');
    expect(source).toContain('const handleWatchtowerRequest');
    expect(source).toContain("request.method === 'OPTIONS'");
    expect(source).toContain("watchtowerLog.info('service.listen'");
    expect(source).toContain("watchtowerLog.error('sweep.failed'");
    expect(source).toContain("watchtowerLog.error('push_sweep.failed'");
    expect(source).not.toContain('console.');
    expect(source).not.toContain('[WATCHTOWER] sweep');
    expect(source).not.toContain('[PUSH-WATCH] sweep');
  });

  test('answers browser CORS preflight for recovery endpoints', async () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-cors-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });

    const server = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-cors-test',
      dbPath: join(tempRoot, 'tower.level'),
      maxStoredBytesPerLookupKey: 64 * 1024,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.server.port}/api/recovery/discover`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:8081',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('content-type');
  });

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
        sweep?: { enabled?: boolean };
      };
      expect(healthPayload.ok).toBe(true);
      expect(healthPayload.signerAddress).toBe(server.store.signerAddress);
      expect('actionPublicKey' in healthPayload).toBe(false);
      expect(healthPayload.sweep?.enabled).toBe(false);
    }

    const put = await fetch(`${base}/api/tower/appointment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(appointment),
    });
    expect(put.ok).toBe(true);

    const unrelatedWallet = Wallet.createRandom();
    const unrelatedRuntimeId = unrelatedWallet.address.toLowerCase();
    const signedAt = 123_457;
    const signature = await unrelatedWallet.signMessage(
      buildTowerAppointmentOwnerMessage(
        unrelatedRuntimeId,
        'blind_backup',
        encrypted.lookupKey,
        0,
        appointment.bundle.bundleHash,
        appointment.bundle.height,
        signedAt,
        undefined,
      ),
    );
    const conflictingPut = await fetch(`${base}/api/tower/appointment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...appointment,
        bundle: { ...appointment.bundle, runtimeId: unrelatedRuntimeId },
        ownerProof: { runtimeId: unrelatedRuntimeId, signedAt, signature },
      }),
    });
    expect(conflictingPut.status).toBe(400);
    const conflictPayload = await conflictingPut.json() as { ok: boolean; error?: string };
    expect(conflictPayload.ok).toBe(false);
    expect(conflictPayload.error).toContain('TOWER_LOOKUP_RUNTIME_ID_MISMATCH');

    const restore = await fetch(`${base}/api/tower/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lookupKey: encrypted.lookupKey }),
    });
    expect(restore.ok).toBe(true);
    const payload = await restore.json() as {
      ok: boolean;
      bundle?: { lookupKey: string; runtimeId: string };
      receipt?: { runtimeId: string; towerSignature?: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.bundle?.lookupKey).toBe(encrypted.lookupKey);
    expect(payload.bundle?.runtimeId).toBe(appointment.bundle.runtimeId);
    expect(payload.receipt?.runtimeId).toBe(appointment.bundle.runtimeId);
    expect(typeof payload.receipt?.towerSignature).toBe('string');
  });

  test('accepts an appointment body larger than 1 MiB when it fits the configured quota', async () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-large-body-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });

    const server = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-large-body-test',
      dbPath: join(tempRoot, 'tower.level'),
      maxStoredBytesPerLookupKey: 3 * 1024 * 1024,
    });
    servers.push(server);
    const { appointment } = await createRuntimeAppointment();
    appointment.bundle.ciphertext = `0x${'ab'.repeat(640 * 1024)}`;
    const body = JSON.stringify(appointment);
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(1024 * 1024);

    const response = await fetch(`http://127.0.0.1:${server.server.port}/api/tower/appointment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(response.status).toBe(200);
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

  test('rejects plaintext last-resort remedies over HTTP', async () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-active-plaintext-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });

    const server = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-last-resort-plaintext-test',
      dbPath: join(tempRoot, 'tower.level'),
      maxStoredBytesPerLookupKey: 64 * 1024,
    });
    servers.push(server);

    const runtimeWallet = Wallet.createRandom();
    const runtimeId = runtimeWallet.address.toLowerCase();
    const lookupKey = keccak256(toUtf8Bytes('tower:plaintext-active'));
    const lastResortPayload = {
      triggerHint: 'chain:31337:acct:plaintext',
      encryptedRemedy: JSON.stringify({ type: 'counter_dispute_remedy' }),
      actionKind: 'counter_dispute_only' as const,
      watch: {
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 31337,
        depositoryAddress: '0x1111111111111111111111111111111111111111',
        watchedEntityId: `0x${'aa'.repeat(32)}`,
        counterentity: `0x${'bb'.repeat(32)}`,
      },
      appointmentSequence: 1,
      proofNonce: 1,
      proofBodyHash: keccak256(toUtf8Bytes('proof-body')),
      responseMode: 'last_resort' as const,
      lastResortWindowSeconds: 8,
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
        lastResortPayload,
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
        lastResortPayload,
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
    expect(String(payload.error || '')).toContain('TOWER_LAST_RESORT_PAYLOAD_REMEDY_NOT_ENCRYPTED');
  });

  test('rejects unknown tower mode over HTTP', async () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-invalid-mode-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });

    const server = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-invalid-mode-test',
      dbPath: join(tempRoot, 'tower.level'),
      maxStoredBytesPerLookupKey: 64 * 1024,
    });
    servers.push(server);

    const { appointment } = await createRuntimeAppointment();
    const response = await fetch(`http://127.0.0.1:${server.server.port}/api/tower/appointment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...appointment,
        towerMode: 'legacy_mode',
      }),
    });
    expect(response.status).toBe(400);
    const payload = await response.json() as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(String(payload.error || '')).toContain('TOWER_MODE_INVALID:legacy_mode');
  });

  test('rejects unknown tower mode in the store path', async () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-invalid-store-mode-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });

    const server = startStandaloneWatchtowerServer({
      dbPath: join(tempRoot, 'tower.level'),
      host: '127.0.0.1',
      port: 0,
    });
    servers.push(server);

    const { appointment } = await createRuntimeAppointment();
    await expect(server.store.upsertAppointment({
      ...appointment,
      towerMode: 'legacy_mode',
    } as TowerAppointmentV1)).rejects.toThrow('TOWER_MODE_INVALID:legacy_mode');
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
    // Bun rejects at the global transport boundary before allocating/parsing
    // route JSON. The route-level parser separately covers capped error bodies.
    expect(await response.text()).toBe('');
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
      enableLastResortAgent: true,
      sweepIntervalMs: 60_000,
    });
    servers.push(server);

    const health = await fetch(`http://127.0.0.1:${server.server.port}/api/tower/healthz`);
    expect(health.ok).toBe(true);
    const payload = await health.json() as { sweep?: { enabled?: boolean; intervalMs?: number } };
    expect(payload.sweep?.enabled).toBe(true);
    expect(payload.sweep?.intervalMs).toBe(60_000);
  });

  test('keeps operator endpoints disabled by default', async () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-operator-disabled-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });

    const server = startStandaloneWatchtowerServer({
      host: '127.0.0.1',
      port: 0,
      towerId: 'tower-operator-disabled-test',
      dbPath: join(tempRoot, 'tower.level'),
      maxStoredBytesPerLookupKey: 64 * 1024,
      towerPrivateKey: Wallet.createRandom().privateKey,
      enableLastResortAgent: true,
    });
    servers.push(server);

    const base = `http://127.0.0.1:${server.server.port}`;
    const sweep = await fetch(`${base}/api/watchtower/sweep`, { method: 'POST' });
    expect(sweep.status).toBe(404);
    const actions = await fetch(`${base}/api/watchtower/actions/${keccak256(toUtf8Bytes('none'))}`);
    expect(actions.status).toBe(404);
  });

  test('requires operator token when operator API binds publicly', () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-public-operator-${Date.now()}`);
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });

    expect(() => startStandaloneWatchtowerServer({
      host: '0.0.0.0',
      port: 0,
      towerId: 'tower-public-operator-test',
      dbPath: join(tempRoot, 'tower.level'),
      maxStoredBytesPerLookupKey: 64 * 1024,
      towerPrivateKey: Wallet.createRandom().privateKey,
      enableOperatorApi: true,
    })).toThrow('WATCHTOWER_OPERATOR_TOKEN_REQUIRED_FOR_PUBLIC_BIND');
  });

  test('requires an explicit tower signing key when binding publicly', () => {
    const tempRoot = join(process.cwd(), '.tmp-tests', `watchtower-public-key-${Date.now()}`);
    expect(() => startStandaloneWatchtowerServer({
      host: '0.0.0.0',
      port: 0,
      towerId: 'tower-public-key-test',
      dbPath: join(tempRoot, 'tower.level'),
    })).toThrow('WATCHTOWER_PRIVATE_KEY_REQUIRED_FOR_PUBLIC_BIND');
  });
});
