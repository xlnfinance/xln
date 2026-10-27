import { buildTowerAppointmentOwnerMessage } from '../../../storage/recovery/bundle/crypto';
import { safeStringify } from '../../../protocol/serialization';
import { handleTowerRestore } from '../../../watchtower/http';
import { extractEncryptedRecoveryBundles } from '../../../storage/recovery/discovery/candidates';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toUtf8Bytes, Wallet } from 'ethers';
import type { TowerAppointmentV1 } from '../../../storage/recovery/bundle/types';
import { createWatchtowerStore } from '../../../watchtower/store';
import { WatchtowerAppointmentNotRetainedError } from '../../../watchtower/store/appointments';

const owner = new Wallet(`0x${'11'.repeat(32)}`);
const lookupKey = keccak256(toUtf8Bytes('retention-regression'));
const appointment = async (height: number, slot: number, signedAt: number): Promise<TowerAppointmentV1> => {
  const runtimeId = owner.address.toLowerCase();
  const bundle: TowerAppointmentV1['bundle'] = {
    version: 1,
    runtimeId,
    lookupKey,
    height,
    createdAt: signedAt,
    bundleHash: keccak256(toUtf8Bytes(`bundle:${height}`)),
    iv: '0x1234',
    ciphertext: '0xabcd',
  };
  const signature = await owner.signMessage(
    buildTowerAppointmentOwnerMessage(runtimeId, 'blind_backup', lookupKey, slot, bundle, signedAt, undefined),
  );
  return {
    type: 'tower_appointment',
    version: 1,
    towerMode: 'blind_backup',
    lookupKey,
    slot,
    bundle,
    ownerProof: { runtimeId, signedAt, signature },
  };
};

test('tower refuses an excluded low-height appointment without replacing the signed receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-tower-retention-'));
  const store = createWatchtowerStore({ dbPath: join(root, 'db'), maxBundlesPerLookupKey: 2 });
  try {
    await store.upsertAppointment(await appointment(20, 0, 100));
    const latest = await store.upsertAppointment(await appointment(30, 1, 101));
    await expect(store.upsertAppointment(await appointment(10, 2, 102))).rejects.toBeInstanceOf(
      WatchtowerAppointmentNotRetainedError,
    );
    expect(await store.getLatestReceipt(lookupKey)).toEqual(latest);
    expect((await store.getLatest(lookupKey))!.bundles.map(bundle => bundle.height)).toEqual([30]);
    await expect(store.upsertAppointment(await appointment(40, 2, 103))).resolves.toMatchObject({
      height: 40,
      sequence: 3,
    });
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [oldTtl, newTtl] of [
  [120_000, 60_000],
  [60_000, 120_000],
] as const) {
  test(`pruning honors signed expiry after TTL changes from ${oldTtl} to ${newTtl}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-tower-expiry-'));
    const dbPath = join(root, 'db');
    let now = 1_000_000;
    let store = createWatchtowerStore({ dbPath, receiptTtlMs: oldTtl, now: () => now });
    try {
      const receipt = await store.upsertAppointment(await appointment(1, 0, now));
      await store.close();
      store = createWatchtowerStore({ dbPath, receiptTtlMs: newTtl, now: () => now });
      if (oldTtl > newTtl) {
        now += 1_000;
        const shorter = await store.upsertAppointment(await appointment(2, 1, now));
        now = shorter.expiresAt + 1;
        expect(await store.pruneExpired()).toEqual({ deleted: 0 });
      }
      now = receipt.expiresAt;
      expect(await store.pruneExpired()).toEqual({ deleted: 0 });
      expect(await store.getLatest(lookupKey)).not.toBeNull();
      now += 1;
      expect(await store.pruneExpired()).toEqual({ deleted: 1 });
      expect(await store.getLatest(lookupKey)).toBeNull();
    } finally {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('restore HTTP handler returns only the canonical bundles array', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-tower-response-'));
  const store = createWatchtowerStore({ dbPath: join(root, 'db') });
  try {
    const uploaded = await appointment(10, 0, 100);
    await store.upsertAppointment(uploaded);
    const response = await handleTowerRestore(
      new Request('https://tower.example/api/tower/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: safeStringify({ lookupKey }),
      }),
      store,
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).not.toHaveProperty('bundle');
    expect(extractEncryptedRecoveryBundles(payload)).toEqual([uploaded.bundle]);
    expect(extractEncryptedRecoveryBundles({ bundle: uploaded.bundle })).toEqual([]);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
