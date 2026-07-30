import type { LogCategory } from '../types/logging';

export type ScopedEventSink = {
  info(category: LogCategory, message: string, data?: unknown, entityId?: string): void;
};

/**
 * Emit operational frame logs without retaining them in consensus State.
 *
 * This helper accepts only the logging port it needs. Entity code must not
 * import or mutate a RuntimeReplica merely to produce diagnostics.
 */
export const emitScopedEvents = (
  sink: ScopedEventSink,
  category: LogCategory,
  scope: string,
  messages: readonly string[],
  data: Record<string, unknown> = {},
  entityId?: string,
): void => {
  if (messages.length === 0) return;

  const payload = { path: scope, ...data };
  for (const message of messages) {
    sink.info(category, message, payload, entityId);
  }
};
