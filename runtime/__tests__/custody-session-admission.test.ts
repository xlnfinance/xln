import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSessionCreationLimiter,
  resolveCustodySessionClientId,
} from '../../custody/session-admission';
import { CustodyStore } from '../../custody/store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('custody session admission', () => {
  test('bounds creation globally, per client, and by tracked client count', () => {
    const allow = createSessionCreationLimiter({
      windowMs: 1_000,
      perClientLimit: 2,
      globalLimit: 3,
      maxTrackedClients: 2,
    });
    expect(allow('a', 1_000)).toBeTrue();
    expect(allow('a', 1_001)).toBeTrue();
    expect(allow('a', 1_002)).toBeFalse();
    expect(allow('b', 1_003)).toBeTrue();
    expect(allow('c', 1_004)).toBeFalse();
    expect(allow('c', 2_001)).toBeTrue();
  });

  test('trusts proxy client identity only from a loopback peer', () => {
    const headers = {
      host: 'custody.xln.finance',
      'x-real-ip': '203.0.113.8',
    };
    const request = new Request('http://custody.xln.finance/api/reset-session', { headers });
    expect(resolveCustodySessionClientId(request, '127.0.0.1')).toBe('203.0.113.8');
    expect(resolveCustodySessionClientId(request, '198.51.100.7')).toBe('198.51.100.7');
  });

  test('prunes only stale empty sessions and refuses to evict financial identities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-custody-session-'));
    roots.push(root);
    const store = new CustodyStore(join(root, 'custody.sqlite'), { maxSessions: 2, emptySessionTtlMs: 1 });
    store.createSession('funded-token', 'funded-user');
    store.creditDeposit({
      eventKey: 'deposit-1',
      userId: 'funded-user',
      tokenId: 1,
      amountMinor: 1n,
      description: 'funded',
      fromEntityId: 'source',
      hashlock: 'hashlock',
      frameHeight: 1,
      createdAt: Date.now(),
    });
    store.createSession('empty-token', 'empty-user');
    await Bun.sleep(2);
    store.createSession('replacement-token', 'replacement-user');
    expect(store.getSessionByToken('funded-token')?.userId).toBe('funded-user');
    expect(store.getSessionByToken('empty-token')).toBeNull();
    expect(() => store.createSession('overflow-token', 'overflow-user'))
      .toThrow('CUSTODY_SESSION_CAPACITY_REACHED');
    store.close();
  });
});
