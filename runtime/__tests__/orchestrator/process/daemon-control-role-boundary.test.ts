import { afterEach, describe, expect, test } from 'bun:test';

import { DaemonControlClient } from '../../../orchestrator/daemon-control';

const originalFetch = globalThis.fetch;
const ENTITY = `0x${'11'.repeat(32)}`;
const SIGNER = `0x${'22'.repeat(20)}`;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const responseWith = (entity: Record<string, unknown>): Response => new Response(JSON.stringify({
  ok: true,
  runtimeId: null,
  entities: [entity],
}), { status: 200, headers: { 'content-type': 'application/json' } });

const validEntity = (): Record<string, unknown> => ({
  entityId: ENTITY,
  signerId: SIGNER,
  name: 'Custody',
  isRoutingEnabled: false,
  isHub: false,
  runtimeId: null,
  accountCount: 0,
  publicAccountCount: 0,
  accountEntityIds: [],
});

describe('daemon control committed role boundary', () => {
  test('preserves an explicit committed false role', async () => {
    globalThis.fetch = async () => responseWith(validEntity());
    const entities = await new DaemonControlClient({ baseUrl: 'http://control.test' }).listEntities();
    expect(entities[0]?.isHub).toBe(false);
  });

  test('rejects missing or malformed role instead of applying operator policy', async () => {
    const missing = validEntity();
    delete missing['isHub'];
    globalThis.fetch = async () => responseWith(missing);
    await expect(
      new DaemonControlClient({ baseUrl: 'http://control.test' }).listEntities(),
    ).rejects.toThrow('CONTROL_ENTITY_SUMMARY_FIELDS_INVALID');

    globalThis.fetch = async () => responseWith({ ...validEntity(), isHub: 'false' });
    await expect(
      new DaemonControlClient({ baseUrl: 'http://control.test' }).listEntities(),
    ).rejects.toThrow('CONTROL_ENTITY_SUMMARY_ROLE_INVALID');
  });

  test('binds every committed role row to the authenticated Runtime response', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: true,
      runtimeId: `0x${'33'.repeat(20)}`,
      entities: [{ ...validEntity(), runtimeId: `0x${'44'.repeat(20)}` }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    await expect(
      new DaemonControlClient({ baseUrl: 'http://control.test' }).listEntities(),
    ).rejects.toThrow('CONTROL_ENTITIES_RESPONSE_RUNTIME_ID_MISMATCH');
  });
});
