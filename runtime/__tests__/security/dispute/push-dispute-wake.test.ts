import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet, ZeroAddress, zeroPadValue } from 'ethers';
import { Level } from 'level';
import {
  buildPushRegistrationMessage,
  buildPushUnregisterMessage,
  hashPushToken,
  verifyPushRegistration,
} from '../../../watchtower/push/registration';
import { createPushStore } from '../../../watchtower/push/store';
import { handlePushRegister, handlePushUnregister } from '../../../watchtower/http';
import {
  buildDisputeWakeNotification,
  disputeWakeCollapseKey,
  selectWakeTargets,
} from '../../../watchtower/push/dispute-wake';
import { runDisputeWatchSweep, type DisputeWatchStore } from '../../../watchtower/dispute-watch';
import { ConsolePushSender, WebhookPushSender } from '../../../watchtower/push/sender';
import type { PushNotificationV1, PushSender, StoredPushRegistration } from '../../../watchtower/push/types';

const DEPOSITORY = '0x000000000000000000000000000000000000dead';
const CHAIN_ID = 31337;

const entityId = (n: number): string => zeroPadValue(`0x${n.toString(16).padStart(2, '0')}`, 32).toLowerCase();

test('console push transport never claims delivery', async () => {
  const result = await new ConsolePushSender().send({
    version: 1,
    platform: 'web',
    token: 'not-delivered',
    title: 'Dispute started',
    body: 'Open the wallet',
    collapseKey: 'dispute:test',
    data: { kind: 'dispute_wake', url: 'xln://wallet' },
  });
  expect(result).toEqual({ ok: false, error: 'PUSH_DELIVERY_NOT_CONFIGURED' });
});

test('webhook push transport aborts a hung delivery', async () => {
  const sender = new WebhookPushSender(
    'https://push.invalid/send',
    undefined,
    (() => new Promise<Response>(() => {})) as typeof fetch,
    5,
  );
  const result = await sender.send({
    platform: 'web',
    token: 'never-delivered',
    title: 'Dispute started',
    body: 'Open the wallet',
    collapseKey: 'dispute:test',
    data: { kind: 'dispute_wake', url: 'xln://wallet' },
  });
  expect(result).toEqual({ ok: false, error: 'PUSH_WEBHOOK_TIMEOUT:5' });
});

test('webhook push transport rejects public plaintext and bearer-over-http endpoints', () => {
  expect(() => new WebhookPushSender('http://push.example.test/send'))
    .toThrow('PUSH_WEBHOOK_ENDPOINT_INVALID');
  expect(() => new WebhookPushSender('http://127.0.0.1:8080/send', 'secret'))
    .toThrow('PUSH_WEBHOOK_AUTH_REQUIRES_HTTPS');
  expect(() => new WebhookPushSender('http://127.0.0.1:8080/send')).not.toThrow();
});

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

  test('does not collapse two starters that dispute the same victim and nonce', () => {
    const base = {
      chainId: CHAIN_ID,
      depositoryAddress: DEPOSITORY,
      counterentity: entityId(3),
      nonce: 7,
      blockNumber: 100,
    };
    expect(disputeWakeCollapseKey({ ...base, sender: entityId(1) }))
      .not.toBe(disputeWakeCollapseKey({ ...base, sender: entityId(2) }));
  });
});

describe('push registration signature', () => {
  test('round trips and rejects tampering', async () => {
    const wallet = Wallet.createRandom();
    const runtimeId = wallet.address.toLowerCase();
    const token = 'device-token-abc';
    const tokenHash = hashPushToken(token);
    const signedAt = Date.now();
    const message = buildPushRegistrationMessage(
      runtimeId,
      entityId(7),
      tokenHash,
      'android',
      CHAIN_ID,
      DEPOSITORY,
      'http://127.0.0.1:8545/',
      signedAt,
    );
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
    expect(() => verifyPushRegistration({ ...request, rpcUrl: 'https://attacker.invalid/' })).toThrow(/SIGNATURE_INVALID/);
    expect(() => verifyPushRegistration({ ...request, untrusted: true })).toThrow(/FIELDS_INVALID/);
    expect(() => verifyPushRegistration(request, { now: signedAt + 48 * 60 * 60 * 1000 })).toThrow(/STALE/);
  });

  test('accepts exact equal-time retry but rejects altered equal-time registration', async () => {
    const dbPath = join(await mkdtemp(join(tmpdir(), 'xln-push-retry-')), 'push.level');
    const store = createPushStore({ dbPath, now: () => 2_000 });
    const registration = makeRegistration();
    try {
      await store.registerToken(registration);
      await expect(store.registerToken({ ...registration })).resolves.toMatchObject({ rpcUrl: registration.rpcUrl });
      await expect(store.registerToken({ ...registration, rpcUrl: 'https://attacker.invalid/' }))
        .rejects.toThrow('PUSH_REGISTRATION_REPLAY_MISMATCH');
    } finally {
      await store.close();
    }
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

  test('rejects a corrupt persisted registration with its exact storage key', async () => {
    const dbPath = join(await mkdtemp(join(tmpdir(), 'xln-push-corrupt-')), 'push.level');
    const storageKey = `reg:${CHAIN_ID}:${DEPOSITORY}:${entityId(1)}:${hashPushToken('corrupt')}`;
    const rawDb = new Level<string, string>(dbPath, { valueEncoding: 'utf8' });
    await rawDb.open();
    await rawDb.put(storageKey, JSON.stringify({ runtimeId: ZeroAddress }));
    await rawDb.close();

    const store = createPushStore({ dbPath });
    try {
      await expect(store.listRegistrationsForTarget(CHAIN_ID, DEPOSITORY))
        .rejects.toThrow(`PUSH_STORED_REGISTRATION_INVALID:key=${storageKey}`);
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
    const registerMessage = buildPushRegistrationMessage(
      runtimeId,
      entityId(9),
      tokenHash,
      'web',
      CHAIN_ID,
      DEPOSITORY,
      'http://127.0.0.1:8545/',
      signedAt,
    );
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
      'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bool proposerIsLeft, bytes32 proofbodyHash, bytes32 watchSeed, bytes starterInitialArguments, bytes starterCounterArguments, bytes32 starterCounterProofCommitment, uint256 disputeTimeout, uint256 disputeStartTimestamp, uint32 leftResponseSeconds, uint32 rightResponseSeconds)',
    ]);
    const topicHash = iface.getEvent('DisputeStarted')!.topicHash;
    const encoded = iface.encodeEventLog('DisputeStarted', [
      entityId(1), // sender / starter
      entityId(2), // counterentity / victim
      5,
      true,
      id('proof'),
      id('seed'),
      '0x',
      '0x',
      `0x${'00'.repeat(32)}`,
      5_910,
      5_000,
      600,
      310,
    ]);
    const log = { topics: [...encoded.topics] as string[], data: encoded.data, blockNumber: 150 };

    const sent: PushNotificationV1[] = [];
    const sender: PushSender = {
      kind: 'capture',
      send: async (n) => { sent.push(n); return { ok: true }; },
    };

    const { store } = buildFakeStore();
    const providerFactory = makeProvider([log]);

    const first = await runDisputeWatchSweep(store, sender, { providerFactory: () => providerFactory(), maxBlockRange: 1000, confirmations: 0 });
    expect(first.notificationsSent).toBe(1);
    expect(sent[0]!.token).toBe('victim');
    expect(sent[0]!.collapseKey).toBe(disputeWakeCollapseKey({
      chainId: CHAIN_ID, depositoryAddress: DEPOSITORY, sender: entityId(1), counterentity: entityId(2), nonce: 5, blockNumber: 150,
    }));

    const second = await runDisputeWatchSweep(store, sender, { providerFactory: () => providerFactory(), maxBlockRange: 1000, confirmations: 0 });
    expect(second.notificationsSent + second.notificationsSkipped).toBeGreaterThanOrEqual(0);
    expect(sent.length).toBe(1); // deduped — no second wake

    expect(topicHash).not.toBe(TOPIC0);
  });

  test('does not advance the scan cursor past a failed wake', async () => {
    const { Interface, id } = await import('ethers');
    const iface = new Interface([
      'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bool proposerIsLeft, bytes32 proofbodyHash, bytes32 watchSeed, bytes starterInitialArguments, bytes starterCounterArguments, bytes32 starterCounterProofCommitment, uint256 disputeTimeout, uint256 disputeStartTimestamp, uint32 leftResponseSeconds, uint32 rightResponseSeconds)',
    ]);
    const encoded = iface.encodeEventLog('DisputeStarted', [
      entityId(1), entityId(2), 6, false, id('proof-retry'), id('seed-retry'), '0x', '0x',
      `0x${'00'.repeat(32)}`, 5_910, 5_000, 600, 310,
    ]);
    const log = { topics: [...encoded.topics] as string[], data: encoded.data, blockNumber: 151 };
    let fail = true;
    const sender: PushSender = {
      kind: 'retry-once',
      send: async () => fail ? { ok: false, error: 'offline' } : { ok: true },
    };
    const { store, cursors } = buildFakeStore();
    const providerFactory = makeProvider([log]);

    const first = await runDisputeWatchSweep(store, sender, { providerFactory: () => providerFactory(), maxBlockRange: 1000, confirmations: 0 });
    expect(first.errors).toBe(1);
    expect(cursors.size).toBe(0);

    fail = false;
    const second = await runDisputeWatchSweep(store, sender, { providerFactory: () => providerFactory(), maxBlockRange: 1000, confirmations: 0 });
    expect(second.notificationsSent).toBe(1);
    expect(cursors.get(`${CHAIN_ID}:${DEPOSITORY}`)).toBe(200);
  });

  test('fails loud instead of skipping an expired backfill range', async () => {
    const { store, cursors } = buildFakeStore();
    cursors.set(`${CHAIN_ID}:${DEPOSITORY}`, 1);
    let reads = 0;
    const result = await runDisputeWatchSweep(store, {
      kind: 'unused',
      send: async () => ({ ok: true }),
    }, {
      maxBlockRange: 100,
      maxBackfillBlocks: 100,
      providerFactory: () => ({
        getBlockNumber: async () => 200,
        getLogs: async () => { reads += 1; return []; },
      }),
    });
    expect(result.errors).toBe(1);
    expect(reads).toBe(0);
    expect(cursors.get(`${CHAIN_ID}:${DEPOSITORY}`)).toBe(1);
  });

  test('fails loud on a malformed matching event and does not advance its cursor', async () => {
    const { Interface } = await import('ethers');
    const iface = new Interface([
      'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bool proposerIsLeft, bytes32 proofbodyHash, bytes32 watchSeed, bytes starterInitialArguments, bytes starterCounterArguments, bytes32 starterCounterProofCommitment, uint256 disputeTimeout, uint256 disputeStartTimestamp, uint32 leftResponseSeconds, uint32 rightResponseSeconds)',
    ]);
    const { store, cursors } = buildFakeStore();
    const result = await runDisputeWatchSweep(store, {
      kind: 'unused',
      send: async () => ({ ok: true }),
    }, {
      confirmations: 0,
      providerFactory: () => ({
        getBlockNumber: async () => 200,
        getLogs: async () => [{
          topics: [iface.getEvent('DisputeStarted')!.topicHash],
          data: '0x1234',
          blockNumber: 150,
        }],
      }),
    });
    expect(result.errors).toBe(1);
    expect(cursors.size).toBe(0);
  });

  test('times out a log RPC read and leaves the cursor unchanged', async () => {
    const { store, cursors } = buildFakeStore();
    const result = await runDisputeWatchSweep(store, {
      kind: 'unused',
      send: async () => ({ ok: true }),
    }, {
      rpcTimeoutMs: 5,
      confirmations: 0,
      providerFactory: () => ({
        getBlockNumber: async () => 200,
        getLogs: () => new Promise<never>(() => {}),
      }),
    });
    expect(result.errors).toBe(1);
    expect(cursors.size).toBe(0);
  });

  test('scans and persists only through the confirmation-safe head', async () => {
    const { store, cursors } = buildFakeStore();
    const ranges: Array<{ fromBlock: number; toBlock: number }> = [];
    const result = await runDisputeWatchSweep(store, {
      kind: 'unused',
      send: async () => ({ ok: true }),
    }, {
      confirmations: 12,
      maxBlockRange: 1000,
      providerFactory: () => ({
        getBlockNumber: async () => 200,
        getLogs: async filter => {
          ranges.push({ fromBlock: filter.fromBlock, toBlock: filter.toBlock });
          return [];
        },
      }),
    });
    expect(result.errors).toBe(0);
    expect(ranges.at(-1)?.toBlock).toBe(188);
    expect(cursors.get(`${CHAIN_ID}:${DEPOSITORY}`)).toBe(188);
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
