import { nodeProcess } from '../../infra/runtime-process';
import {
  cloneIsolatedRoutedEntityInputs,
  cloneIsolatedRuntimeInput,
} from '../../runtime/input-clone';
import { requireBoundaryInteger } from '../../protocol/boundary-validation';
import { getConsumptionNodeStore } from '../../entity/consumption/consumption-store';
import {
  deleteRuntimeMetadata,
  readRuntimeMetadata,
  writeRuntimeMetadata,
} from '../../runtime/loop/loop-environment.ts';
import {
  clearPendingAuditEvents,
  dropPendingHistoryRecords,
  peekPendingHistoryRecords,
} from '../../runtime/env-events';
import { restoreDurableOutputRetryState } from '../../runtime/durable-output-retry';
import {
  registerPendingCommittedJOutbox,
  splitJOutboxForDurableSubmit,
} from '../../runtime/j-submit-state';
import { finalizeReliableIngressCommit } from '../../runtime/reliable/reliable-delivery.ts';
import { refreshScheduledWakeIndex } from '../../runtime/scheduled-wake';
import {
  clearReplayOutputSignerHints,
  installReplayOutputSignerHints,
} from '../../runtime/entity-output-signer';
import type {
  RuntimeInput,
  RuntimeReplica,
  RoutedEntityInput,
} from '../../runtime/types';
import type { RuntimeInputApplyResult } from '../../runtime/frame/apply';
import type { RuntimeOutputRoutingDeps } from '../../runtime/output-routing';
import type { PersistedFrameJournal } from '../types';
import {
  authorizeRestoredRuntimeInput,
} from '../wal/snapshot';
import { createStructuredLogger } from '../../infra/logger';
import { verifyRecoveryJournalFrame } from './journal-verification';
import { assertCrossJLocalCohorts } from '../../runtime/cross-j-topology';

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
    const carriesAccountInput = (output.entityTxs ?? []).some(
      tx =>
        tx.type === 'accountInput' ||
        (tx.type === 'consensusOutput' &&
          tx.data.entityTxs.some(inner => inner.type === 'accountInput')),
    );
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
  env.state.timestamp = requireBoundaryInteger(
    frame.timestamp,
    `RECOVERY_JOURNAL_TIMESTAMP_INVALID:height=${height}`,
  );
  installReplayOutputSignerHints(env, collectOutputSignerHints(frame, height));
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
    deps.generateHookPings(env);
    const history = peekPendingHistoryRecords(env, env.state.height, env.state.timestamp);
    finalizeReliableIngressCommit(env, result.reliableIngressCommits);
    clearPendingAuditEvents(env);
    env.runtimeMempool = frame.pendingRuntimeInput
      ? authorizeRestoredRuntimeInput(
          cloneIsolatedRuntimeInput(frame.pendingRuntimeInput),
        )
      : { runtimeTxs: [], entityInputs: [] };
    env.pendingNetworkOutputs = cloneIsolatedRoutedEntityInputs(
      frame.runtimeOutputs ?? [],
    );
    restoreDurableOutputRetryState(
      env,
      frame.runtimeOutputRetryState ?? [],
      frame.runtimeOutputs ?? [],
    );
    dropPendingHistoryRecords(env, history.length);
    verifyRecoveryJournalFrame(env, frame, height, result);
  } finally {
    clearReplayOutputSignerHints(env);
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
