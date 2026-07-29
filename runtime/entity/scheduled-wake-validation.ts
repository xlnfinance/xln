import { compareStableText, safeStringify } from '../protocol/serialization';
import type { EntityState } from './types';
import type { EntityTx } from '../types/entity-tx';
import { getEntityLeaderState } from './consensus/leader';

export type ScheduledWakeTx = Extract<EntityTx, { type: 'scheduledWake' }>;
export type ScheduledWakeJob = ScheduledWakeTx['data']['jobs'][number];
export const MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS = 1_000;

/**
 * Scheduled wakes enter through Runtime, but Entity consensus must validate
 * their signed payload from EntityState alone. Keeping this check in Entity
 * prevents the inner machine from depending on its Runtime orchestrator.
 */
export const assertScheduledWakeMatchesState = (
  state: EntityState,
  tx: ScheduledWakeTx,
): void => {
  const proposerSignerId = getEntityLeaderState(state).activeValidatorId;
  if (!proposerSignerId || proposerSignerId.toLowerCase() !== tx.data.proposerSignerId.toLowerCase()) {
    throw new Error('SCHEDULED_WAKE_PROPOSER_MISMATCH');
  }
  if (
    tx.data.version !== 1 ||
    !Number.isSafeInteger(tx.data.dueAt) ||
    tx.data.dueAt < 0 ||
    tx.data.dueAt > state.timestamp ||
    !Array.isArray(tx.data.jobs) ||
    tx.data.jobs.length === 0 ||
    tx.data.jobs.length > MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS
  ) {
    throw new Error('SCHEDULED_WAKE_INVALID_PAYLOAD');
  }
  const actual = [...tx.data.jobs].sort((left, right) =>
    left.dueAt - right.dueAt ||
    compareStableText(left.kind, right.kind) ||
    compareStableText(left.id, right.id));
  const actualKeys = actual.map(job => safeStringify(job));
  const actualIsCanonical = safeStringify(actual) === safeStringify(tx.data.jobs);
  const actualIsUnique = new Set(actualKeys).size === actualKeys.length;
  const actualIsStructurallyValid = actual.every(job =>
    (job.kind === 'hook' || job.kind === 'task') &&
    typeof job.id === 'string' &&
    job.id.length > 0 &&
    job.id.length <= 256 &&
    Number.isSafeInteger(job.dueAt) &&
    job.dueAt >= 0 &&
    job.dueAt <= state.timestamp);
  if (
    actual[0]!.dueAt !== tx.data.dueAt ||
    !actualIsCanonical ||
    !actualIsUnique ||
    !actualIsStructurallyValid
  ) {
    throw new Error(`SCHEDULED_WAKE_INVALID_PAYLOAD: jobs=${safeStringify(tx.data.jobs)}`);
  }
};

/**
 * A wake is frame metadata, not an ordinary user command. It must be the
 * unique first transaction so every validator runs scheduled work against the
 * same pre-command EntityState.
 */
export const assertScheduledWakeFrameOrder = (entityTxs: readonly EntityTx[]): void => {
  const wakeIndexes = entityTxs.flatMap((tx, index) => tx.type === 'scheduledWake' ? [index] : []);
  if (wakeIndexes.length === 0) return;
  if (wakeIndexes.length !== 1 || wakeIndexes[0] !== 0) {
    throw new Error(`SCHEDULED_WAKE_FRAME_ORDER_INVALID: indexes=${wakeIndexes.join(',')}`);
  }
};
