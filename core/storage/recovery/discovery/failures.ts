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

const normalizeRecoveryFailureCode = (message: string): string => {
  const code = message.trim().split(/[\s:]/)[0] || 'UNKNOWN';
  return code.replace(/[^A-Z0-9_]/gi, '_').toUpperCase();
};

const EXPECTED_EMPTY_CODES: ReadonlySet<string> = new Set([
  'TOWER_BUNDLE_NOT_FOUND',
  'PEER_RECOVERY_BUNDLE_EMPTY',
  'RECOVERY_CANDIDATE_EMPTY',
  'HTTP_404',
]);

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'HTTP_408',
  'HTTP_409',
  'HTTP_425',
  'HTTP_429',
  'RECOVERY_REQUEST_SEND_FAILED',
  'RECOVERY_REQUEST_SOCKET_CLOSED',
]);

const TRANSIENT_TEXT = ['timeout', 'offline', 'connect', 'network', 'fetch'] as const;

const categorizeRecoveryFailure = (code: string, message: string): RuntimeRecoveryFailureCategory => {
  if (EXPECTED_EMPTY_CODES.has(code)) return 'ExpectedEmpty';
  const lower = message.toLowerCase();
  // WebKit reports a rejected fetch as TypeError("Load failed"). This is
  // transport failure, not evidence contradicting the wallet or its backup.
  if (lower === 'load failed') return 'TransientRace';
  if (code.startsWith('HTTP_5') || TRANSIENT_CODES.has(code)) return 'TransientRace';
  return TRANSIENT_TEXT.some(fragment => lower.includes(fragment)) ? 'TransientRace' : 'Contradiction';
};

export const classifyRuntimeRecoveryDiscoveryFailure = (input: {
  source: Exclude<RuntimeRecoveryCandidateSource, 'file'>;
  sourceLabel: string;
  message: string;
}): RuntimeRecoveryDiscoveryFailure => {
  const message = String(input.message || 'unknown').trim() || 'unknown';
  const code = normalizeRecoveryFailureCode(message);
  return {
    source: input.source,
    sourceLabel: String(input.sourceLabel || input.source).trim() || input.source,
    category: categorizeRecoveryFailure(code, message),
    code,
    message,
  };
};

export const recoveryFailureErrorText = (failure: RuntimeRecoveryDiscoveryFailure): string =>
  `${failure.sourceLabel}:${failure.message}`;
