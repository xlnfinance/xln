import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet, ZeroAddress, zeroPadValue } from 'ethers';
import {
  buildPushRegistrationMessage,
  buildPushUnregisterMessage,
  hashPushToken,
  verifyPushRegistration,
} from '../push/registration';
import { createPushStore } from '../push/store';
import { handlePushRegister, handlePushUnregister } from '../watchtower/http';
import {
  buildDisputeWakeNotification,
  disputeWakeCollapseKey,
  selectWakeTargets,
} from '../push/dispute-wake';
import { runDisputeWatchSweep, type DisputeWatchStore } from '../watchtower/dispute-watch';
import type { PushNotificationV1, PushSender, StoredPushRegistration } from '../push/types';

const DEPOSITORY = '0x000000000000000000000000000000000000dead';
const CHAIN_ID = 31337;

const entityId = (n: number): string => zeroPadValue(`0x${n.toString(16).padStart(2, '0')}`, 32).toLowerCase();

const makeRegistration = (over: Partial<StoredPushRegistration> = {}): StoredPushRegistration => ({
  runtimeId: ZeroAddress.toLowerCase(),
  entityId: entityId(1),
  tokenHash: hashPushToken('tok-1'),
  token: 'tok-1',
  platform: 'ios',
  chainId: CHAIN_ID,
  depositoryAddress: DEPOSITORY,
  rpcUrl: 'http://127.0.0.1:8545/',
  signedAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

describe('selectWakeTargets', () => {
  test('wakes the victim (counterentity), never the starter', () => {
    const victim = makeRegistration({ entityId: entityId(2), token: 'victim', tokenHash: hashPushToken('victim') });
    const starter = makeRegistration({ entityId: entityId(1), token: 'starter', tokenHash: hashPushToken('starter') });
    const event = {
      chainId: CHAIN_ID,
      depositoryAddress: DEPOSITORY,
      sender: entityId(1),
      counterentity: entityId(2),
      nonce: 5,
      blockNumber: 100,
    };
    const targets = selectWakeTargets(event, [victim, starter]);
    expect(targets.length).toBe(1);
    expect(targets[0]!.registration.token).toBe('victim');
  });

  test('ignores wrong chain / depository / self-started disputes', () => {
    const reg = makeRegistration({ entityId: entityId(2) });
    const base = { chainId: CHAIN_ID, depositoryAddress: DEPOSITORY, sender: entityId(1), counterentity: entityId(2), nonce: 1, blockNumber: 1 };
    expect(selectWakeTargets({ ...base, chainId: 999 }, [reg]).length).toBe(0);
    expect(selectWakeTargets({ ...base, depositoryAddress: ZeroAddress }, [reg]).length).toBe(0);
    expect(selectWakeTargets({ ...base, sender: entityId(2) }, [reg]).length).toBe(0); // victim == starter
  });
});

describe('push registration signature', () => {
  test('round trips and rejects tampering', async () => {
    const wallet = Wallet.createRandom();
    const runtimeId = wallet.address.toLowerCase();
    const token = 'device-token-abc';
    const tokenHash = hashPushToken(token);
    const signedAt = Date.now();
    const message = buildPushRegistrationMessage(runtimeId, entityId(7), tokenHash, 'android', CHAIN_ID, DEPOSITORY, signedAt);
    const ownerSignature = await wallet.signMessage(message);

    const request = {
      type: 'push_registration' as const,
      version: 1 as const,
      runtimeId,
      entityId: entityId(7),
      token,
      platform: 'android' as const,
      chainId: CHAIN_ID,
      depositoryAddress: DEPOSITORY,
      rpcUrl: 'http://127.0.0.1:8545/',
      signedAt,
      ownerSignature,
    };

    const verified = verifyPushRegistration(request, { now: signedAt });
    expect(verified.runtimeId).toBe(runtimeId);
    expect(verified.tokenHash).toBe(tokenHash);

    expect(() => verifyPushRegistration({ ...request, entityId: entityId(8) })).toThrow(/SIGNATURE_INVALID/);
    expect(() => verifyPushRegistration(request, { now: signedAt + 48 * 60 * 60 * 1000 })).toThrow(/STALE/);
  });

  test('unregister removes only the signed runtime token registration', async () => {
    const dbPath = join(await mkdtemp(join(tmpdir(), 'xln-push-store-')), 'push.level');
    const token = 'shared-device-token';
    const tokenHash = hashPushToken(token);
    const store = createPushStore({ dbPath, now: () => 2_000 });
    const firstRuntime = Wallet.createRandom().address.toLowerCase();
    const secondRuntime = Wallet.createRandom().address.toLowerCase();
    try {
      await store.registerToken(makeRegistration({ runtimeId: firstRuntime, token, tokenHash, entityId: entityId(2) }));
      await store.registerToken(makeRegistration({ runtimeId: secondRuntime, token, tokenHash, entityId: entityId(3) }));

      const removed = await store.removeToken(firstRuntime, tokenHash);
      expect(removed).toBe(1);

      const remaining = await store.listRegistrationsForTarget(CHAIN_ID, DEPOSITORY);
      expect(remaining.map(registration => registration.runtimeId).sort()).toEqual([secondRuntime]);
    } finally {
      await store.close();
    }
  });

  test('http register and unregister handlers require signed runtime ownership', async () => {
    const dbPath = join(await mkdtemp(join(tmpdir(), 'xln-push-http-')), 'push.level');
    const store = createPushStore({ dbPath, now: () => Date.now() });
    const wallet = Wallet.createRandom();
    const runtimeId = wallet.address.toLowerCase();
    const token = 'device-token-http';
    const tokenHash = hashPushToken(token);
    const signedAt = Date.now();
    const registerMessage = buildPushRegistrationMessage(runtimeId, entityId(9), tokenHash, 'web', CHAIN_ID, DEPOSITORY, signedAt);
    const ownerSignature = await wallet.signMessage(registerMessage);
    try {
      const registerResponse = await handlePushRegister(new Request('http://tower.local/api/push/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'push_registration',
          version: 1,
          runtimeId,
          entityId: entityId(9),
          token,
          platform: 'web',
          chainId: CHAIN_ID,
          depositoryAddress: DEPOSITORY,
          rpcUrl: 'http://127.0.0.1:8545/',
          signedAt,
          ownerSignature,
        }),
      }), store);
      expect(registerResponse.status).toBe(200);
      expect((await registerResponse.json() as { ok?: boolean }).ok).toBe(true);
      expect(await store.listRegistrationsForTarget(CHAIN_ID, DEPOSITORY)).toHaveLength(1);

      const unregisterMessage = buildPushUnregisterMessage(runtimeId, tokenHash, signedAt);
      const unregisterResponse = await handlePushUnregister(new Request('http://tower.local/api/push/unregister', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'push_unregister',
          version: 1,
          runtimeId,
          token,
          signedAt,
          ownerSignature: await wallet.signMessage(unregisterMessage),
        }),
      }), store);
      expect(unregisterResponse.status).toBe(200);
      expect(await unregisterResponse.json()).toMatchObject({ ok: true, removed: 1 });
      expect(await store.listRegistrationsForTarget(CHAIN_ID, DEPOSITORY)).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  test('http unregister accepts signed token hash without retaining raw token client-side', async () => {
    const dbPath = join(await mkdtemp(join(tmpdir(), 'xln-push-hash-unregister-')), 'push.level');
    const store = createPushStore({ dbPath, now: () => Date.now() });
    const wallet = Wallet.createRandom();
    const runtimeId = wallet.address.toLowerCase();
    const token = 'device-token-hash-only-revoke';
    const tokenHash = hashPushToken(token);
    const signedAt = Date.now();
    try {
      await store.registerToken(makeRegistration({ runtimeId, token, tokenHash, entityId: entityId(4) }));

      const unregisterMessage = buildPushUnregisterMessage(runtimeId, tokenHash, signedAt);
      const unregisterResponse = await handlePushUnregister(new Request('http://tower.local/api/push/unregister', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'push_unregister',
          version: 1,
          runtimeId,
          tokenHash,
          signedAt,
          ownerSignature: await wallet.signMessage(unregisterMessage),
        }),
      }), store);

      expect(unregisterResponse.status).toBe(200);
      expect(await unregisterResponse.json()).toMatchObject({ ok: true, removed: 1 });
      expect(await store.listRegistrationsForTarget(CHAIN_ID, DEPOSITORY)).toHaveLength(0);
    } finally {
      await store.close();
    }
  });
});

describe('runDisputeWatchSweep', () => {
  test('uses structured logging without direct console output', () => {
    const source = readFileSync(join(process.cwd(), 'runtime/watchtower/dispute-watch.ts'), 'utf8');

    expect(source).toContain("createStructuredLogger('watchtower.dispute_watch')");
    expect(source).toContain("disputeWatchLog.error('target.failed'");
    expect(source).not.toContain('console.');
    expect(source).not.toContain('[PUSH-WATCH] target');
  });

  const buildFakeStore = (): { store: DisputeWatchStore; woken: Set<string>; cursors: Map<string, number> } => {
    const woken = new Set<string>();
    const cursors = new Map<string, number>();
    const reg = makeRegistration({ entityId: entityId(2), token: 'victim', tokenHash: hashPushToken('victim') });
    const store: DisputeWatchStore = {
      listWatchTargets: async () => [{ chainId: CHAIN_ID, depositoryAddress: DEPOSITORY, rpcUrl: 'http://127.0.0.1:8545/' }],
      listRegistrationsForTarget: async () => [reg],
      getCursor: async (c, d) => cursors.get(`${c}:${d}`) ?? null,
      setCursor: async (c, d, b) => { cursors.set(`${c}:${d}`, b); },
      wasRecentlyWoken: async (k) => woken.has(k),
      markWoken: async (k) => { woken.add(k); },
    };
    return { store, woken, cursors };
  };

  // DisputeStarted(sender indexed, counterentity indexed, nonce indexed, ...)
  const TOPIC0 = '0x' + '0'.repeat(64); // placeholder; replaced by real topic via interface in engine
  const makeProvider = (logs: Array<{ topics: string[]; data: string; blockNumber: number }>) => () => ({
    getBlockNumber: async () => 200,
    getLogs: async () => logs,
  });

  test('sends a wake to the victim and dedups on re-run', async () => {
    // Build a real DisputeStarted log via the same interface the engine uses.
    const { Interface, id } = await import('ethers');
    const iface = new Interface([
      'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bytes32 proofbodyHash, bytes32 watchSeed, bytes starterInitialArguments, bytes starterIncrementedArguments, uint256 disputeTimeout)',
    ]);
    const topicHash = iface.getEvent('DisputeStarted')!.topicHash;
    const encoded = iface.encodeEventLog('DisputeStarted', [
      entityId(1), // sender / starter
      entityId(2), // counterentity / victim
      5,
      id('proof'),
      id('seed'),
      '0x',
      '0x',
      5_910,
    ]);
    const log = { topics: [...encoded.topics] as string[], data: encoded.data, blockNumber: 150 };

    const sent: PushNotificationV1[] = [];
    const sender: PushSender = {
      kind: 'capture',
      send: async (n) => { sent.push(n); return { ok: true }; },
    };

    const { store } = buildFakeStore();
    const providerFactory = makeProvider([log]);

    const first = await runDisputeWatchSweep(store, sender, { providerFactory: () => providerFactory(), maxBlockRange: 1000 });
    expect(first.notificationsSent).toBe(1);
    expect(sent[0]!.token).toBe('victim');
    expect(sent[0]!.collapseKey).toBe(disputeWakeCollapseKey({
      chainId: CHAIN_ID, depositoryAddress: DEPOSITORY, sender: entityId(1), counterentity: entityId(2), nonce: 5, blockNumber: 150,
    }));

    const second = await runDisputeWatchSweep(store, sender, { providerFactory: () => providerFactory(), maxBlockRange: 1000 });
    expect(second.notificationsSent + second.notificationsSkipped).toBeGreaterThanOrEqual(0);
    expect(sent.length).toBe(1); // deduped — no second wake

    expect(topicHash).not.toBe(TOPIC0);
  });

  test('does not advance the scan cursor past a failed wake', async () => {
    const { Interface, id } = await import('ethers');
    const iface = new Interface([
      'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bytes32 proofbodyHash, bytes32 watchSeed, bytes starterInitialArguments, bytes starterIncrementedArguments, uint256 disputeTimeout)',
    ]);
    const encoded = iface.encodeEventLog('DisputeStarted', [
      entityId(1), entityId(2), 6, id('proof-retry'), id('seed-retry'), '0x', '0x', 5_910,
    ]);
    const log = { topics: [...encoded.topics] as string[], data: encoded.data, blockNumber: 151 };
    let fail = true;
    const sender: PushSender = {
      kind: 'retry-once',
      send: async () => fail ? { ok: false, error: 'offline' } : { ok: true },
    };
    const { store, cursors } = buildFakeStore();
    const providerFactory = makeProvider([log]);

    const first = await runDisputeWatchSweep(store, sender, { providerFactory: () => providerFactory(), maxBlockRange: 1000 });
    expect(first.errors).toBe(1);
    expect(cursors.size).toBe(0);

    fail = false;
    const second = await runDisputeWatchSweep(store, sender, { providerFactory: () => providerFactory(), maxBlockRange: 1000 });
    expect(second.notificationsSent).toBe(1);
    expect(cursors.get(`${CHAIN_ID}:${DEPOSITORY}`)).toBe(200);
  });
});

describe('buildDisputeWakeNotification', () => {
  test('produces a tappable wake payload', () => {
    const target = {
      registration: makeRegistration({ entityId: entityId(2), token: 'victim', tokenHash: hashPushToken('victim') }),
      event: { chainId: CHAIN_ID, depositoryAddress: DEPOSITORY, sender: entityId(1), counterentity: entityId(2), nonce: 9, blockNumber: 1 },
    };
    const notification = buildDisputeWakeNotification(target);
    expect(notification.token).toBe('victim');
    expect(notification.data.kind).toBe('dispute_wake');
    expect(notification.data.url).toBe('xln://wallet');
    expect(notification.collapseKey).toContain('dispute:');
  });
});
