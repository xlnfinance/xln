import { createHash } from 'node:crypto';

export const MAX_IDENTICAL_CHILD_FAILURES = 3;

export type ChildFailureObservation = {
  role: 'hub' | 'market-maker';
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
  const codes = clean.match(/\b(?:[A-Z][A-Z0-9]*_)+[A-Z0-9]+\b/g);
  if (codes?.length) return codes.at(-1)!;
  return clean.slice(-512) || 'UNREPORTED_CHILD_FAILURE';
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
  return {
    action: count >= MAX_IDENTICAL_CHILD_FAILURES ? 'fail-stop' : 'recover',
    backoffMs: Math.min(10_000, count * 2_000),
    count,
    fingerprint,
    reasonCode,
    counts: nextCounts,
  };
};
