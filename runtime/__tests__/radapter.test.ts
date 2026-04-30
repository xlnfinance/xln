import { expect, test } from 'bun:test';

import { deriveRuntimeAdapterAuthKey, verifyRuntimeAdapterAuthKey } from '../radapter/auth';
import { resolveRuntimeAdapterRead } from '../radapter/resolve';
import { handleRuntimeAdapterMessage } from '../radapter/server';
import { deserializeTaggedJson } from '../serialization-utils';
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
  expect(inspect).not.toBe(admin);
  expect(verifyRuntimeAdapterAuthKey('seed', inspect)).toBe('inspect');
  expect(verifyRuntimeAdapterAuthKey('seed', admin)).toBe('admin');
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

test('runtime adapter websocket handler gates reads behind inspect auth', async () => {
  const messages: string[] = [];
  const socket = { send: (message: string) => { messages.push(message); } };
  const env = makeEnv();

  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'read-1', op: 'read', path: 'head' }, env, {
    enqueueRuntimeInput: () => {},
  });
  const denied = deserializeTaggedJson<{ ok: false; error: { code: string } }>(messages.pop() ?? '');
  expect(denied.ok).toBe(false);
  expect(denied.error.code).toBe('E_UNAUTHORIZED');

  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'auth-1', op: 'auth', key: deriveRuntimeAdapterAuthKey('seed', 'inspect') }, env, {
    enqueueRuntimeInput: () => {},
  });
  const authed = deserializeTaggedJson<{ ok: true; payload: { authLevel: string } }>(messages.pop() ?? '');
  expect(authed.ok).toBe(true);
  expect(authed.payload.authLevel).toBe('inspect');

  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'read-2', op: 'read', path: 'head' }, env, {
    enqueueRuntimeInput: () => {},
  });
  const read = deserializeTaggedJson<{ ok: true; payload: { latestHeight: number } }>(messages.pop() ?? '');
  expect(read.ok).toBe(true);
  expect(read.payload.latestHeight).toBe(7);
});
