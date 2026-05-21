import { ethers } from 'ethers';
import type { Env, RuntimeInput } from '../types';
import type { JAdapter } from '../jadapter';
import { DEV_CHAIN_IDS } from '../jadapter';
import { safeStringify } from '../serialization-utils';
import { createStructuredLogger, shortId } from '../logger';
import { resolveEntityProposerId } from '../state-helpers';
import { formatTimingMs, getErrorMessage } from '../server-utils';
import { getEntityReplicaById } from './entity-lookup';
import { getFaucetHubProfiles } from './faucet-hubs';
import type { RelayStore } from '../relay-store';

type TokenCatalogEntry = {
  tokenId?: number | string | null;
  symbol?: string | null;
  decimals?: number | null;
};

const faucetLog = createStructuredLogger('server.faucet');

const faucetLock = {
  locked: false,
  queue: [] as Array<() => void>,

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  },

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  },
};

const resolveRuntimeWaitPollMs = (adapter: JAdapter | null): number => {
  if (!adapter) return 100;
  if (adapter.mode === 'browservm') return 10;
  if (DEV_CHAIN_IDS.has(adapter.chainId)) return 25;
  return 100;
};

const resolveReserveWaitPollMs = (adapter: JAdapter | null): number => {
  if (!adapter) return 300;
  if (adapter.mode === 'browservm') return 10;
  if (DEV_CHAIN_IDS.has(adapter.chainId)) return 50;
  return 300;
};

const hasPendingRuntimeWork = (env: Env): boolean => {
  if (env.pendingOutputs?.length) return true;
  if (env.networkInbox?.length) return true;
  if (env.runtimeInput?.runtimeTxs?.length) return true;
  if (env.runtimeMempool?.entityInputs?.length) return true;
  if (env.runtimeMempool?.runtimeTxs?.length) return true;

  if (env.jReplicas) {
    for (const replica of env.jReplicas.values()) {
      if ((replica.mempool?.length ?? 0) > 0) return true;
    }
  }

  return false;
};

const waitForRuntimeIdle = async (env: Env, adapter: JAdapter | null, timeoutMs = 5000): Promise<boolean> => {
  const started = Date.now();
  const pollMs = resolveRuntimeWaitPollMs(adapter);
  while (Date.now() - started < timeoutMs) {
    if (!hasPendingRuntimeWork(env)) return true;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return false;
};

const waitForJBatchClear = async (env: Env, adapter: JAdapter | null, timeoutMs = 5000): Promise<boolean> => {
  const started = Date.now();
  const pollMs = resolveRuntimeWaitPollMs(adapter);
  while (Date.now() - started < timeoutMs) {
    const pendingJ = Array.from(env.jReplicas?.values?.() || []).some(j => (j.mempool?.length ?? 0) > 0);
    if (!pendingJ && !hasPendingRuntimeWork(env)) return true;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return false;
};

const hasEntitySentBatchPending = (env: Env, entityId: string): boolean => {
  const replica = getEntityReplicaById(env, entityId);
  return Boolean(replica?.state?.jBatchState?.sentBatch);
};

const waitForEntityBroadcastWindow = async (
  env: Env,
  adapter: JAdapter | null,
  entityId: string,
  timeoutMs = 10000,
): Promise<boolean> => {
  const started = Date.now();
  const pollMs = resolveRuntimeWaitPollMs(adapter);
  while (Date.now() - started < timeoutMs) {
    if (!hasEntitySentBatchPending(env, entityId)) return true;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return false;
};

const waitForReserveUpdate = async (
  adapter: JAdapter,
  entityId: string,
  tokenId: number,
  expectedMin: bigint,
  timeoutMs = 10000,
): Promise<bigint | null> => {
  const started = Date.now();
  const pollMs = resolveReserveWaitPollMs(adapter);
  while (Date.now() - started < timeoutMs) {
    try {
      const current = await adapter.getReserves(entityId, tokenId);
      if (current >= expectedMin) return current;
    } catch (err) {
      faucetLog.debug('reserve.poll_failed', { error: (err as Error).message });
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return null;
};

export const handleReserveFaucet = async (input: {
  req: Request;
  env: Env | null;
  headers: HeadersInit;
  relayStore: RelayStore;
  getJAdapter: () => JAdapter | null;
  ensureTokenCatalog: () => Promise<TokenCatalogEntry[]>;
  enqueueRuntimeInput: (env: Env, runtimeInput: RuntimeInput) => void;
}): Promise<Response> => {
  const { req, env, headers, relayStore, getJAdapter, ensureTokenCatalog, enqueueRuntimeInput } = input;
  await faucetLock.acquire();
  try {
    const adapter = getJAdapter();
    if (!adapter) {
      return new Response(safeStringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
    }
    if (!env) {
      return new Response(safeStringify({ error: 'Runtime not initialized' }), { status: 503, headers });
    }

    const body = await req.json();
    const userEntityId = body?.userEntityId;
    const rawTokenId = body?.tokenId ?? 1;
    let tokenId = typeof rawTokenId === 'number' ? rawTokenId : Number(rawTokenId);
    const tokenSymbol = typeof body?.tokenSymbol === 'string' ? body.tokenSymbol : undefined;
    const amount = typeof body?.amount === 'string' ? body.amount : String(body?.amount ?? '100');
    const requestId =
      globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    if (!userEntityId) {
      return new Response(safeStringify({ error: 'Missing userEntityId' }), { status: 400, headers });
    }
    if (!Number.isFinite(tokenId)) {
      return new Response(safeStringify({ error: 'Invalid tokenId' }), { status: 400, headers });
    }

    const hubs = getFaucetHubProfiles(env, relayStore.activeHubEntityIds);
    if (hubs.length === 0) {
      return new Response(
        JSON.stringify({
          error: 'No faucet hub available',
          code: 'FAUCET_HUBS_EMPTY',
          profiles: env.gossip?.getProfiles?.()?.length || 0,
          activeHubEntityIds: relayStore.activeHubEntityIds,
        }),
        { status: 503, headers },
      );
    }
    const hubEntityId = hubs[0]!.entityId;

    const hubSignerId = resolveEntityProposerId(env, hubEntityId, 'faucet-reserve');
    const tokenCatalog = await ensureTokenCatalog();
    let tokenMeta = tokenCatalog.find(t => Number(t.tokenId) === Number(tokenId));
    if (!tokenMeta && tokenSymbol) {
      tokenMeta = tokenCatalog.find(t => t.symbol?.toUpperCase?.() === tokenSymbol.toUpperCase());
      if (tokenMeta?.tokenId !== undefined && tokenMeta?.tokenId !== null) {
        tokenId = Number(tokenMeta.tokenId);
      }
    }
    if (!tokenMeta) {
      return new Response(safeStringify({ error: `Unknown token for faucet`, tokenId, tokenSymbol }), {
        status: 400,
        headers,
      });
    }
    const decimals = typeof tokenMeta.decimals === 'number' ? tokenMeta.decimals : 18;
    const amountWei = ethers.parseUnits(amount, decimals);
    const requestStartedAt = Date.now();
    faucetLog.info('reserve.request', {
      requestId,
      hub: shortId(hubEntityId, 8),
      user: shortId(userEntityId, 8),
      tokenId,
      amount,
    });

    const prevUserReserve = await adapter.getReserves(userEntityId, tokenId).catch(() => 0n);
    const hubReplicaKey = Array.from(env.eReplicas?.keys?.() || []).find(key => key.startsWith(`${hubEntityId}:`));
    const hubReplica = hubReplicaKey ? env.eReplicas?.get(hubReplicaKey) : null;
    const hubReserve = hubReplica?.state?.reserves?.get(tokenId) ?? 0n;
    if (hubReserve < amountWei) {
      return new Response(
        JSON.stringify({
          error: `Hub has insufficient reserves for token ${tokenId}`,
          have: hubReserve.toString(),
          need: amountWei.toString(),
          requestId,
        }),
        { status: 409, headers },
      );
    }

    const enqueueReserveTransfer = (): void => {
      enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [
          {
            entityId: hubEntityId,
            signerId: hubSignerId,
            entityTxs: [
              {
                type: 'r2r',
                data: {
                  toEntityId: userEntityId,
                  tokenId,
                  amount: amountWei,
                },
              },
            ],
          },
        ],
      });
    };

    const enqueueBatchBroadcast = (): void => {
      enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [
          {
            entityId: hubEntityId,
            signerId: hubSignerId,
            entityTxs: [{ type: 'j_broadcast', data: {} }],
          },
        ],
      });
    };

    enqueueReserveTransfer();
    const runtimeIdleStartedAt = Date.now();
    const runtimeIdle = await waitForRuntimeIdle(env, adapter, 5000);
    const runtimeIdleMs = Date.now() - runtimeIdleStartedAt;
    if (!runtimeIdle) {
      faucetLog.warn('reserve.runtime_idle_timeout', {
        requestId,
        ms: runtimeIdleMs,
        pollMs: resolveRuntimeWaitPollMs(adapter),
      });
    }

    const broadcastWindowReady = await waitForEntityBroadcastWindow(env, adapter, hubEntityId, 10000);
    if (!broadcastWindowReady) {
      return new Response(
        JSON.stringify({
          error: 'Hub sentBatch did not clear in time',
          requestId,
        }),
        { status: 504, headers },
      );
    }

    enqueueBatchBroadcast();
    const broadcastIdleStartedAt = Date.now();
    const broadcastIdle = await waitForRuntimeIdle(env, adapter, 5000);
    const broadcastIdleMs = Date.now() - broadcastIdleStartedAt;
    if (!broadcastIdle) {
      faucetLog.warn('reserve.broadcast_idle_timeout', {
        requestId,
        ms: broadcastIdleMs,
        pollMs: resolveRuntimeWaitPollMs(adapter),
      });
    }

    const jBatchCleared = await waitForJBatchClear(env, adapter, 10000);
    if (!jBatchCleared) {
      return new Response(
        JSON.stringify({
          error: 'J-batch did not broadcast in time',
          requestId,
        }),
        { status: 504, headers },
      );
    }

    const expectedMin = prevUserReserve + amountWei;
    const updatedReserve = await waitForReserveUpdate(adapter, userEntityId, tokenId, expectedMin, 10000);
    if (updatedReserve === null) {
      return new Response(
        JSON.stringify({
          error: 'Reserve update not confirmed on-chain',
          requestId,
        }),
        { status: 504, headers },
      );
    }
    const totalMs = Date.now() - requestStartedAt;
    faucetLog.info('reserve.accepted', {
      requestId,
      totalMs: formatTimingMs(totalMs),
      updatedReserve: updatedReserve.toString(),
    });

    return new Response(
      JSON.stringify({
        success: true,
        type: 'reserve',
        amount,
        tokenId,
        from: hubEntityId.slice(0, 16) + '...',
        to: userEntityId.slice(0, 16) + '...',
        requestId,
      }),
      { headers },
    );
  } catch (error: unknown) {
    faucetLog.error('reserve.error', { error: getErrorMessage(error) });
    return new Response(safeStringify({ error: getErrorMessage(error) }), { status: 500, headers });
  } finally {
    faucetLock.release();
  }
};
