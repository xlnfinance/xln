import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';

import {
  closeInfraDb,
  closeRuntimeDb,
  loadEnvFromDB,
} from '../runtime';
import { deriveSignerAddressSync } from '../account/crypto';
import { getReliableDeliveryReceiptValidationError } from '../machine/reliable-delivery';
import {
  receiverFrontierKey,
  senderFrontierKey,
} from '../machine/reliable-frontier';
import { dbRootPath } from '../machine/platform';
import type { Env, ReliableDeliveryReceipt } from '../types';

const fixture = join(import.meta.dir, 'fixtures/reliable-frontier-crash-child.ts');
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

const onlyReceipt = (
  ledger: Map<string, ReliableDeliveryReceipt> | undefined,
  label: string,
): ReliableDeliveryReceipt => {
  expect(ledger?.size, `${label} must retain exactly one bounded frontier`).toBe(1);
  const value = ledger?.values().next().value;
  if (!value) throw new Error(`${label} receipt missing after restore`);
  return value;
};

const assertReceiptValid = (env: Env, receipt: ReliableDeliveryReceipt): void => {
  expect(getReliableDeliveryReceiptValidationError(env, receipt)).toBeNull();
};

test('restores all bounded reliable frontiers and the next outbox item after real SIGKILL', async () => {
  mkdirSync(dbRootPath, { recursive: true });
  const seed = `reliable frontier SIGKILL ${process.pid} deterministic seed`;
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const peerRuntimeId = deriveSignerAddressSync(seed, '2').toLowerCase();
  const relayRuntimeId = deriveSignerAddressSync(seed, '3').toLowerCase();
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
  if (!restored) {
    const namespaces = readdirSync(dbRootPath).filter(name => name.includes(runtimeId.slice(2, 10)));
    throw new Error(
      `reliable frontier crash fixture did not restore namespaces=${namespaces.join(',')}\n${stdout}\n${stderr}`,
    );
  }
  try {
    expect(restored.height).toBe(2);
    const state = restored.runtimeState;
    expect(
      state?.reliableIngressTerminalWatermarks?.size,
      'receiver terminal must retain both source-scoped frontiers',
    ).toBe(2);
    const ingressTerminal = state?.reliableIngressTerminalWatermarks?.values().next().value;
    if (!ingressTerminal) throw new Error('receiver terminal receipt missing after restore');
    const ingressActive = onlyReceipt(
      state?.reliableIngressReceiptLedger,
      'receiver active',
    );
    const senderTerminal = onlyReceipt(
      state?.receivedReliableTerminalWatermarks,
      'sender terminal',
    );
    const senderActive = onlyReceipt(
      state?.receivedReliableReceiptLedger,
      'sender active',
    );

    for (const receipt of [ingressTerminal, ingressActive, senderTerminal, senderActive]) {
      assertReceiptValid(restored, receipt);
    }
    expect(ingressTerminal.body.coverage).toBe('terminal');
    expect(ingressTerminal.body.identity.height).toBe(10);
    expect(ingressActive.body.coverage).toBe('exact');
    expect(ingressActive.body.identity.height).toBe(11);
    expect(senderTerminal.body.coverage).toBe('terminal');
    expect(senderTerminal.body.identity.height).toBe(20);
    expect(senderActive.body.coverage).toBe('exact');
    expect(senderActive.body.identity.height).toBe(21);

    expect(state?.reliableIngressTerminalWatermarks?.get(
      receiverFrontierKey(peerRuntimeId, ingressTerminal.body.identity),
    )).toEqual(ingressTerminal);
    expect(state?.reliableIngressTerminalWatermarks?.get(
      receiverFrontierKey(relayRuntimeId, ingressTerminal.body.identity),
    )).toEqual(ingressTerminal);
    expect(state?.reliableIngressReceiptLedger?.get(
      receiverFrontierKey(peerRuntimeId, ingressActive.body.identity),
    )).toEqual(ingressActive);
    expect(state?.receivedReliableTerminalWatermarks?.get(
      senderFrontierKey(senderTerminal),
    )).toEqual(senderTerminal);
    expect(state?.receivedReliableReceiptLedger?.get(
      senderFrontierKey(senderActive),
    )).toEqual(senderActive);

    expect(restored.pendingNetworkOutputs).toHaveLength(1);
    expect(restored.pendingNetworkOutputs?.[0]?.proposedFrame?.height).toBe(22);
  } finally {
    await closeRuntimeDb(restored);
    await closeInfraDb(restored);
  }
}, 30_000);
