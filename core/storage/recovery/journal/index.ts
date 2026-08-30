import { nodeProcess } from '../../../support/process/runtime-process';
import { requireBoundaryInteger } from '../../../protocol/boundary-validation';
import {
  deleteRuntimeMetadata,
  readRuntimeMetadata,
  writeRuntimeMetadata,
} from '../../../runtime/loop/loop-environment.ts';
import {
  clearPendingAuditEvents,
  clearRuntimeFrameEvents,
  readRuntimeFrameEvents,
} from '../../../runtime/observability/env-events';
import { recordCommittedRuntimeEntityMetrics } from '../../../runtime/observability/entity-metrics';
import {
  registerPendingCommittedJOutbox,
  splitJOutboxForDurableSubmit,
} from '../../../runtime/j-submit/j-submit-state';
import { refreshScheduledWakeIndex } from '../../../runtime/mempool/scheduled-wake';
import {
  clearReplayOutputSignerHints,
  installReplayOutputSignerHints,
} from '../../../runtime/delivery/entity-output-signer';
import {
  clearReplayOutputRuntimeRoutes,
  installReplayOutputRuntimeRoutes,
} from '../../../runtime/delivery/replay-output-route';
import type {
  RuntimeInput,
  RuntimeReplica,
  RoutedEntityInput,
} from '../../../runtime/types';
import type { RuntimeInputApplyResult } from '../../../runtime/frame/apply';
import type { RuntimeOutputRoutingDeps } from '../../../runtime/delivery/topology/output-routing';
import type { PersistedFrameJournal } from '../../types';
import {
} from '../../wal/snapshot';
import { createStructuredLogger } from '../../../support/logger';
import {
  assertRecoveryOutboxMatches,
  verifyRecoveryJournalFrame,
} from './verification';
import { assertCrossJLocalCohorts } from '../../../runtime/delivery/topology/cross-j-topology';
import { timePerfPhase } from '../../../support/performance/profile';
import {
  failStopAuthorityFrame,
  finalizeAuthorityFrameAfterWal,
  assertAuthorityFrameSettled,
} from '../../../rscore/authority-driver';

const APPLY_ALLOWED = Symbol.for('xln.runtime.env.apply.allowed');
const REPLAY_MODE = Symbol.for('xln.runtime.env.replay.mode');
const runtimeLog = createStructuredLogger('runtime');

export type RecoveryJournalDeps = {
  ensureRuntimeConfig(
    env: RuntimeReplica,
  ): NonNullable<RuntimeReplica['runtimeConfig']>;
  applyRuntimeInput(
    env: RuntimeReplica,
    input: RuntimeInput,
  ): Promise<RuntimeInputApplyResult>;
  applyRuntimeOutputPlan(
    env: RuntimeReplica,
    outputs: readonly RoutedEntityInput[],
    routing: RuntimeOutputRoutingDeps,
  ): unknown;
  getRuntimeOutputRoutingDeps(): RuntimeOutputRoutingDeps;
};

const validateReplayFrameHeader = (
  frame: PersistedFrameJournal,
  expectedHeight: number,
): number => {
  const height = requireBoundaryInteger(
    frame.height,
    'RECOVERY_JOURNAL_HEIGHT_INVALID',
  );
  if (height !== expectedHeight) {
    throw new Error(
      `RECOVERY_JOURNAL_REPLAY_GAP: expected=${expectedHeight} actual=${height}`,
    );
  }
  if (!/^0x[0-9a-f]{64}$/i.test(String(frame.replicaMetaDigest ?? ''))) {
    throw new Error(
      `RECOVERY_JOURNAL_REPLICA_META_DIGEST_MISSING:height=${height}`,
    );
  }
  if (!/^0x[0-9a-f]{64}$/i.test(String(frame.postStateHash ?? ''))) {
    throw new Error(
      `RECOVERY_JOURNAL_POST_STATE_HASH_MISSING:height=${height}`,
    );
  }
  return height;
};

const collectOutputSignerHints = (
  frame: PersistedFrameJournal,
  height: number,
): Map<string, string> => {
  const hints = new Map<string, string>();
  for (const output of frame.runtimeOutputs ?? []) {
    // Account delivery has one persisted shape: a raw atomic AccountInput.
    // Account delivery has no generic wrapper or recovery alias.
    const carriesAccountInput = (output.entityTxs ?? []).some(tx => tx.type === 'accountInput');
    if (!carriesAccountInput) continue;
    const entityId = String(output.entityId || '').trim().toLowerCase();
    const signerId = String(output.signerId || '').trim().toLowerCase();
    if (!entityId || !signerId) {
      throw new Error(`RECOVERY_OUTPUT_SIGNER_HINT_INVALID:height=${height}`);
    }
    const existing = hints.get(entityId);
    if (existing && existing !== signerId) {
      throw new Error(
        `RECOVERY_OUTPUT_SIGNER_HINT_CONFLICT:height=${height}:` +
        `entity=${entityId}:left=${existing}:right=${signerId}`,
      );
    }
    hints.set(entityId, signerId);
  }
  return hints;
};

export type RecoveryReplayOptions = Readonly<{
  /**
   * `false` skips the per-frame outbox/journal/post-state equivalence checks.
   * Measurement only (pure Hub apply cost); restore and audited replay always
   * verify.
   */
  verify: boolean;
}>;

const replayOneFrame = async (
  deps: RecoveryJournalDeps,
  env: RuntimeReplica,
  frame: PersistedFrameJournal,
  height: number,
  options: RecoveryReplayOptions,
): Promise<void> => {
  // Reaching a later committed frame proves that the preceding frame crossed
  // its synchronous post-WAL dispatch boundary. Keep only this frame's outbox
  // after verification so a crash at the replay tip can redeliver it; carrying
  // older outputs forward would duplicate already accepted AccountInputs.
  env.pendingNetworkOutputs = [];
  env.state.timestamp = requireBoundaryInteger(
    frame.timestamp,
    `RECOVERY_JOURNAL_TIMESTAMP_INVALID:height=${height}`,
  );
  installReplayOutputSignerHints(env, collectOutputSignerHints(frame, height));
  installReplayOutputRuntimeRoutes(env, frame.runtimeOutputs ?? []);
  if (!env.infrastructure) throw new Error('RECOVERY_RUNTIME_INFRASTRUCTURE_REQUIRED');
  // validateEntityInfraContext constructs an isolated decoded value before
  // apply, and materializeEntityInfraContext clones that value for the
  // reducer. Cloning the immutable WAL source here was a third full copy of
  // the same HTLC graph and provided no additional ownership boundary.
  env.infrastructure.replayEntityContexts = new Map(frame.entityContexts ?? new Map());
  writeRuntimeMetadata(env, APPLY_ALLOWED, true);
  try {
    if (nodeProcess?.env?.['XLN_STORAGE_DEBUG_REPLICA_META'] === '1') {
      runtimeLog.info('recovery.replica_meta.pre', {
        height,
      });
    }
    const result = await timePerfPhase('recovery.frame.applyRuntimeInput', () =>
      deps.applyRuntimeInput(
        env,
        frame.runtimeInput ?? { runtimeTxs: [], entityInputs: [] },
      ));
    assertCrossJLocalCohorts(env);
    const jOutbox = splitJOutboxForDurableSubmit(result.jOutbox);
    registerPendingCommittedJOutbox(env, jOutbox.durable);
    refreshScheduledWakeIndex(
      env,
      new Set(
        result.appliedRuntimeInput.entityInputs.map(input =>
          input.entityId.toLowerCase(),
        ),
      ),
    );
    timePerfPhase('recovery.frame.applyOutputPlan', () => deps.applyRuntimeOutputPlan(
      env,
      result.entityOutbox,
      deps.getRuntimeOutputRoutingDeps(),
    ));
    if (options.verify) {
      timePerfPhase('recovery.frame.verifyOutbox', () => assertRecoveryOutboxMatches(
        frame.runtimeOutputs ?? [],
        env.pendingNetworkOutputs ?? [],
        {
          count: frame.runtimeOutputCount,
          digest: frame.runtimeOutputsDigest,
        },
        height,
      ));
    }
    const committedEvents = readRuntimeFrameEvents(env);
    clearPendingAuditEvents(env);
    env.runtimeMempool = { runtimeTxs: [], entityInputs: [] };
    env.pendingNetworkOutputs = frame.runtimeOutputs ?? [];
    if (options.verify) {
      timePerfPhase('recovery.frame.verifyJournal', () =>
        verifyRecoveryJournalFrame(env, frame, height, result));
    }
    // Production consumes exactly one event buffer after each authoritative
    // WAL commit. Replay previously retained every earlier frame's events,
    // manufacturing an O(history) live buffer and making economic TPS
    // impossible to derive from the verified transition. Record only after
    // the persisted frame passes every equivalence check, then clear it.
    recordCommittedRuntimeEntityMetrics(env, height, committedEvents);
    clearRuntimeFrameEvents(env);
    // The authoritative engine takes the same frame the journal just proved.
    // Replay has no WAL write of its own to wait for: the journal is already
    // durable, so only TS-side frame bookkeeping is released here.
    await assertAuthorityFrameSettled(env);
    await finalizeAuthorityFrameAfterWal(env);
  } catch (error) {
    runtimeLog.error('recovery.frame.failed', {
      height,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    });
    throw error;
  } finally {
    // A frame that threw after Account mutation cannot keep this process: the
    // durable journal remains the sole recovery truth.
    await failStopAuthorityFrame(env);
    if (env.infrastructure) delete env.infrastructure.replayEntityContexts;
    clearReplayOutputSignerHints(env);
    clearReplayOutputRuntimeRoutes(env);
    writeRuntimeMetadata(env, APPLY_ALLOWED, false);
  }
};

export const replayPersistedRuntimeJournals = async (
  deps: RecoveryJournalDeps,
  env: RuntimeReplica,
  frames: PersistedFrameJournal[],
  options: RecoveryReplayOptions = { verify: true },
): Promise<void> => {
  deps.ensureRuntimeConfig(env);
  const previousReplayMode = readRuntimeMetadata(env, REPLAY_MODE);
  writeRuntimeMetadata(env, REPLAY_MODE, true);
  try {
    let expectedHeight = requireBoundaryInteger(
      requireBoundaryInteger(
        env.state.height,
        'RECOVERY_JOURNAL_BASE_HEIGHT_INVALID',
      ) + 1,
      'RECOVERY_JOURNAL_HEIGHT_OVERFLOW',
    );
    for (const frame of frames) {
      const height = validateReplayFrameHeader(frame, expectedHeight);
      await replayOneFrame(deps, env, frame, height, options);
      if (env.state.height !== height) {
        throw new Error(
          `RECOVERY_JOURNAL_REPLAY_HEIGHT_MISMATCH: ` +
          `expected=${height} actual=${env.state.height}`,
        );
      }
      expectedHeight = requireBoundaryInteger(
        expectedHeight + 1,
        'RECOVERY_JOURNAL_HEIGHT_OVERFLOW',
      );
    }
  } finally {
    if (previousReplayMode === undefined) {
      deleteRuntimeMetadata(env, REPLAY_MODE);
    } else {
      writeRuntimeMetadata(env, REPLAY_MODE, previousReplayMode);
    }
    writeRuntimeMetadata(env, APPLY_ALLOWED, false);
  }
};
