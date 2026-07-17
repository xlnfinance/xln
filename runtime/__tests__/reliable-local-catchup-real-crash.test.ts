import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import { deriveSignerAddressSync, getCachedSignerPrivateKey } from '../account/crypto';
import { dbRootPath } from '../machine/platform';
import {
  closeInfraDb,
  closeRuntimeDb,
  getFrameDb,
  loadEnvFromDB,
  process as processRuntime,
} from '../runtime';
import { computeCanonicalStateHashFromEnv } from '../storage/canonical-hash';
import { readStorageFrameRecord } from '../storage';
import {
  createCatchupFixtureState,
  deriveCatchupFixtureSigners,
  registerCatchupFixtureSigners,
} from './fixtures/reliable-local-catchup-fixture';

const fixture = join(import.meta.dir, 'fixtures/reliable-local-catchup-crash-child.ts');
let cleanupRuntimeId: string | null = null;

const cleanupRuntimeStorage = (runtimeId: string): void => {
  const namespacePath = join(dbRootPath, runtimeId);
  rmSync(namespacePath, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
  rmSync(`${namespacePath}-frames`, { recursive: true, force: true });
  rmSync(`${namespacePath}-events`, { recursive: true, force: true });
  rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
};

afterEach(() => {
  if (cleanupRuntimeId) cleanupRuntimeStorage(cleanupRuntimeId);
  cleanupRuntimeId = null;
});

test('restores H+1 and deferred H+2 from LevelDB after real SIGKILL', async () => {
  mkdirSync(dbRootPath, { recursive: true });
  const seed = `reliable local catch-up SIGKILL ${process.pid} deterministic seed`;
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  cleanupRuntimeId = runtimeId;
  cleanupRuntimeStorage(runtimeId);

  const child = Bun.spawn({
    cmd: [process.execPath, fixture, seed],
    cwd: join(import.meta.dir, '..', '..'),
    env: { ...process.env, XLN_DB_PATH: dbRootPath },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(137);
  expect(child.signalCode, `${stdout}\n${stderr}`).toBe('SIGKILL');

  const { leaderSignerId, targetSignerId } = deriveCatchupFixtureSigners(seed);
  const entityId = createCatchupFixtureState(leaderSignerId, targetSignerId).entityId;
  const restored = await loadEnvFromDB(runtimeId, seed);
  if (!restored) throw new Error(`CATCHUP_CRASH_RESTORE_MISSING\n${stdout}\n${stderr}`);
  try {
    const replica = restored.eReplicas.get(`${entityId}:${targetSignerId}`);
    expect(getCachedSignerPrivateKey(restored, targetSignerId)).toBeNull();
    expect(restored.height).toBe(2);
    expect(replica?.state.height).toBe(1);
    expect(restored.pendingNetworkOutputs?.map(output => output.proposedFrame?.height)).toEqual([2]);
    expect(restored.runtimeMempool?.entityInputs.map(input => input.proposedFrame?.height)).toEqual([2]);
    expect(restored.runtimeState?.reliableIngressReceiptLedger?.size ?? 0).toBe(0);
    expect(restored.runtimeState?.reliableIngressTerminalWatermarks?.size).toBe(1);
    expect(restored.runtimeState?.receivedReliableReceiptLedger?.size ?? 0).toBe(0);
    expect(restored.runtimeState?.receivedReliableTerminalWatermarks?.size).toBe(1);

    const h2Hash = restored.pendingNetworkOutputs?.[0]?.proposedFrame?.hash;
    expect(h2Hash).toMatch(/^0x[0-9a-f]{64}$/);
    const frame = await readStorageFrameRecord(getFrameDb(restored), 2);
    expect(frame?.runtimeMachineBeforeApply).toBeTruthy();
    expect(frame?.runtimeMachine).toBeTruthy();
    expect(frame?.runtimeStateHash).toBe(computeCanonicalStateHashFromEnv(restored));

    // LevelDB restores durable consensus/transport state, never external vault
    // secrets. Production rehydrates those keys when the vault unlocks; model
    // that boundary explicitly before this validator resumes local delivery.
    registerCatchupFixtureSigners(restored, seed);
    expect(getCachedSignerPrivateKey(restored, targetSignerId)).not.toBeNull();

    for (let tick = 0; tick < 8; tick += 1) {
      await processRuntime(restored, []);
      const current = restored.eReplicas.get(`${entityId}:${targetSignerId}`);
      if (
        current?.state.height === 2 &&
        current.state.prevFrameHash === h2Hash &&
        (restored.pendingNetworkOutputs?.length ?? 0) === 0 &&
        (restored.runtimeMempool?.entityInputs.length ?? 0) === 0
      ) break;
    }

    const finalReplica = restored.eReplicas.get(`${entityId}:${targetSignerId}`);
    expect(finalReplica?.state.height).toBe(2);
    expect(finalReplica?.state.prevFrameHash).toBe(h2Hash);
    expect(restored.pendingNetworkOutputs ?? []).toEqual([]);
    expect(restored.runtimeMempool?.entityInputs ?? []).toEqual([]);
    expect(restored.runtimeState?.reliableIngressTerminalWatermarks?.size).toBe(1);
    expect(restored.runtimeState?.receivedReliableTerminalWatermarks?.size).toBe(1);
  } finally {
    await closeRuntimeDb(restored);
    await closeInfraDb(restored);
  }
}, 30_000);
