import type { RuntimeActivityFilters } from '../../../storage/views/activity-types';
import type { RuntimeReplica } from '../../../runtime/types';
import { RuntimeAdapterError } from '../errors';
import { resolveRuntimeAdapterRead } from '../resolve';
import type { RuntimeAdapterReadQuery } from '../types';
import {
  compactReadQueryForLog,
  requireAuth,
  requireBucket,
  runtimeAdapterLog,
  sendOk,
  type AdapterClientState,
  type RuntimeAdapterDiagnostic,
  type RuntimeAdapterRequestByOp,
  type RuntimeAdapterServerDeps,
  type RuntimeAdapterSocket,
} from './context';

// The `read` op: binds the host's storage readers to one Runtime and resolves
// the path, logging reads that stay pending or finish slowly.

const RUNTIME_ADAPTER_PENDING_READ_LOG_MS = 1_000;

const buildRuntimeAdapterReadContext = (
  env: RuntimeReplica,
  deps: RuntimeAdapterServerDeps,
) => ({
  env,
  ...(deps.readHead
    ? { readHead: () => deps.readHead?.(env) ?? Promise.resolve(null) }
    : {}),
  ...(deps.readFrame
    ? {
        readFrame: (height: number) =>
          deps.readFrame?.(env, height) ?? Promise.resolve(null),
      }
    : {}),
  ...(deps.listCheckpoints
    ? {
        listCheckpoints: () =>
          deps.listCheckpoints?.(env) ?? Promise.resolve([]),
      }
    : {}),
  ...(deps.loadEntityState
    ? {
        loadEntityState: (entityId: string, height: number) =>
          deps.loadEntityState?.(env, entityId, height) ??
          Promise.resolve(null),
      }
    : {}),
  ...(deps.loadEntityAccountDoc
    ? {
        loadEntityAccountDoc: (
          entityId: string,
          counterpartyId: string,
          height: number,
        ) =>
          deps.loadEntityAccountDoc?.(
            env,
            entityId,
            counterpartyId,
            height,
          ) ?? Promise.resolve(null),
      }
    : {}),
  ...(deps.loadEntityViewPage
    ? {
        loadEntityViewPage: (
          entityId: string,
          height: number,
          query?: RuntimeAdapterReadQuery,
        ) =>
          deps.loadEntityViewPage?.(env, entityId, height, query) ??
          Promise.resolve(null),
      }
    : {}),
  ...(deps.listEntityIdsAtHeight
    ? {
        listEntityIdsAtHeight: (height: number) =>
          deps.listEntityIdsAtHeight?.(env, height) ?? Promise.resolve([]),
      }
    : {}),
  ...(deps.readActivityPage
    ? {
        readActivityPage: (
          opts: RuntimeActivityFilters & {
            beforeHeight?: number | undefined;
            limit?: number | undefined;
            scanLimit?: number | undefined;
          },
        ) =>
          deps.readActivityPage?.(env, opts) ??
          Promise.reject(
            new RuntimeAdapterError(
              'E_INTERNAL',
              'activity reader did not return',
            ),
          ),
      }
    : {}),
  ...(deps.readAccountSwapHistoryPage
    ? {
        readAccountSwapHistoryPage: (
          entityId: string,
          counterpartyId: string,
          options: Readonly<{ limit?: number; cursor?: Readonly<{ height: number; offerId: string }> }>,
        ) => deps.readAccountSwapHistoryPage?.(env, entityId, counterpartyId, options)
          ?? Promise.reject(new RuntimeAdapterError('E_INTERNAL', 'account swap-history reader did not return')),
      }
    : {}),
  ...(deps.readAccountFrameHistory
    ? {
        readAccountFrameHistory: (entityId: string, counterpartyId: string, limit: number) =>
          deps.readAccountFrameHistory?.(env, entityId, counterpartyId, limit)
          ?? Promise.reject(new RuntimeAdapterError('E_INTERNAL', 'account frame reader did not return')),
      }
    : {}),
  ...(deps.readFrameReceipts
    ? {
        readFrameReceipts: (query?: RuntimeAdapterReadQuery) =>
          deps.readFrameReceipts?.(env, query) ??
          Promise.reject(
            new RuntimeAdapterError(
              'E_INTERNAL',
              'frame receipt reader did not return',
            ),
          ),
      }
    : {}),
  ...(deps.findPaymentRoutes
    ? {
        findPaymentRoutes: (query?: RuntimeAdapterReadQuery) =>
          deps.findPaymentRoutes?.(env, query) ??
          Promise.reject(
            new RuntimeAdapterError(
              'E_INTERNAL',
              'payment route reader did not return',
            ),
          ),
      }
    : {}),
});

export const handleRuntimeAdapterRead = async (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'read'>,
  env: RuntimeReplica,
  state: AdapterClientState,
  deps: RuntimeAdapterServerDeps,
  diagnostic: RuntimeAdapterDiagnostic,
): Promise<void> => {
  requireAuth(state, 'inspect');
  requireBucket(state.readBucket, 'read');
  const startedAt = Date.now();
  const readDiagnostic = {
    path: msg.path,
    query: compactReadQueryForLog(msg.query),
    runtimeId: String(env.runtimeId || '') || null,
    height: Math.max(0, Math.floor(Number(env.state.height ?? 0))),
  };
  const pendingTimer = setTimeout(() => {
    runtimeAdapterLog.warn('read.pending', {
      ...readDiagnostic,
      elapsedMs: Date.now() - startedAt,
    });
  }, RUNTIME_ADAPTER_PENDING_READ_LOG_MS);
  try {
    const payload = await resolveRuntimeAdapterRead(
      buildRuntimeAdapterReadContext(env, deps),
      msg.path,
      msg.query,
    );
    const resolvedAt = Date.now();
    sendOk(ws, msg.id, payload, diagnostic());
    const completedAt = Date.now();
    if (completedAt - startedAt >= RUNTIME_ADAPTER_PENDING_READ_LOG_MS) {
      runtimeAdapterLog.warn('read.slow', {
        ...readDiagnostic,
        resolveMs: resolvedAt - startedAt,
        encodeSendMs: completedAt - resolvedAt,
        totalMs: completedAt - startedAt,
      });
    }
  } finally {
    clearTimeout(pendingTimer);
  }
};
