import { expect, test } from 'bun:test';

import {
  deriveRuntimeAdapterAuthKey,
  deriveRuntimeAdapterCapabilityToken,
  verifyRuntimeAdapterAuthCredential,
  verifyRuntimeAdapterAuthKey,
} from '../radapter/auth';
import { decodeRuntimeAdapterMessage, encodeRuntimeAdapterMessage } from '../radapter/codec';
import { resolveRuntimeAdapterRead } from '../radapter/resolve';
import { broadcastRuntimeAdapterTick, handleRuntimeAdapterMessage } from '../radapter/server';
import type { EntityReplica, Env } from '../types';

const entityId = `0x${'aa'.repeat(32)}`;
const counterpartyId = `0x${'bb'.repeat(32)}`;

const makeEnv = (): Env => ({
  height: 7,
  timestamp: 700,
  runtimeSeed: 'seed',
  eReplicas: new Map<string, EntityReplica>([
    [`${entityId}:signer`, {
      entityId,
      signerId: 'signer',
      mempool: [],
      isProposer: true,
      state: {
        entityId,
        height: 7,
        timestamp: 700,
        messages: [],
        nonces: new Map(),
        proposals: new Map(),
        config: { mode: 'proposer-based', threshold: 1n, validators: ['signer'], shares: { signer: 1n } },
        reserves: new Map([[1, 100n]]),
        accounts: new Map([
          [counterpartyId, {
            leftEntity: entityId,
            rightEntity: counterpartyId,
            status: 'active',
            mempool: [],
            currentFrame: {
              height: 1,
              timestamp: 700,
              jHeight: 0,
              accountTxs: [],
              prevFrameHash: 'genesis',
              stateHash: '0x1',
              deltas: [],
            },
            deltas: new Map(),
            locks: new Map(),
            swapOffers: new Map(),
            globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
            currentHeight: 1,
            pendingSignatures: [],
            rollbackCount: 0,
            proofHeader: { fromEntity: entityId, toEntity: counterpartyId, nonce: 0 },
            proofBody: { tokenIds: [], deltas: [] },
            pendingWithdrawals: new Map(),
            requestedRebalance: new Map(),
            requestedRebalanceFeeState: new Map(),
            rebalancePolicy: new Map(),
            leftJObservations: [],
            rightJObservations: [],
            jEventChain: [],
            lastFinalizedJHeight: 0,
            disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
            onChainSettlementNonce: 0,
          }],
        ]),
        deferredAccountProposals: new Map(),
        lastFinalizedJHeight: 0,
        jBlockObservations: [],
        jBlockChain: [],
        entityEncPubKey: 'pub',
        entityEncPrivKey: 'priv',
        profile: { name: 'Adapter Test', isHub: false, avatar: '', bio: '', website: '' },
        htlcRoutes: new Map(),
        htlcFeesEarned: 0n,
        htlcNotes: new Map(),
        lockBook: new Map(),
        swapTradingPairs: [],
        pendingSwapFillRatios: new Map(),
      },
    } as EntityReplica],
  ]),
}) as Env;

test('runtime adapter auth keys are scoped by level', () => {
  const inspect = deriveRuntimeAdapterAuthKey('seed', 'inspect');
  const admin = deriveRuntimeAdapterAuthKey('seed', 'admin');
  const readToken = deriveRuntimeAdapterCapabilityToken('seed', 'read', Date.now() + 60_000);
  const fullToken = deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000);
  expect(inspect).not.toBe(admin);
  expect(verifyRuntimeAdapterAuthKey('seed', inspect)).toBe('inspect');
  expect(verifyRuntimeAdapterAuthKey('seed', admin)).toBe('admin');
  expect(verifyRuntimeAdapterAuthCredential('seed', readToken)?.level).toBe('inspect');
  expect(verifyRuntimeAdapterAuthCredential('seed', fullToken)?.level).toBe('admin');
  expect(() => deriveRuntimeAdapterCapabilityToken('seed', 'read', Date.now() - 1)).toThrow('RADAPTER_AUTH_EXPIRY_REQUIRED');
  expect(verifyRuntimeAdapterAuthKey('seed', `${admin.slice(0, -1)}0`)).toBe(null);
});

test('runtime adapter resolver reads live head and entity paths', async () => {
  const env = makeEnv();
  const head = await resolveRuntimeAdapterRead<{ latestHeight: number }>({ env }, 'head');
  const entities = await resolveRuntimeAdapterRead<Array<{ entityId: string; label: string }>>({ env }, 'entities');
  const entity = await resolveRuntimeAdapterRead<{ entityId: string; profile: { name: string } }>({ env }, `entity/${entityId}`);
  const accounts = await resolveRuntimeAdapterRead<{ items: Array<{ currentHeight: number }>; nextCursor: string | null }>(
    { env },
    `entity/${entityId}/accounts`,
  );

  expect(head.latestHeight).toBe(7);
  expect(entities).toEqual([{ entityId, label: 'Adapter Test', height: 7 }]);
  expect(entity.entityId).toBe(entityId);
  expect(entity.profile.name).toBe('Adapter Test');
  expect(accounts.items).toHaveLength(1);
  expect(accounts.items[0]?.currentHeight).toBe(1);
  expect(accounts.nextCursor).toBe(null);
});

test('runtime adapter resolver returns a bounded view frame for the app shell', async () => {
  const env = makeEnv();
  const frame = await resolveRuntimeAdapterRead<{
    height: number;
    entities: Array<{ entityId: string }>;
    activeEntityId: string | null;
    activeEntity: {
      core: { entityId: string; profile?: { name?: string } };
      accounts: { items: Array<{ leftEntity: string; rightEntity: string }>; nextCursor: string | null };
      books: { items: unknown[] };
    } | null;
  }>({ env }, 'view-frame', { accountsLimit: 1, booksLimit: 1 });

  expect(frame.height).toBe(7);
  expect(frame.entities.map((entity) => entity.entityId)).toEqual([entityId]);
  expect(frame.activeEntityId).toBe(entityId);
  expect(frame.activeEntity?.core.entityId).toBe(entityId);
  expect(frame.activeEntity?.core.profile?.name).toBe('Adapter Test');
  expect(frame.activeEntity?.accounts.items).toHaveLength(1);
  expect(frame.activeEntity?.accounts.items[0]?.leftEntity).toBe(entityId);
  expect(frame.activeEntity?.accounts.items[0]?.rightEntity).toBe(counterpartyId);
  expect(frame.activeEntity?.accounts.nextCursor).toBe(null);
  expect(frame.activeEntity?.books.items).toEqual([]);
});

test('runtime adapter view frame defaults to 10 accounts and cursor pagination', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const base = replica.state.accounts.get(counterpartyId)!;
  replica.state.accounts.clear();
  for (let i = 0; i < 12; i += 1) {
    const id = `0x${(i + 1).toString(16).padStart(64, '0')}`;
    replica.state.accounts.set(id, {
      ...base,
      rightEntity: id,
      proofHeader: { ...base.proofHeader, toEntity: id },
    });
  }

  const first = await resolveRuntimeAdapterRead<{
    activeEntity: { accounts: { items: Array<{ rightEntity: string }>; nextCursor: string | null } } | null;
  }>({ env }, 'view-frame');
  expect(first.activeEntity?.accounts.items).toHaveLength(10);
  expect(first.activeEntity?.accounts.nextCursor).toBe(`0x${'0a'.padStart(64, '0')}`);

  const second = await resolveRuntimeAdapterRead<{
    items: Array<{ rightEntity: string }>;
    nextCursor: string | null;
  }>({ env }, `entity/${entityId}/accounts`, { cursor: first.activeEntity?.accounts.nextCursor || undefined });
  expect(second.items).toHaveLength(2);
  expect(second.items.map((item) => item.rightEntity)).toEqual([
    `0x${'0b'.padStart(64, '0')}`,
    `0x${'0c'.padStart(64, '0')}`,
  ]);
  expect(second.nextCursor).toBe(null);
});

test('runtime adapter binary codec preserves structured payloads', () => {
  const encoded = encodeRuntimeAdapterMessage({
    v: 1,
    id: 'send-1',
    op: 'send',
    input: {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId: 'signer',
        entityTxs: [{
          type: 'directPayment',
          data: {
            targetEntityId: counterpartyId,
            tokenId: 1,
            amount: 1234567890123456789n,
            route: [entityId, counterpartyId],
            metadata: new Map([['purpose', 'radapter-binary-test']]),
            tags: new Set(['binary', 'codec']),
            bytes: new Uint8Array([1, 2, 3]),
          },
        }],
      }],
    },
  });
  const decoded = decodeRuntimeAdapterMessage<{
    input: { entityInputs: Array<{ entityTxs: Array<{ data: { amount: bigint; metadata: Map<string, string>; tags: Set<string>; bytes: Uint8Array } }> }> };
  }>(encoded);

  const data = decoded.input.entityInputs[0]?.entityTxs[0]?.data;
  expect(data?.amount).toBe(1234567890123456789n);
  expect(data?.metadata.get('purpose')).toBe('radapter-binary-test');
  expect(data?.tags.has('codec')).toBe(true);
  expect(Array.from(data?.bytes ?? [])).toEqual([1, 2, 3]);
});

test('runtime adapter rejects oversized wire messages before decoding', () => {
  const previous = process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'];
  process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'] = '4';
  try {
    expect(() => decodeRuntimeAdapterMessage(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/RADAPTER_MESSAGE_TOO_LARGE/);
  } finally {
    if (previous === undefined) {
      delete process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'];
    } else {
      process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'] = previous;
    }
  }
});

test('runtime adapter websocket handler gates reads behind inspect auth', async () => {
  const messages: unknown[] = [];
  const socket = { send: (message: unknown) => { messages.push(message); } };
  const env = makeEnv();

  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'read-1', op: 'read', path: 'head' }, env, {
    enqueueRuntimeInput: () => {},
  });
  const denied = decodeRuntimeAdapterMessage<{ ok: false; error: { code: string } }>(messages.pop());
  expect(denied.ok).toBe(false);
  expect(denied.error.code).toBe('E_UNAUTHORIZED');

  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'auth-1', op: 'auth', key: deriveRuntimeAdapterAuthKey('seed', 'inspect') }, env, {
    enqueueRuntimeInput: () => {},
  });
  const authed = decodeRuntimeAdapterMessage<{ ok: true; payload: { authLevel: string } }>(messages.pop());
  expect(authed.ok).toBe(true);
  expect(authed.payload.authLevel).toBe('inspect');

  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'read-2', op: 'read', path: 'head' }, env, {
    enqueueRuntimeInput: () => {},
  });
  const read = decodeRuntimeAdapterMessage<{ ok: true; payload: { latestHeight: number } }>(messages.pop());
  expect(read.ok).toBe(true);
  expect(read.payload.latestHeight).toBe(7);
});

test('runtime adapter ticks only go to authenticated clients', async () => {
  const env = makeEnv();
  const unauthMessages: unknown[] = [];
  const inspectMessages: unknown[] = [];
  const unauthSocket = { send: (message: unknown) => { unauthMessages.push(message); } };
  const inspectSocket = { send: (message: unknown) => { inspectMessages.push(message); } };

  await handleRuntimeAdapterMessage(unauthSocket, { v: 1, id: 'read-unauth', op: 'read', path: 'head' }, env, {
    enqueueRuntimeInput: () => {},
  });
  unauthMessages.length = 0;

  await handleRuntimeAdapterMessage(inspectSocket, { v: 1, id: 'auth-inspect', op: 'auth', key: deriveRuntimeAdapterAuthKey('seed', 'inspect') }, env, {
    enqueueRuntimeInput: () => {},
  });
  inspectMessages.length = 0;

  broadcastRuntimeAdapterTick(env);

  expect(unauthMessages).toHaveLength(0);
  expect(inspectMessages).toHaveLength(1);
  const tick = decodeRuntimeAdapterMessage<{ op: string; height: number }>(inspectMessages[0]);
  expect(tick.op).toBe('tick');
  expect(tick.height).toBe(7);
});
