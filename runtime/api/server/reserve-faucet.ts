import type { RuntimeInput, RuntimeReplica } from '../../runtime/types';
import type { JAdapter } from '../../jurisdiction/adapter';
import { safeStringify } from '../../protocol/serialization';
import { createStructuredLogger } from '../../infra/logger';
import { getErrorMessage } from './utils';
import { faucetFailureBody } from './faucet-failure';
import {
  reserveFaucetLock,
} from './reserve-faucet-waits';
import {
  runReserveFaucetRequest,
} from './reserve-faucet-request';
import type { TokenCatalogEntry } from './reserve-faucet-evidence';

export {
  findReserveUpdatedEvidence,
  parseReserveFaucetAmount,
  waitForReserveUpdatedEvidence,
} from './reserve-faucet-evidence';

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

export const handleReserveFaucet = async (input: ReserveFaucetInput): Promise<Response> => {
  await reserveFaucetLock.acquire();
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
    reserveFaucetLock.release();
  }
};
