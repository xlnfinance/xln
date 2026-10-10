import type { RuntimeInput, RuntimeReplica } from '../../../runtime/types';
import type { JAdapter } from '../../../jurisdiction/adapter';
import { safeStringify } from '../../../protocol/serialization';
import { createStructuredLogger } from '../../../support/logger';
import { getErrorMessage } from '../utils';
import { faucetFailureBody } from './failure';
import { BoundedLockBusyError } from '../../../support/bounded-lock';
import {
  reserveFaucetLock,
} from './reserve-waits';
import {
  runReserveFaucetRequest,
} from './reserve-request';
import type { TokenCatalogEntry } from './reserve-evidence';

export {
  parseReserveFaucetAmount,
} from './reserve-evidence';

const faucetLog = createStructuredLogger('server.faucet');

export type ReserveFaucetInput = {
  req: Request;
  env: RuntimeReplica | null;
  headers: HeadersInit;
  relayStore: { activeHubEntityIds: string[] };
  getJAdapter: () => JAdapter | null;
  ensureTokenCatalog: () => Promise<TokenCatalogEntry[]>;
  validateRuntimeInputAdmission: (env: RuntimeReplica, runtimeInput: RuntimeInput) => void;
  enqueueRuntimeInput: (env: RuntimeReplica, runtimeInput: RuntimeInput) => void;
};

const unavailable = (
  headers: HeadersInit,
  code: string,
  error: string,
): Response => new Response(
  safeStringify(faucetFailureBody({ code, error })),
  { status: 503, headers },
);

const acquireReserveFaucet = async (headers: HeadersInit): Promise<(() => void) | Response> => {
  try {
    return await reserveFaucetLock.acquire();
  } catch (error) {
    if (!(error instanceof BoundedLockBusyError)) throw error;
    faucetLog.warn('reserve.busy', { reason: error.code });
    return new Response(safeStringify(faucetFailureBody({
      code: 'FAUCET_BUSY',
      error: 'Reserve faucet is busy; retry later',
      extra: { reason: error.code },
    })), { status: error.code === 'LOCK_QUEUE_FULL' ? 429 : 503, headers });
  }
};

export const handleReserveFaucet = async (input: ReserveFaucetInput): Promise<Response> => {
  const release = await acquireReserveFaucet(input.headers);
  if (release instanceof Response) return release;
  try {
    const adapter = input.getJAdapter();
    if (!adapter) {
      return unavailable(input.headers, 'FAUCET_J_ADAPTER_NOT_INITIALIZED', 'J-adapter not initialized');
    }
    if (!input.env) {
      return unavailable(input.headers, 'FAUCET_RUNTIME_NOT_INITIALIZED', 'Runtime not initialized');
    }
    return await runReserveFaucetRequest({
      req: input.req,
      env: input.env,
      adapter,
      headers: input.headers,
      activeHubEntityIds: input.relayStore.activeHubEntityIds,
      ensureTokenCatalog: input.ensureTokenCatalog,
      validateRuntimeInputAdmission: input.validateRuntimeInputAdmission,
      enqueueRuntimeInput: input.enqueueRuntimeInput,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    faucetLog.error('reserve.error', { error: message });
    return new Response(safeStringify(faucetFailureBody({
      code: 'FAUCET_RESERVE_UNHANDLED_ERROR',
      error: message,
    })), { status: 500, headers: input.headers });
  } finally {
    release();
  }
};
