import { haltRuntimeRequiresOperator } from '../../runtime/replica/lifecycle';
import type { RuntimeReplica } from '../../runtime/types';
import { rejectFailFast } from '../../support/process/runtime-process';
import { createStructuredLogger } from '../../support/logger';
import { safeStringify } from '../../protocol/serialization';

const rejectLog = createStructuredLogger('network.reject');

/**
 * Owner canon (AGENTS.md "REJECT POLICY"): a peer can never take a Runtime
 * down. Transport-level peer misbehaviour closes that peer's session and
 * never halts the Hub in production. The fail-fast switch is consulted
 * exactly once, here at the transport boundary: tests/dev halt so a hostile
 * or buggy peer surfaces loudly, production logs the `[reject]` audit line
 * and closes the offending session. Callers must not add a second policy
 * decision deeper in the stack.
 */
export const applyTransportPeerFailurePolicy = (
  env: RuntimeReplica,
  code: string,
  failure: Record<string, unknown>,
  closeSession: () => void,
): void => {
  env.error?.('network', code, failure);
  if (rejectFailFast()) {
    haltRuntimeRequiresOperator(env, new Error(`${code}:${safeStringify(failure)}`));
    return;
  }
  rejectLog.error('transport_peer_failure.dropped', { code, disposition: 'session-closed', ...failure });
  closeSession();
};
