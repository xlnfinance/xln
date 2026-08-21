import { nodeProcess } from '../../../support/process/runtime-process';
import { requireBoundaryInteger } from '../../../protocol/boundary-validation';
import { getConsumptionNodeStore } from '../../../entity/consumption/consumption-store';
import {
  deleteRuntimeMetadata,
  readRuntimeMetadata,
  writeRuntimeMetadata,
} from '../../../runtime/loop/loop-environment.ts';
import {
  clearPendingAuditEvents,
  dropPendingHistoryRecords,
  peekPendingHistoryRecords,
} from '../../../runtime/observability/env-events';
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
  authorizeRestoredRuntimeInput,
} from '../../wal/snapshot';
import { createStructuredLogger } from '../../../support/logger';
import {
  assertRecoveryOutboxMatches,
  verifyRecoveryJournalFrame,
} from './verification';
import { assertCrossJLocalCohorts } from '../../../runtime/delivery/topology/cross-j-topology';

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
  generateHookPings(env: RuntimeReplica): void;
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
    // A nested consensusOutput is invalid protocol data, never a recovery alias.
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

const replayOneFrame = async (
  deps: RecoveryJournalDeps,
  env: RuntimeReplica,
  frame: PersistedFrameJournal,
  height: number,
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
  env.infrastructure.replayEntityContexts = new Map(
    [...(frame.entityContexts ?? new Map())].map(([replicaId, context]) => [replicaId, structuredClone(context)]),
  );
  writeRuntimeMetadata(env, APPLY_ALLOWED, true);
  try {
    if (nodeProcess?.env?.['XLN_STORAGE_DEBUG_REPLICA_META'] === '1') {
      runtimeLog.info('recovery.replica_meta.pre', {
        height,
        consumptionNodes: getConsumptionNodeStore(env).size,
      });
    }
    const result = await deps.applyRuntimeInput(
      env,
      frame.runtimeInput ?? { runtimeTxs: [], entityInputs: [] },
    );
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
    deps.applyRuntimeOutputPlan(
      env,
      result.entityOutbox,
      deps.getRuntimeOutputRoutingDeps(),
    );
    assertRecoveryOutboxMatches(
      frame.runtimeOutputs ?? [],
      env.pendingNetworkOutputs ?? [],
      frame.runtimeOutputRefs ?? [],
      height,
    );
    deps.generateHookPings(env);
    const history = peekPendingHistoryRecords(env, env.state.height, env.state.timestamp);
    clearPendingAuditEvents(env);
    env.runtimeMempool = frame.pendingRuntimeInput
      ? authorizeRestoredRuntimeInput(frame.pendingRuntimeInput)
      : { runtimeTxs: [], entityInputs: [] };
    env.pendingNetworkOutputs = frame.runtimeOutputs ?? [];
    dropPendingHistoryRecords(env, history.length);
    verifyRecoveryJournalFrame(env, frame, height, result);
  } finally {
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
      await replayOneFrame(deps, env, frame, height);
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
