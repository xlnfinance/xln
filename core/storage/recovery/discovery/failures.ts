import { normalizeRuntimeFailureCode } from '../../../protocol/errors/failure-taxonomy';
import type {
  RuntimeRecoveryCandidateSource,
  RuntimeRecoveryDiscoveryFailure,
  RuntimeRecoveryFailureCategory,
} from './types';

/**
 * A failed source is not automatically a problem.
 *
 * "No backup here" is the normal answer from a tower that was never appointed,
 * an unreachable peer is a race the person can retry, and only a bundle that
 * contradicts this Runtime id is real evidence of a wrong seed or a hostile
 * source. Collapsing the three into one error string is what made the old
 * restore screen shout at people with nothing wrong.
 */

const EXPECTED_EMPTY_CODES: ReadonlySet<string> = new Set([
  'TOWER_BUNDLE_NOT_FOUND',
  'PEER_RECOVERY_BUNDLE_EMPTY',
  'RECOVERY_CANDIDATE_EMPTY',
  'HTTP_404',
]);

// Transport failures are coded where the request is made (tower fetch, peer
// socket). The rest of a message carries tower- or peer-supplied text, so
// classification reads the leading code only: a hostile source cannot turn a
// contradiction into a retry by echoing "network" or "timeout".
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'HTTP_408',
  'HTTP_409',
  'HTTP_425',
  'HTTP_429',
  'RECOVERY_TOWER_UNREACHABLE',
  'RECOVERY_REQUEST_SEND_FAILED',
  'RECOVERY_REQUEST_SOCKET_CLOSED',
  'RECOVERY_REQUEST_TIMEOUT',
  'RUNTIME_WS_RECOVERY_CONNECT_TIMEOUT',
  'REMOTE_RUNTIME_CONNECT_FAILED',
]);

const categorizeRecoveryFailure = (code: string): RuntimeRecoveryFailureCategory => {
  if (EXPECTED_EMPTY_CODES.has(code)) return 'ExpectedEmpty';
  if (code.startsWith('HTTP_5') || TRANSIENT_CODES.has(code)) return 'TransientRace';
  return 'Contradiction';
};

export const classifyRuntimeRecoveryDiscoveryFailure = (input: {
  source: Exclude<RuntimeRecoveryCandidateSource, 'file'>;
  sourceLabel: string;
  message: string;
}): RuntimeRecoveryDiscoveryFailure => {
  const message = String(input.message || 'unknown').trim() || 'unknown';
  const code = normalizeRuntimeFailureCode(message);
  return {
    source: input.source,
    sourceLabel: String(input.sourceLabel || input.source).trim() || input.source,
    category: categorizeRecoveryFailure(code),
    code,
    message,
  };
};

export const recoveryFailureErrorText = (failure: RuntimeRecoveryDiscoveryFailure): string =>
  `${failure.sourceLabel}:${failure.message}`;
