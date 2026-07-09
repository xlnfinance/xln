import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadGossipProfilesFromInfraDb } from '../runtime-infra-gossip-store';
import { serializeTaggedJson } from '../serialization-utils';
import type { Env } from '../types';

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
}

test('runtime infra gossip restore diagnostics use structured logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/runtime-infra-gossip-store.ts'), 'utf8');

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
