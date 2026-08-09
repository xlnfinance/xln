import { createHash } from 'node:crypto';

export const MAX_IDENTICAL_CHILD_FAILURES = 3;

export type ChildFailureObservation = {
  role: 'hub' | 'market-maker' | 'orchestrator';
  name: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: string;
};

export type ChildFailureDecision = {
  action: 'recover' | 'fail-stop';
  backoffMs: number;
  count: number;
  fingerprint: string;
  reasonCode: string;
  counts: Record<string, number>;
};

const stableReasonCode = (reason: string): string => {
  const clean = reason.replaceAll(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim();
  if (/Unexpected end of JSON input/i.test(clean)) return 'RPC_RESPONSE_JSON_TRUNCATED';
  const codes = clean.match(/\b(?:[A-Z][A-Z0-9]*_)+[A-Z0-9]+\b/g);
  // Parent failures include full nested health JSON for diagnosis. The first
  // stable code is the thrown top-level cause; later codes describe children
  // and must never reclassify the receipt or its fail-stop policy.
  if (codes?.length) return codes[0]!;
  return clean.slice(-512) || 'UNREPORTED_CHILD_FAILURE';
};

export const isTerminalBootstrapFailureReasonCode = (reasonCode: string): boolean =>
  /(?:BOOTSTRAP_STALLED|WATCHER_DRAIN_STALLED)$/.test(reasonCode);

export const isRuntimeLoopFatalReason = (reason: string): boolean =>
  /\[ERROR\]\[runtime\]\s+loop\.error\b/.test(reason) ||
  /\bRUNTIME_LOOP_(?:ERROR|HALTED)\b/.test(reason);

export const shouldCaptureUnexpectedChildExit = (
  controlledStop: boolean,
  orchestratorShuttingDown: boolean,
  isCurrentProcess: boolean,
): boolean => isCurrentProcess && !controlledStop && !orchestratorShuttingDown;

export const selectChildFailureReason = (
  recentStderr: readonly string[],
  recentStdout: readonly string[],
  fallback: string,
): string => {
  const hasStableCode = (line: string): boolean => /\b(?:[A-Z][A-Z0-9]*_)+[A-Z0-9]+\b/.test(line);
  const hasCriticalMessage = (line: string): boolean =>
    /fatal watcher error|Unexpected end of JSON input|SyntaxError|ECONNRESET|ETIMEDOUT/i.test(line);
  // Bootstrap WARN/INFO tails (e.g. mesh.direct_peers.grace_expired) are not
  // crash evidence. Preferring them after SIGKILL misclassifies the incident as
  // `_WARN__MESH_HUB_` instead of `${name}_UNEXPECTED_EXIT`.
  const isNoise = (line: string): boolean => /^\[(?:WARN|INFO|DEBUG)\]/i.test(line.trim());
  const isMeaningful = (line: string): boolean =>
    !isNoise(line) && (hasStableCode(line) || hasCriticalMessage(line));
  const lastNonNoise = (lines: readonly string[]): string | undefined =>
    [...lines].reverse().find(line => line.trim().length > 0 && !isNoise(line));
  return [...recentStderr].reverse().find(isMeaningful)
    ?? [...recentStdout].reverse().find(isMeaningful)
    ?? lastNonNoise(recentStderr)
    ?? lastNonNoise(recentStdout)
    ?? fallback;
};

export const decideChildFailure = (
  counts: Readonly<Record<string, number>>,
  observation: ChildFailureObservation,
): ChildFailureDecision => {
  const reasonCode = stableReasonCode(observation.reason);
  const identity = [
    observation.role,
    observation.name,
    `code=${String(observation.code)}`,
    `signal=${String(observation.signal)}`,
    `reason=${reasonCode}`,
  ].join(':');
  const fingerprint = createHash('sha256').update(identity).digest('hex');
  const count = (counts[fingerprint] ?? 0) + 1;
  const nextCounts = { ...counts, [fingerprint]: count };
  const terminalBootstrapFailure = isTerminalBootstrapFailureReasonCode(reasonCode);
  const runtimeLoopFatal = isRuntimeLoopFatalReason(observation.reason);
  return {
    // A Runtime fatal must exit the broken child, but the first occurrence is
    // not evidence that the durable checkpoint is poisoned. Recover it
    // immediately; only an identical crash loop exhausts the bounded budget.
    action: terminalBootstrapFailure || count >= MAX_IDENTICAL_CHILD_FAILURES
      ? 'fail-stop'
      : 'recover',
    backoffMs: terminalBootstrapFailure || runtimeLoopFatal ? 0 : Math.min(10_000, count * 2_000),
    count,
    fingerprint,
    reasonCode,
    counts: nextCounts,
  };
};
