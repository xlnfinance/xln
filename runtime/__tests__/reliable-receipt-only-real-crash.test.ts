import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import { deriveSignerAddressSync } from '../account/crypto';
import { dbRootPath } from '../machine/platform';
import {
  closeInfraDb,
  closeRuntimeDb,
  getFrameDb,
  loadEnvFromDB,
} from '../runtime';
import { readStorageFrameRecord } from '../storage';
import {
  createCatchupFixtureState,
  deriveCatchupFixtureSigners,
} from './fixtures/reliable-local-catchup-fixture';

const fixture = join(import.meta.dir, 'fixtures/reliable-receipt-only-crash-child.ts');
let cleanupRuntimeId: string | null = null;

const cleanupRuntimeStorage = (runtimeId: string): void => {
  const namespacePath = join(dbRootPath, runtimeId);
  for (const suffix of ['', '-storage-current', '-storage-previous', '-frames', '-events', '-infra']) {
    rmSync(`${namespacePath}${suffix}`, { recursive: true, force: true });
  }
};

afterEach(() => {
  if (cleanupRuntimeId) cleanupRuntimeStorage(cleanupRuntimeId);
  cleanupRuntimeId = null;
});

test('restores a terminal receipt-only frontier after real SIGKILL', async () => {
  mkdirSync(dbRootPath, { recursive: true });
  const seed = `reliable receipt-only SIGKILL ${process.pid}`;
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const peerRuntimeId = deriveSignerAddressSync(seed, 'peer').toLowerCase();
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

  const restored = await loadEnvFromDB(runtimeId, seed);
  if (!restored) throw new Error(`RELIABLE_RECEIPT_ONLY_RESTORE_MISSING\n${stdout}\n${stderr}`);
  try {
    const { leaderSignerId, targetSignerId } = deriveCatchupFixtureSigners(seed);
    const entityId = createCatchupFixtureState(leaderSignerId, targetSignerId).entityId;
    expect(restored.height).toBe(3);
    expect(restored.eReplicas.get(`${entityId}:${targetSignerId}`)?.state.height).toBe(1);
    expect(restored.runtimeState?.pendingReliableIngress?.size ?? 0).toBe(0);
    const terminalPrecommit = [...(restored.runtimeState?.reliableIngressTerminalWatermarks?.values() ?? [])]
      .find(receipt => receipt.body.identity.kind === 'hash-precommit');
    expect(terminalPrecommit?.body.identity).toMatchObject({
      kind: 'hash-precommit',
      entityId,
      signerId: targetSignerId,
      height: 1,
    });

    const frame = await readStorageFrameRecord(getFrameDb(restored), 3);
    expect(frame?.runtimeInput.entityInputs).toHaveLength(1);
    expect(frame?.runtimeInput.entityInputs[0]?.from).toBe(peerRuntimeId);
    expect(frame?.runtimeMachine).toBeUndefined();
  } finally {
    await closeRuntimeDb(restored);
    await closeInfraDb(restored);
  }
}, 30_000);
