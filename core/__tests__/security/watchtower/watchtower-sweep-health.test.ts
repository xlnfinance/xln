import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, ZeroHash, keccak256, toUtf8Bytes } from 'ethers';

import { Depository__factory } from '../../../../jurisdictions/typechain-types/index.ts';
import { deserializeTaggedJson, safeStringify } from '../../../protocol/serialization';
import { encryptTowerPayloadForWatchSeed } from '../../../storage/recovery/bundle/crypto';
import type { TowerAppointmentV1 } from '../../../storage/recovery/bundle/types';
import { startStandaloneWatchtowerServer, type StandaloneWatchtowerServer } from '../../../watchtower/standalone-server';
import { createSweepHealthTracker } from '../../../watchtower/sweep-health';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('watchtower sweep health', () => {
  test('fails health after consecutive sweep errors and recovers only on success', () => {
    const health = createSweepHealthTracker(3);
    health.failure('rpc-1');
    health.failure('rpc-2');
    expect(health.snapshot()).toEqual({
      healthy: true,
      consecutiveFailures: 2,
      lastError: 'rpc-2',
    });
    health.failure('rpc-3');
    expect(health.snapshot().healthy).toBe(false);
    health.success();
    expect(health.snapshot()).toEqual({ healthy: true, consecutiveFailures: 0 });
  });
});

type FakeRpc = { url: string; maxConcurrentCalls: () => number; release: () => void; calls: () => number };

/** A JSON-RPC node whose `eth_call` (Depository._accounts) blocks until released. */
const startBlockingRpc = (): FakeRpc => {
  const depository = Depository__factory.createInterface();
  const idleAccount = depository.encodeFunctionResult('_accounts', [
    0n, ZeroHash, 0n, 0n, 0, 0, ZeroHash, false, 0n, ZeroHash, false, ZeroHash, ZeroHash, ZeroHash, false,
  ]);
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  let released = false;
  const waiters: Array<() => void> = [];
  const result = async (method: string): Promise<unknown> => {
    if (method === 'eth_blockNumber') return '0x10';
    if (method === 'eth_getBlockByNumber') return { timestamp: '0x10' };
    if (method !== 'eth_call') throw new Error(`UNEXPECTED_RPC_METHOD:${method}`);
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (!released) await new Promise<void>(resolve => waiters.push(resolve));
    inFlight -= 1;
    return idleAccount;
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const body = deserializeTaggedJson<{ id: number; method: string }>(await request.text());
      return new Response(safeStringify({ jsonrpc: '2.0', id: body.id, result: await result(body.method) }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  cleanups.push(() => { server.stop(true); });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    maxConcurrentCalls: () => maxInFlight,
    calls: () => calls,
    release: () => {
      released = true;
      for (const resolve of waiters.splice(0)) resolve();
    },
  };
};

const idleLastResortAppointment = async (rpcUrl: string): Promise<TowerAppointmentV1> => {
  const runtimeId = Wallet.createRandom().address.toLowerCase();
  const lookupKey = keccak256(toUtf8Bytes(`tower:operator-lock:${rpcUrl}`));
  return {
    type: 'tower_appointment',
    version: 1,
    towerMode: 'delayed_last_resort',
    lookupKey,
    slot: 0,
    bundle: {
      version: 1,
      runtimeId,
      lookupKey,
      height: 1,
      createdAt: 1_717_171_716_000,
      bundleHash: keccak256(toUtf8Bytes('bundle:operator-lock')),
      iv: '0x1234',
      ciphertext: '0xabcd',
    },
    lastResortPayload: {
      triggerHint: 'chain:31337:acct:operator-lock',
      // The account has no dispute, so the sweep skips before decrypting.
      encryptedRemedy: await encryptTowerPayloadForWatchSeed('{}', `0x${'ee'.repeat(32)}`),
      watch: {
        rpcUrl,
        chainId: 31337,
        depositoryAddress: `0x${'11'.repeat(20)}`,
        watchedEntityId: `0x${'aa'.repeat(32)}`,
        counterentity: `0x${'bb'.repeat(32)}`,
      },
      actionKind: 'counter_dispute_only',
      appointmentSequence: 1,
      proofNonce: 1,
      proofBodyHash: `0x${'dd'.repeat(32)}`,
      responseMode: 'last_resort',
      lastResortWindowSeconds: 8,
    },
    ownerProof: { runtimeId, signedAt: Date.now(), signature: '0xdead' },
  };
};

const startTower = (rpcUrl: string, scheduled: boolean): StandaloneWatchtowerServer => {
  const dbPath = mkdtempSync(join(tmpdir(), 'xln-watchtower-sweep-lock-'));
  const server = startStandaloneWatchtowerServer({
    host: '127.0.0.1',
    port: 0,
    towerId: 'tower-sweep-lock',
    dbPath: join(dbPath, 'tower.level'),
    towerPrivateKey: Wallet.createRandom().privateKey,
    enableLastResortAgent: scheduled,
    enableOperatorApi: true,
    sweepIntervalMs: 1_000,
    allowedRpcUrls: [rpcUrl],
  });
  cleanups.push(async () => {
    await server.close();
    rmSync(dbPath, { recursive: true, force: true });
  });
  return server;
};

const postOperatorSweep = (tower: StandaloneWatchtowerServer): Promise<Response> =>
  fetch(`http://127.0.0.1:${tower.server.port}/api/watchtower/sweep`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: safeStringify({}),
  });

test('the operator sweep waits for the running scheduled sweep', async () => {
  const rpc = startBlockingRpc();
  // Both sweeps accept this RPC regardless of how the allowlist reaches them.
  const previousAllowlist = process.env['XLN_WATCHTOWER_ALLOWED_RPC_URLS'];
  process.env['XLN_WATCHTOWER_ALLOWED_RPC_URLS'] = rpc.url;
  cleanups.push(() => {
    if (previousAllowlist === undefined) delete process.env['XLN_WATCHTOWER_ALLOWED_RPC_URLS'];
    else process.env['XLN_WATCHTOWER_ALLOWED_RPC_URLS'] = previousAllowlist;
  });
  const tower = startTower(rpc.url, true);
  await tower.store.upsertAppointment(await idleLastResortAppointment(rpc.url));

  // The scheduled sweep is now blocked inside the RPC call.
  while (rpc.calls() === 0) await Bun.sleep(25);
  const operatorSweep = postOperatorSweep(tower);
  await Bun.sleep(300);
  // Two concurrent sweeps could send the same counter-dispute twice from one
  // wallet nonce lane; the operator call must queue behind the running one.
  expect(rpc.maxConcurrentCalls()).toBe(1);
  rpc.release();
  expect((await operatorSweep).status).toBe(200);
  expect(rpc.maxConcurrentCalls()).toBe(1);
});

test('the operator sweep uses the configured RPC allowlist', async () => {
  const rpc = startBlockingRpc();
  rpc.release();
  const tower = startTower(rpc.url, false);
  await tower.store.upsertAppointment(await idleLastResortAppointment(rpc.url));

  const response = await postOperatorSweep(tower);
  expect(response.status).toBe(200);
  // Only the private key was forwarded before, so this RPC was refused.
  expect(await response.json()).toEqual({ ok: true, scanned: 1, submitted: 0, skipped: 1, errors: 0 });
});
