import { safeStringify } from '../protocol/serialization';
import { requiresLocalNodeOperator } from '../api/server/node-http-access';
import { getStorageHealth } from '../infra/storage-monitor';
import { resolveRuntimeImportReadiness } from './runtime-import-readiness';
import type { AggregatedHealth } from './orchestrator-types';

const unavailableRuntimeImportManifest = {
  issuedAt: 0,
  expiresAt: 0,
  entries: [],
};

export type RuntimeImportHttpDeps = {
  refreshChildHealthForResponse: () => Promise<void>;
  buildAggregatedHealthResponse: () => Promise<AggregatedHealth>;
  buildRuntimeImportManifest: () => unknown;
  buildRuntimeImportUrl: () => string;
};

export const handleRuntimeImportHttpRequest = async (
  request: Request,
  url: URL,
  operatorAuthorized: boolean,
  headers: Record<string, string>,
  deps: RuntimeImportHttpDeps,
): Promise<Response | null> => {
  if (url.pathname !== '/api/runtime-import' || request.method !== 'GET') {
    return null;
  }
  if (requiresLocalNodeOperator(url) && !operatorAuthorized) {
    return new Response(
      safeStringify({ error: 'Operator access required' }),
      { status: 403, headers },
    );
  }
  await getStorageHealth();
  await deps.refreshChildHealthForResponse();
  const readiness = resolveRuntimeImportReadiness(
    await deps.buildAggregatedHealthResponse(),
  );
  if (!readiness.ok) {
    const allowPartial =
      url.searchParams.get('allowPartial') === '1' && operatorAuthorized;
    const partialManifest = allowPartial
      ? deps.buildRuntimeImportManifest()
      : null;
    if (partialManifest) {
      return new Response(
        safeStringify({
          ok: true,
          ready: false,
          partial: true,
          error: readiness.error,
          reason: readiness.reason,
          category: readiness.category,
          code: readiness.code,
          retryable: readiness.retryable,
          fatal: readiness.fatal,
          failure: readiness.failure,
          degraded: readiness.degraded,
          importUrl: deps.buildRuntimeImportUrl(),
          manifest: partialManifest,
        }),
        { headers: { ...headers, 'Retry-After': '2' } },
      );
    }
    return new Response(
      safeStringify({
        ok: false,
        ready: false,
        error: readiness.error,
        reason: readiness.reason,
        category: readiness.category,
        code: readiness.code,
        retryable: readiness.retryable,
        fatal: readiness.fatal,
        failure: readiness.failure,
        degraded: readiness.degraded,
        manifest: unavailableRuntimeImportManifest,
      }),
      { headers: { ...headers, 'Retry-After': '2' } },
    );
  }
  const manifest = deps.buildRuntimeImportManifest();
  return manifest
    ? new Response(
        safeStringify({
          ok: true,
          ready: true,
          importUrl: deps.buildRuntimeImportUrl(),
          manifest,
        }),
        { headers },
      )
    : new Response(
        safeStringify({
          ok: false,
          ready: false,
          error: 'RUNTIME_IMPORT_NOT_READY',
          manifest: unavailableRuntimeImportManifest,
        }),
        { headers: { ...headers, 'Retry-After': '2' } },
      );
};
