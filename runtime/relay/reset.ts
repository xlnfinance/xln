import { createStructuredLogger } from '../infra/logger';
import type { RelayStore } from './store';

type RelayResetLogger = {
  warn(event: string, details: Record<string, unknown>): void;
};

const relayResetLog = createStructuredLogger('relay.reset');
const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const closeRelayClientsForReset = (
  store: RelayStore,
  log: RelayResetLogger = relayResetLog,
): void => {
  const failures: Array<{ runtimeId: string; error: string }> = [];
  for (const [runtimeId, client] of store.clients) {
    try {
      if (!client.ws.close) throw new Error('RELAY_SOCKET_CLOSE_UNAVAILABLE');
      client.ws.close(4000, 'mesh-reset');
      store.clients.delete(runtimeId);
      continue;
    } catch (closeError) {
      log.warn('client.graceful_close_failed', {
        runtimeId,
        error: formatError(closeError),
      });
    }

    try {
      if (!client.ws.terminate) throw new Error('RELAY_SOCKET_TERMINATE_UNAVAILABLE');
      client.ws.terminate();
      store.clients.delete(runtimeId);
      log.warn('client.force_terminated', { runtimeId });
    } catch (terminateError) {
      const error = formatError(terminateError);
      log.warn('client.force_terminate_failed', { runtimeId, error });
      failures.push({ runtimeId, error });
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `RELAY_RESET_CLIENT_CLOSE_FAILED:${failures.map(({ runtimeId }) => runtimeId).join(',')}`,
    );
  }
};
