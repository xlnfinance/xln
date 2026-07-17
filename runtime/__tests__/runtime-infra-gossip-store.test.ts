import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { loadGossipProfilesFromInfraDb } from '../machine/infra-gossip-store';
import { serializeTaggedJson } from '../protocol/serialization';
import { clearGossip, closeInfraDb, createEmptyEnv, getInfraDb, tryOpenInfraDb } from '../runtime';
import { resolveDbPath } from '../storage/runtime-dbs';
import type { Env } from '../types';
import {
  buildCryptographicProfileFixture,
  deriveSingleSignerFixtureEntityId,
} from './helpers/cryptographic-profile';

const keyText = (key: Buffer | string): string => Buffer.isBuffer(key) ? key.toString() : String(key);

class FakeBatch {
  private readonly writes: Array<() => void> = [];

  constructor(private readonly store: Map<string, Buffer>) {}

  put(key: Buffer, value: Buffer): this {
    this.writes.push(() => this.store.set(keyText(key), value));
    return this;
  }

  del(key: Buffer): this {
    this.writes.push(() => this.store.delete(keyText(key)));
    return this;
  }

  async write(): Promise<void> {
    for (const write of this.writes) write();
  }
}

class FakeInfraDb {
  readonly store = new Map<string, Buffer>();

  async get(key: Buffer): Promise<Buffer> {
    const value = this.store.get(keyText(key));
    if (!value) throw new Error(`not found: ${keyText(key)}`);
    return value;
  }

  batch(): FakeBatch {
    return new FakeBatch(this.store);
  }

  async *keys(options: { gte?: Buffer; lt?: Buffer } = {}): AsyncGenerator<Buffer> {
    const gte = options.gte?.toString() ?? '';
    const lt = options.lt?.toString() ?? '\uffff';
    for (const key of [...this.store.keys()].sort()) {
      if (key >= gte && key < lt) yield Buffer.from(key);
    }
  }
}

test('runtime infra gossip restore diagnostics use structured logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/machine/infra-gossip-store.ts'), 'utf8');

  expect(source).toContain("const infraGossipLog = createStructuredLogger('runtime.infra_gossip');");
  expect(source).toContain("infraGossipLog.warn('profile.restore_failed'");
  expect(source).not.toContain('console.');
  expect(source).not.toContain('[infra-db]');
});

test('loadGossipProfilesFromInfraDb prunes malformed persisted profile', async () => {
  const previousLogLevel = process.env['XLN_LOG_LEVEL'];
  process.env['XLN_LOG_LEVEL'] = 'error';
  const entityId = `0x${'aa'.repeat(32)}`;
  const db = new FakeInfraDb();
  db.store.set('gossip:index', Buffer.from(serializeTaggedJson([entityId])));
  db.store.set(`gossip:profile:${entityId}`, Buffer.from(serializeTaggedJson({ entityId })));

  const announced: unknown[] = [];
  const env = {
    gossip: {
      announce: (profile: unknown) => {
        announced.push(profile);
      },
    },
  } as Env;

  try {
    await loadGossipProfilesFromInfraDb(env, {
      tryOpenInfraDb: async () => true,
      getInfraDb: () => db as never,
    });

    expect(announced).toHaveLength(0);
    expect(db.store.has(`gossip:profile:${entityId}`)).toBe(false);
    expect(db.store.has('gossip:index')).toBe(false);
  } finally {
    if (previousLogLevel === undefined) delete process.env['XLN_LOG_LEVEL'];
    else process.env['XLN_LOG_LEVEL'] = previousLogLevel;
  }
});

test('infra gossip restore discovers every durable profile when the legacy index lost a concurrent update', async () => {
  const firstSeed = 'infra-gossip-index-race-first';
  const secondSeed = 'infra-gossip-index-race-second';
  const firstEntityId = deriveSingleSignerFixtureEntityId(firstSeed);
  const secondEntityId = deriveSingleSignerFixtureEntityId(secondSeed);
  const db = new FakeInfraDb();

  // The old read/modify/write index could publish only one id even though both
  // profile records had already committed in independent LevelDB batches.
  db.store.set('gossip:index', Buffer.from(serializeTaggedJson([firstEntityId])));
  db.store.set(
    `gossip:profile:${firstEntityId}`,
    Buffer.from(serializeTaggedJson(buildCryptographicProfileFixture({
      entityId: firstEntityId,
      signingSeed: firstSeed,
      name: 'First',
    }))),
  );
  db.store.set(
    `gossip:profile:${secondEntityId}`,
    Buffer.from(serializeTaggedJson(buildCryptographicProfileFixture({
      entityId: secondEntityId,
      signingSeed: secondSeed,
      name: 'Second',
    }))),
  );

  const restored = createEmptyEnv('infra-gossip-index-race-probe');
  await loadGossipProfilesFromInfraDb(restored, {
    tryOpenInfraDb: async () => true,
    getInfraDb: () => db as never,
  });

  expect(restored.gossip.getProfiles().map(({ entityId }) => entityId).sort()).toEqual(
    [firstEntityId, secondEntityId].sort(),
  );
});

test('relocation clear drains pending profile writes before deleting durable gossip', async () => {
  const seed = `infra-gossip-relocation-${process.pid}-${Date.now()}`;
  const entityId = deriveSingleSignerFixtureEntityId(seed);
  const env = createEmptyEnv(seed);
  env.dbNamespace = `${String(env.runtimeId)}-relocation-clear`;
  const infraPath = resolveDbPath(env, 'infra');
  const restoredProfiles: unknown[] = [];
  let probe: Env | null = null;

  try {
    expect(await tryOpenInfraDb(env)).toBe(true);
    env.gossip.announce({
      ...buildCryptographicProfileFixture({ entityId, signingSeed: seed, name: 'Relocated runtime' }),
      wsUrl: 'ws://127.0.0.1:19711/ws',
      relays: ['ws://127.0.0.1:19704/relay'],
    });
    expect(env.runtimeState?.infraDbPendingWrites?.size).toBe(1);

    const clearing = clearGossip(env);
    expect(clearing).toBeInstanceOf(Promise);
    await clearing;
    expect(env.gossip.getProfiles()).toHaveLength(0);
    expect(env.runtimeState?.infraDbPendingWrites?.size ?? 0).toBe(0);
    await closeInfraDb(env);

    probe = createEmptyEnv(seed);
    probe.dbNamespace = env.dbNamespace;
    await loadGossipProfilesFromInfraDb(probe, {
      tryOpenInfraDb,
      getInfraDb,
    });
    restoredProfiles.push(...probe.gossip.getProfiles());
    expect(restoredProfiles).toHaveLength(0);
  } finally {
    await closeInfraDb(env);
    if (probe) await closeInfraDb(probe);
    await rm(infraPath, { recursive: true, force: true });
  }
});

test('relocation clear removes only profiles owned by the moved runtime', async () => {
  const localSeed = `infra-gossip-local-relocation-${process.pid}-${Date.now()}`;
  const remoteSeed = `${localSeed}-remote`;
  const localEntityId = deriveSingleSignerFixtureEntityId(localSeed);
  const remoteEntityId = deriveSingleSignerFixtureEntityId(remoteSeed);
  const env = createEmptyEnv(localSeed);
  env.dbNamespace = `${String(env.runtimeId)}-scoped-relocation-clear`;
  const infraPath = resolveDbPath(env, 'infra');
  let probe: Env | null = null;

  try {
    expect(await tryOpenInfraDb(env)).toBe(true);
    env.gossip.announce(buildCryptographicProfileFixture({
      entityId: localEntityId,
      signingSeed: localSeed,
      runtimeId: String(env.runtimeId),
      name: 'Local moved runtime',
    }));
    env.gossip.announce(buildCryptographicProfileFixture({
      entityId: remoteEntityId,
      signingSeed: remoteSeed,
      name: 'Remote peer',
    }));

    await clearGossip(env, { runtimeId: String(env.runtimeId) });
    expect(env.gossip.getProfiles().map(({ entityId }) => entityId)).toEqual([remoteEntityId]);
    await closeInfraDb(env);

    probe = createEmptyEnv(localSeed);
    probe.dbNamespace = env.dbNamespace;
    await loadGossipProfilesFromInfraDb(probe, { tryOpenInfraDb, getInfraDb });
    expect(probe.gossip.getProfiles().map(({ entityId }) => entityId)).toEqual([remoteEntityId]);
  } finally {
    await closeInfraDb(env);
    if (probe) await closeInfraDb(probe);
    await rm(infraPath, { recursive: true, force: true });
  }
});
