import { afterEach, describe, expect, test } from 'bun:test';

import { createEmptyEnv, startP2P } from '../../../runtime';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { deriveEncryptionKeyPair } from '../../../protocol/crypto/p2p-crypto';
import { decodeRuntimeEntityInputsEnvelope } from '../../../network/p2p/auth/entity-input-envelope';
import { RuntimeWsClient } from '../../../network/p2p/ws-client';
import { directRuntimeWsAudience } from '../../../network/p2p/ws-protocol';
import {
  createHubDirectRuntimeRoute,
  type DirectInputDebugState,
} from '../../../orchestrator/hub/hub-runtime-transport';
import { ensureRuntimeInfrastructure } from '../../../runtime/envelope/replica-envelope';
import { getRuntimeCommandReadiness, transitionRuntimeLifecycle } from '../../../runtime/replica/lifecycle';
import type { EntityTx } from '../../../types/entity-tx';

const HUB_SEED = 'hub-ingress-debug-server';
const PEER_SEED = 'hub-ingress-debug-peer';
const HUB_ID = deriveSignerAddressSync(HUB_SEED, '1').toLowerCase();
const PEER_ID = deriveSignerAddressSync(PEER_SEED, '1').toLowerCase();
const UNKNOWN_ENTITY = `0x${'41'.repeat(32)}`;
const clients: RuntimeWsClient[] = [];
const transports: NonNullable<ReturnType<typeof startP2P>>[] = [];
const stopServers: Array<() => void> = [];

afterEach(async () => {
  try {
    await Promise.all([...clients.splice(0), ...transports.splice(0)].map(client => client.closeAndWait()));
  } finally {
    for (const stop of stopServers.splice(0)) stop();
  }
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) await Bun.sleep(5);
  expect(predicate()).toBe(true);
};

const envelopeWith = (entityTxs: EntityTx[]) => decodeRuntimeEntityInputsEnvelope({
  sourceRuntimeId: PEER_ID,
  sourceRuntimeHeight: 7,
  sourceRuntimeTimestamp: 123,
  entityInputs: [{ entityId: UNKNOWN_ENTITY, runtimeId: HUB_ID, signerId: HUB_ID, entityTxs }],
});

const connectHub = async () => {
  const env = createEmptyEnv(HUB_SEED, 1);
  transitionRuntimeLifecycle(ensureRuntimeInfrastructure(env), 'running');
  const p2p = startP2P(env, { relayUrls: [] });
  if (!p2p) throw new Error('TEST_REAL_P2P_NOT_STARTED');
  transports.push(p2p);
  const debug: DirectInputDebugState = { lastSeen: null, lastError: null };
  const route = createHubDirectRuntimeRoute(env, HUB_SEED, () => getRuntimeCommandReadiness(env).ready, debug);
  const server = Bun.serve<{ type: 'direct-runtime' }>({
    hostname: '127.0.0.1', port: 0,
    fetch(request, bunServer) {
      const decision = route.maybeUpgrade(request, bunServer);
      return decision.handled ? decision.response : new Response('websocket only', { status: 400 });
    },
    websocket: route.websocket,
  });
  stopServers.push(() => server.stop(true));
  const errors: string[] = [];
  const client = new RuntimeWsClient({
    url: `ws://127.0.0.1:${server.port}${route.path}`,
    runtimeId: PEER_ID,
    helloAudience: directRuntimeWsAudience(HUB_ID),
    signerId: '1', seed: PEER_SEED,
    encryptionKeyPair: deriveEncryptionKeyPair(PEER_SEED),
    getTargetEncryptionKey: () => deriveEncryptionKeyPair(HUB_SEED).publicKey,
    onError: error => { errors.push(error.message); },
  });
  clients.push(client);
  await client.connect();
  await waitFor(() => client.canDeliver());
  return { env, debug, client, errors };
};

describe('hub direct Runtime ingress progress evidence', () => {
  test('an unknown tx-empty target records ignored completion with zero queued inputs', async () => {
    const h = await connectHub();
    expect(h.client.sendEntityInputsRaw(HUB_ID, envelopeWith([]))).toBe(true);
    await waitFor(() => h.debug.lastSeen?.stage === 'ignored');
    expect(h.debug.lastSeen).toMatchObject({
      stage: 'ignored', queuedInputs: 0, fromRuntimeId: PEER_ID,
      entityIds: [UNKNOWN_ENTITY], signerIds: [HUB_ID], txTypes: [],
    });
    expect(typeof h.debug.lastSeen?.completedAt).toBe('number');
    expect(h.debug.lastSeen?.completedAt).toBeGreaterThanOrEqual(h.debug.lastSeen?.at ?? 0);
    expect(h.debug.lastError).toBeNull();
    expect(h.env.runtimeMempool?.entityInputs).toEqual([]);
    expect(h.env.state.height).toBe(0);
    expect(h.errors).toEqual([]);
  });

  test('a decoded transactional unknown target preserves rejected evidence and reports the remote error', async () => {
    const h = await connectHub();
    const envelope = envelopeWith([{ type: 'chat', data: { from: PEER_ID, message: 'unknown-target' } }]);
    expect(h.client.sendEntityInputsRaw(HUB_ID, envelope)).toBe(true);
    await waitFor(() => h.debug.lastSeen?.stage === 'rejected' && h.errors.length > 0);
    expect(h.debug.lastSeen).toMatchObject({
      stage: 'rejected', fromRuntimeId: PEER_ID, entityIds: [UNKNOWN_ENTITY],
      txTypes: ['chat'],
    });
    expect(typeof h.debug.lastSeen?.completedAt).toBe('number');
    expect(h.debug.lastError).toMatchObject({
      stage: 'rejected', fromRuntimeId: PEER_ID, entityIds: [UNKNOWN_ENTITY],
      txTypes: ['chat'],
    });
    expect(typeof h.debug.lastError?.completedAt).toBe('number');
    expect(h.debug.lastError?.error).toContain('INBOUND_ENTITY_UNKNOWN_TARGET');
    expect(h.errors.some(error => error.includes('P2P_REMOTE_REJECTED:'))).toBe(true);
    expect(h.errors.some(error => error.includes('INBOUND_ENTITY_UNKNOWN_TARGET'))).toBe(true);
    expect(h.env.runtimeMempool?.entityInputs).toEqual([]);
    expect(h.env.state.height).toBe(0);
  });
});
