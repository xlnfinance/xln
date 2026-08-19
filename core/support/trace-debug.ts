/**
 * TEMPORARY diagnostic helper for the H2<->MM pending-frame-stale investigation
 * (2026-08-19). Gated entirely behind env vars so it is a no-op cost in normal
 * operation and safe to leave compiled in across multiple repro attempts.
 *
 * - XLN_TRACE_ENTITY_SUFFIXES: comma-separated id suffixes (case-insensitive).
 *   When set, checkpoints log only for entity/runtime ids ending in one of them.
 * - XLN_TRACE_ALL_DEFERRED: when '1', the route-defer checkpoint
 *   (core/runtime/delivery/pending.ts:reportRetryableRouteDefer) logs every
 *   deferred output unconditionally, regardless of XLN_TRACE_ENTITY_SUFFIXES.
 *   Deferrals are the rare/retry path, not steady-state traffic, so this is
 *   cheap even at 500-user scale.
 *
 * Remove this file and its call sites once the pending-frame-stale root cause
 * is confirmed and fixed, unless the owner decides to keep it as permanent
 * instrumentation.
 */

const parsedSuffixes = (): string[] => {
  const raw = typeof process !== 'undefined' ? process.env?.['XLN_TRACE_ENTITY_SUFFIXES'] : undefined;
  if (!raw) return [];
  return raw
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
};

// Cache the parsed list once; env vars don't change mid-process.
const TRACE_SUFFIXES = parsedSuffixes();

export const traceSuffixesEnabled = (): boolean => TRACE_SUFFIXES.length > 0;

export const matchesTraceSuffix = (...ids: Array<string | null | undefined>): boolean => {
  if (TRACE_SUFFIXES.length === 0) return false;
  return ids.some(id => {
    if (!id) return false;
    const lower = id.toLowerCase();
    return TRACE_SUFFIXES.some(suffix => lower.endsWith(suffix));
  });
};

export const traceAllDeferredEnabled = (): boolean =>
  typeof process !== 'undefined' && process.env?.['XLN_TRACE_ALL_DEFERRED'] === '1';

export const traceLog = (tag: string, data: Record<string, unknown>): void => {
  // Intentionally bypasses the structured logger's level gating: this must be
  // visible in server.log regardless of the ambient log level configuration.
  console.error(`[TRACE:${tag}]`, data);
};
