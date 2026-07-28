import { TIMING } from './constants';
import { dbRootPath, nodeProcess, runtimeIsBrowser } from './runtime/platform';

// Bump this on runtime bundle changes that must be reflected in frontend immediately.
const RUNTIME_BUILD_ID = '2026-07-18-16:00Z';
// Bump this only on breaking persistence/replay format or invariants.
export const RUNTIME_SCHEMA_VERSION = 5;
export const RUNTIME_BUILD = RUNTIME_BUILD_ID;

const RUNTIME_APPLY_PROFILE = nodeProcess?.env?.['XLN_RUNTIME_APPLY_PROFILE'] === '1';
const RUNTIME_APPLY_SLOW_MS = Math.max(0, Number(nodeProcess?.env?.['XLN_RUNTIME_APPLY_SLOW_MS'] || '500'));
import { getPerfMs, getWallClockMs } from './utils';
import { cumulativeMarksToPhases } from './infra/perf-profile';
import {
  causalTraceContainsWork,
  summarizeRuntimeAccountCausality,
} from './infra/account-causal-trace';
import { cloneIsolatedRuntimeInput } from './protocol/runtime-input-clone';
import { requireBoundaryInteger } from './protocol/boundary-validation';
import { buildCanonicalEnvSnapshot } from './wal/snapshot';
import { hasRuntimeHistoryTraceForTesting, recordRuntimeHistoryTraceForTesting } from './history-retention';
import {
  mergeEntityInputs,
  prioritizeEntityConsensusInputs,
  prioritizeProtocolEntityInputs,
} from './entity/consensus/index';
import { hasVerifiedEntityCommitPrecertificate } from './entity/consensus/commit-precheck';
import {
  isLocalEntityLeaderTimeoutVote,
} from './entity/consensus/leader';
import { setBrowserVMJurisdiction } from './jadapter';
import { createGossipLayer } from './networking/gossip';
import { attachEventEmitters, clearPendingAuditEvents, flushPendingAuditEvents } from './runtime/env-events';
import { recordRuntimeSecurityIncident } from './runtime/security-incidents';
import { accountInputAck, accountInputProposal } from './account/consensus/flush';
import { getEffectiveEntityInputTxs } from './entity/consensus/output-envelope';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  getSignerPrivateKeyIfAvailable,
  registerSignerKey,
} from './account/crypto';
import { normalizeRuntimeId } from './networking/runtime-id';
import { extractEntityId, extractSignerId } from './ids';
import {
  buildPendingNetworkOutputs,
  dispatchEntityOutputs,
  markRestoredReliableOutputsDue,
  rescheduleDeferredOutputs,
  splitRoutedOutputByDeliveryLane,
} from './runtime/output-routing';
import { isDeliveryDelivered } from './protocol/payments/delivery-result';
import { prepareHtlcPaymentEntityInputs } from './protocol/htlc/payment-admission';
import {
  announceCertifiedLocalProfiles,
  collectDueLocalProfileCertificationInputs,
} from './networking/local-profile-lifecycle';
import {
  selectMatchedCrossJAccountInputPairs,
  selectPotentialCrossJAccountInputPairs,
  type RuntimeEntityRoutingDeps,
} from './runtime/entity-routing';
import {
  assertScheduledWakeTxAuthorized,
  refreshScheduledWakeIndex,
} from './runtime/scheduled-wake';
import { transitionRuntimeLifecycle } from './runtime/lifecycle';
import { ensureRuntimeMempool } from './runtime/input-queue';
import { ensureRuntimeState } from './runtime/runtime-state';
import {
  applyReliableDeliveryReceipts,
  captureReliableReceiptSenderCheckpoint,
  commitReliableIngress,
  finalizeReliableIngressCommit,
  getInputReliableIdentity,
  registerReliableIngress,
  releaseUncommittedReliableIngress,
  rollbackReliableDeliveryReceipts,
  rollbackReliableIngressCommit,
  type ReliableIngressCommit,
} from './runtime/reliable-delivery';
import { reliableIdentityExactKey } from './runtime/reliable-frontier';
import { mergeDurableReceiptOnlyInputs } from './runtime/reliable-durable-inputs';
import { submitRuntimeJOutbox } from './runtime/j-submit';
import {
  registerPendingCommittedJOutbox,
  splitJOutboxForDurableSubmit,
} from './runtime/j-submit-state';
import { applyRuntimeTx } from './runtime/tx-handlers';
import { applyMergedEntityInputs, RuntimeEntityInputApplyError } from './runtime/entity-inputs';
import { applyEntityHeightDurabilityBarrier } from './runtime/entity-height-barrier';
import { safeStringify } from './protocol/serialization';
import { validateJInputs } from './wal/runtime-machine-schema/j';
import {
  beginRuntimeCheckpointLineageRefresh,
  refreshRuntimeCheckpointLineageForEntity,
} from './storage/entity-lineage';
import {
  materializePendingJurisdictionImportResults,
} from './runtime/jurisdiction-import';
import { validateEntityInput } from './validation-utils';
import type {
  EntityInput,
  EntityTx,
  Env,
  FrameLogEntry,
  JInput,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
  RuntimeInput,
  RuntimeTx,
} from './types';
import { DEBUG, log } from './utils';
import { createStructuredLogger, logError, shortId } from './infra/logger';
import { createPersistenceQueries } from './persistence/queries';
import {
  createRuntimeStorageApi,
  notifyRuntimeSyncAfterCommit,
} from './persistence/runtime-storage';
import { rehydrateRestoredRuntimeInfra, type TrustedJurisdictionRpcBinding } from './runtime/infra';
import { createRuntimeLoopApi } from './engine/loop';
import { createRuntimeRecoveryApi } from './recovery/restore';
import { createRuntimeStateApi } from './state/create';
import { loadGossipProfilesFromInfraDb } from './runtime/infra-gossip-store';
import { withStorageConsistentRead } from './storage/runtime-dbs';
import {
  createRuntimeCommandApi,
  getEntityDisplayInfoFromProfile,
  resolveEntityName,
  searchEntityNames,
} from './runtime/command-api';
import {
  abortRuntimeFrameTransaction,
  cloneRuntimeFrameMempool,
  cloneRuntimeFrameWorkingEnv,
  createRuntimeFrameTransaction,
  prependOlderRuntimeInput,
  publishRuntimeFrameTransaction,
  runtimeInputHasQueuedWork,
} from './runtime/frame/transaction';
import {
  ACCOUNT_CAUSAL_TRACE,
  createRuntimeProcessProfile,
} from './runtime/frame/process-profile';
import { createFrameExecutionState } from './runtime/frame/execution-state';
import { acquireRuntimeFrameWriter } from './runtime/frame/writer-lock';

const runtimeLog = createStructuredLogger('runtime');

// Runtime execution state lives on Env. This module owns the canonical
// frame transition; runtime.ts is intentionally only the public entrypoint.

const runtimeLoopApi = createRuntimeLoopApi({
  notifyEnvChange: env => notifyEnvChange(env),
  processRuntime: (env, inputs, runtimeDelay) => processRuntime(env, inputs, runtimeDelay),
  waitForRuntimeProcessingIdle: (env, timeoutMs) => waitForRuntimeProcessingIdle(env, timeoutMs),
  getRuntimeProcessGlobal: () => getRuntimeProcessGlobal(),
  runtimeInputHasQueuedWork: input => runtimeInputHasQueuedWork(input),
});

const {
  registerEnvChangeCallback,
  registerRuntimeFrameCommitCallback,
  registerRecoveryBackupBarrier,
  ENV_APPLY_ALLOWED_KEY,
  ENV_REPLAY_MODE_KEY,
  envRecord,
  ensureRuntimeConfig,
  getRuntimeStorageDb,
  getStorageDb,
  getInfraDb,
  getFrameDb,
  tryOpenStorageDb,
  rotateStorageEpochDb,
  tryOpenFrameDb,
  closeRuntimeDb,
  closeInfraDb,
  getCleanLogs,
  clearCleanLogs,
  copyCleanLogs,
  enqueueRuntimeInputs,
  enqueueRuntimeContinuation,
  tryOpenInfraDb,
  infraGossipDbAccess,
  trackInfraDbWrite,
  hasRuntimeWork,
  getRuntimeWorkReason,
  collectAccountMempoolWakeInputs,
  collectEntityMempoolWakeInputs,
  prioritizeJEventFrame,
  applyEntityInputFrameCap,
  applyEntityTxFrameCap,
  generateHookPings,
  isRuntimeFrameReady,
  quarantineLiveRuntimeInput,
  RuntimeInputQuarantinedError,
  startRuntimeLoop,
  waitForPromiseBeforeTimeout,
  stopRuntimeLoopAndWait,
  resumeRuntimeLoop,
  resumeRuntimeAfterPersistenceQuiesce,
  waitForRuntimeWorkDrained,
  startJurisdictionWatchers,
  stopJurisdictionWatchers,
  stopJurisdictionWatchersAndWait,
  getEnv,
  setRuntimeId,
  deriveRuntimeId,
  registerEntityRuntimeHint,
  MAX_RUNTIME_J_INPUTS,
  MAX_RUNTIME_J_TXS,
  MAX_RUNTIME_J_TXS_PER_JURISDICTION,
  MAX_RUNTIME_J_INPUT_BYTES,
  validateRuntimeJIngressLimits,
  handleInboundP2PEntityInput,
  handleInboundP2PEntityInputs,
  handleInboundReliableReceipt,
  normalizeRuntimeEntityInput,
  validateRuntimeInputAdmission,
  getRuntimeEntityRoutingDeps,
  getRuntimeOutputRoutingDeps,
  sendEntityInput,
  startP2P,
  stopP2P,
  stopP2PAndWait,
  getP2P,
  getP2PState,
  refreshGossip,
  ensureGossipProfiles,
  clearGossip,
} = runtimeLoopApi;

const failfastAssert: (
  condition: unknown,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => asserts condition = runtimeLoopApi.failfastAssert;

export type RuntimeLoopConfig = NonNullable<Parameters<typeof startRuntimeLoop>[1]>;

export {
  registerEnvChangeCallback,
  registerRuntimeFrameCommitCallback,
  registerRecoveryBackupBarrier,
  getRuntimeStorageDb,
  getInfraDb,
  getFrameDb,
  tryOpenStorageDb,
  tryOpenFrameDb,
  closeRuntimeDb,
  closeInfraDb,
  getCleanLogs,
  clearCleanLogs,
  copyCleanLogs,
  hasRuntimeWork,
  prioritizeJEventFrame,
  startRuntimeLoop,
  stopRuntimeLoopAndWait,
  resumeRuntimeLoop,
  resumeRuntimeAfterPersistenceQuiesce,
  waitForRuntimeWorkDrained,
  startJurisdictionWatchers,
  stopJurisdictionWatchers,
  stopJurisdictionWatchersAndWait,
  getEnv,
  setRuntimeId,
  deriveRuntimeId,
  registerEntityRuntimeHint,
  MAX_RUNTIME_J_INPUTS,
  MAX_RUNTIME_J_TXS,
  MAX_RUNTIME_J_TXS_PER_JURISDICTION,
  MAX_RUNTIME_J_INPUT_BYTES,
  handleInboundP2PEntityInput,
  handleInboundP2PEntityInputs,
  handleInboundReliableReceipt,
  validateRuntimeInputAdmission,
  sendEntityInput,
  startP2P,
  stopP2P,
  stopP2PAndWait,
  getP2P,
  getP2PState,
  refreshGossip,
  ensureGossipProfiles,
  clearGossip,
};
export const initEnv = (seed?: string | null): Env => {
  return createEmptyEnv(seed ?? null);
};

const notifyEnvChange = (env: Env) => {
  const state = ensureRuntimeState(env);
  if (!state.envChangeCallbacks || state.envChangeCallbacks.size === 0) return;
  for (const cb of state.envChangeCallbacks) {
    try {
      cb(env);
    } catch (error) {
      runtimeLog.warn('env_change.callback_failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
};

const notifyRuntimeFrameCommitted = (env: Env, runtimeInput: RuntimeInput): void => {
  const callbacks = ensureRuntimeState(env).runtimeFrameCommitCallbacks;
  if (!callbacks || callbacks.size === 0) return;
  const frame = { height: env.height, runtimeInput };
  for (const callback of callbacks) {
    try {
      callback(frame);
    } catch (error) {
      runtimeLog.warn('frame_commit.callback_failed', {
        error: error instanceof Error ? error.message : String(error),
        height: env.height,
      });
    }
  }
};

const crossJPairIndexesThatDidNotCommit = (
  pairs: ReturnType<typeof selectMatchedCrossJAccountInputPairs>['pairs'],
  outcomes: Awaited<ReturnType<typeof applyMergedEntityInputs>>['inputOutcomes'],
): Set<number> => {
  const committed = new Map(
    outcomes
      .filter(entry => entry.outcome.kind === 'committed' && entry.entityFrameCommitted)
      .map(entry => [entry.inputIndex, entry]),
  );
  const exactAccountFrameCommitted = (
    inputIndex: number,
    expected: ReturnType<typeof selectMatchedCrossJAccountInputPairs>['pairs'][number]['sourceAccountFrame'],
  ): boolean =>
    committed
      .get(inputIndex)
      ?.committedAccountFrames.some(
        frame =>
          frame.counterpartyEntityId === expected.counterpartyEntityId.toLowerCase() &&
          frame.height === expected.height &&
          frame.stateHash === expected.stateHash.toLowerCase(),
      ) === true;
  return new Set(
    pairs
      .filter(
        pair =>
          !exactAccountFrameCommitted(pair.sourceInputIndex, pair.sourceAccountFrame) ||
          !exactAccountFrameCommitted(pair.targetInputIndex, pair.targetAccountFrame),
      )
      .flatMap(pair => [pair.sourceInputIndex, pair.targetInputIndex]),
  );
};

const crossJAccountFrameMatches = (
  env: Env,
  expected: ReturnType<typeof selectMatchedCrossJAccountInputPairs>['pairs'][number]['sourceAccountFrame'],
): boolean => {
  const replica = [...env.eReplicas.values()].find(
    candidate =>
      candidate.entityId.toLowerCase() === expected.entityId.toLowerCase() &&
      candidate.signerId.toLowerCase() === expected.signerId.toLowerCase(),
  );
  const account = [...(replica?.state.accounts.entries() ?? [])].find(
    ([counterpartyId]) => counterpartyId.toLowerCase() === expected.counterpartyEntityId.toLowerCase(),
  )?.[1];
  return (
    account?.currentFrame.height === expected.height &&
    String(account.currentFrame.stateHash || '').toLowerCase() === expected.stateHash.toLowerCase()
  );
};

const markCommittedCrossJAtomicAckOutputs = (
  outputs: RoutedEntityInput[],
  pairs: ReturnType<typeof selectMatchedCrossJAccountInputPairs>['pairs'],
): void => {
  for (const pair of pairs) {
    if (pair.phase !== 'proposal') continue;
    const expectedFrames = [pair.sourceAccountFrame, pair.targetAccountFrame];
    const matched = expectedFrames.map(expected =>
      outputs.filter(
        output =>
          output.entityId.toLowerCase() === expected.counterpartyEntityId.toLowerCase() &&
          getEffectiveEntityInputTxs(output).some(tx => {
            if (tx.type !== 'accountInput') return false;
            const ack = accountInputAck(tx.data);
            return Boolean(
              ack &&
              tx.data.fromEntityId.toLowerCase() === expected.entityId.toLowerCase() &&
              tx.data.toEntityId.toLowerCase() === expected.counterpartyEntityId.toLowerCase() &&
              ack.height === expected.height &&
              String(ack.frameHash || '').toLowerCase() === expected.stateHash.toLowerCase(),
            );
          }),
      ),
    );
    if (matched.some(candidates => candidates.length !== 1) || matched[0]![0] === matched[1]![0]) {
      throw new Error(`RUNTIME_CROSS_J_ATOMIC_ACK_OUTPUTS_INVALID:${pair.pairKey}`);
    }
    for (const output of [matched[0]![0]!, matched[1]![0]!]) {
      output.atomicCrossJurisdictionPair = { phase: 'ack', pairKey: pair.pairKey };
    }
  }
};

const summarizeCrossJAccountInput = (input: RoutedEntityInput, inputIndex: number) => ({
  inputIndex,
  entityId: input.entityId,
  signerId: input.signerId,
  fromRuntimeId: input.from ?? '',
  sourceRuntimeFrame: input.sourceRuntimeFrame ?? null,
  accountInputs: getEffectiveEntityInputTxs(input).flatMap(tx => {
    if (tx.type !== 'accountInput') return [];
    const ack = accountInputAck(tx.data);
    const proposal = accountInputProposal(tx.data);
    const crossPulls =
      proposal?.frame.accountTxs.flatMap(accountTx => {
        if (accountTx.type !== 'pull_lock' || !accountTx.data.crossJurisdiction) return [];
        return [
          {
            leg: accountTx.data.crossJurisdiction.leg,
            orderId: accountTx.data.crossJurisdiction.orderId,
            routeHash: accountTx.data.crossJurisdiction.routeHash,
          },
        ];
      }) ?? [];
    return [
      {
        kind: tx.data.kind,
        fromEntityId: tx.data.fromEntityId,
        toEntityId: tx.data.toEntityId,
        ackHeight: ack?.height ?? null,
        proposalHeight: proposal?.frame.height ?? null,
        crossPulls,
      },
    ];
  }),
});

const groupAtomicCrossJAccountInputsFirst = (
  env: Env,
  selection: ReturnType<typeof selectMatchedCrossJAccountInputPairs>,
): ReturnType<typeof selectMatchedCrossJAccountInputPairs> => {
  if (selection.pairs.length === 0) return selection;
  const orderedPairs = [...selection.pairs].sort(
    (left, right) =>
      Math.min(left.sourceInputIndex, left.targetInputIndex) - Math.min(right.sourceInputIndex, right.targetInputIndex),
  );
  const pairedIndexes = new Set(orderedPairs.flatMap(pair => [pair.sourceInputIndex, pair.targetInputIndex]));
  if (pairedIndexes.size !== orderedPairs.length * 2) {
    throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_INPUT_OVERLAP');
  }
  const groupedInputs = [
    ...orderedPairs.flatMap(pair =>
      [pair.sourceInputIndex, pair.targetInputIndex]
        .sort((left, right) => left - right)
        .map(inputIndex => selection.inputs[inputIndex]!),
    ),
    ...selection.inputs.filter((_input, inputIndex) => !pairedIndexes.has(inputIndex)),
  ];
  const grouped = selectMatchedCrossJAccountInputPairs(env, groupedInputs);
  if (grouped.droppedInputIndexes.length > 0 || grouped.pairs.length !== selection.pairs.length) {
    throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_GROUPING_DIVERGED');
  }
  return grouped;
};

export const prepareAtomicCrossJAccountInputs = async (
  env: Env,
  inputs: readonly RoutedEntityInput[],
  initialJOutbox: JInput[],
  isReplay: boolean,
  routingDeps: RuntimeEntityRoutingDeps,
): Promise<{
  inputs: RoutedEntityInput[];
  pairs: ReturnType<typeof selectMatchedCrossJAccountInputPairs>['pairs'];
}> => {
  const initial = selectMatchedCrossJAccountInputPairs(env, inputs);
  if (initial.pairs.length > 0) {
    runtimeLog.info('crossj.atomic_pair_preflight', {
      inputCount: inputs.length,
      pairCount: initial.pairs.length,
      pairs: initial.pairs.map(pair => ({
        sourceInputIndex: pair.sourceInputIndex,
        targetInputIndex: pair.targetInputIndex,
        sourceHeight: pair.sourceAccountFrame.height,
        targetHeight: pair.targetAccountFrame.height,
      })),
    });
  }
  if (initial.droppedInputIndexes.length > 0) {
    if (isReplay) throw new Error('RUNTIME_REPLAY_CROSS_J_ACCOUNT_PAIR_INVALID');
    const droppedInputs = initial.droppedInputIndexes.map(inputIndex =>
      summarizeCrossJAccountInput(inputs[inputIndex]!, inputIndex),
    );
    env.warn('network', 'CROSS_J_ACCOUNT_PAIR_STRUCTURAL_MISMATCH', {
      received: inputs.length,
      droppedInputIndexes: initial.droppedInputIndexes,
      // Keep one flat canonical string: Bun's structured console formatter
      // collapses nested objects to `[Object ...]`, which destroyed the exact
      // ACK/proposal/frame evidence needed to diagnose a rejected money leg.
      inputSummary: safeStringify(inputs.map(summarizeCrossJAccountInput)),
    });
    for (const dropped of droppedInputs) {
      recordRuntimeSecurityIncident(env, {
        domain: 'cross-j',
        code: 'CROSS_J_ACCOUNT_PAIR_STRUCTURAL_MISMATCH',
        source: 'remote-ingress',
        severity: 'warning',
        summary: 'A cross-j Account leg arrived without its exact atomic sibling leg and was ignored',
        entityId: dropped.entityId,
      });
    }
  }
  let retained = initial.inputs;
  for (let attempt = 0; attempt <= initial.pairs.length; attempt += 1) {
    const selected = selectMatchedCrossJAccountInputPairs(env, retained);
    const selection = groupAtomicCrossJAccountInputsFirst(env, selected);
    if (selection.droppedInputIndexes.length > 0) {
      throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_SELECTION_UNSTABLE');
    }
    if (isReplay || selection.pairs.length === 0) return selection;
    const pairedInputCount = selection.pairs.length * 2;
    const pairedSelection = selectMatchedCrossJAccountInputPairs(env, selection.inputs.slice(0, pairedInputCount));
    if (pairedSelection.droppedInputIndexes.length > 0 || pairedSelection.pairs.length !== selection.pairs.length) {
      throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_PREFLIGHT_GROUP_INVALID');
    }
    const previewEnv = cloneRuntimeFrameWorkingEnv(env);
    let failedIndexes: Set<number>;
    let failureDetail = '';
    try {
      const preview = await applyMergedEntityInputs(previewEnv, pairedSelection.inputs, initialJOutbox, {
        isReplay: false,
        routingDeps,
      });
      failedIndexes = crossJPairIndexesThatDidNotCommit(pairedSelection.pairs, preview.inputOutcomes);
      if (failedIndexes.size > 0) {
        failureDetail = safeStringify({
          outcomes: preview.inputOutcomes.map(entry => ({
            inputIndex: entry.inputIndex,
            kind: entry.outcome.kind,
            entityFrameCommitted: entry.entityFrameCommitted,
            committedAccountFrames: entry.committedAccountFrames,
          })),
          localCrossJurisdictionEvents: preview.localCrossJurisdictionEventTrace.map(input => ({
            entityId: input.entityId,
            txTypes: getEffectiveEntityInputTxs(input).map(tx => tx.type),
          })),
        });
      }
    } catch (error) {
      if (!(error instanceof RuntimeEntityInputApplyError) || !error.isRemoteIngress) throw error;
      failureDetail = error.message;
      const failedInputIndex = pairedSelection.inputs.findIndex(
        input =>
          input.entityId.toLowerCase() === error.entityId.toLowerCase() &&
          input.signerId.toLowerCase() === error.signerId.toLowerCase() &&
          String(input.from ?? '')
            .trim()
            .toLowerCase() === error.sourceRuntimeId.toLowerCase() &&
          input.sourceRuntimeFrame?.height === error.sourceRuntimeHeight &&
          input.sourceRuntimeFrame?.timestamp === error.sourceRuntimeTimestamp,
      );
      const failedPair = pairedSelection.pairs.find(
        pair => pair.sourceInputIndex === failedInputIndex || pair.targetInputIndex === failedInputIndex,
      );
      // Only the exact two-leg remote cohort is soft-rejected. A tempting
      // catch-all here would hide an unrelated Runtime/Entity invariant failure.
      if (!failedPair) throw error;
      failedIndexes = new Set([failedPair.sourceInputIndex, failedPair.targetInputIndex]);
    }
    for (const pair of pairedSelection.pairs) {
      if (
        crossJAccountFrameMatches(env, pair.sourceAccountFrame) ||
        crossJAccountFrameMatches(env, pair.targetAccountFrame)
      ) {
        failedIndexes.add(pair.sourceInputIndex);
        failedIndexes.add(pair.targetInputIndex);
      }
    }
    if (failedIndexes.size === 0) return selection;
    env.warn('network', 'CROSS_J_ACCOUNT_PAIR_PREVIEW_REJECTED', {
      attempt,
      pairCount: pairedSelection.pairs.length,
      droppedInputIndexes: [...failedIndexes].sort((left, right) => left - right),
      failureDetail,
    });
    for (const pair of pairedSelection.pairs) {
      const pairIndexes = [pair.sourceInputIndex, pair.targetInputIndex];
      if (!pairIndexes.some(inputIndex => failedIndexes.has(inputIndex))) continue;
      for (const inputIndex of pairIndexes) {
        const rejectedInput = pairedSelection.inputs[inputIndex]!;
        recordRuntimeSecurityIncident(env, {
          domain: 'cross-j',
          code: 'CROSS_J_ACCOUNT_PAIR_PREVIEW_REJECTED',
          source: 'remote-ingress',
          severity: 'warning',
          summary: 'A signed cross-j Account pair failed atomic scratch-state validation and was ignored',
          entityId: rejectedInput.entityId,
        });
      }
    }
    retained = selection.inputs.filter((_input, inputIndex) => !failedIndexes.has(inputIndex));
  }
  throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_PREFLIGHT_DID_NOT_CONVERGE');
};

const applyRuntimeInput = async (
  env: Env,
  runtimeInput: RuntimeInput,
): Promise<{
  entityOutbox: RoutedEntityInput[];
  mergedInputs: RoutedEntityInput[];
  jOutbox: JInput[];
  appliedRuntimeInput: RuntimeInput;
  reliableIngressCommits: ReliableIngressCommit[];
  immediateReliableReceipts: Array<{
    runtimeId: string;
    receipt: ReliableDeliveryReceipt;
  }>;
}> => {
  failfastAssert(
    env.scenarioMode === true || envRecord(env)[ENV_APPLY_ALLOWED_KEY] === true,
    'RUNTIME_APPLY_DIRECT_CALL',
    'applyRuntimeInput must be invoked via process()/WAL replay (non-scenario)',
    { runtimeId: env.runtimeId, height: env.height },
  );
  const startTime = getPerfMs();
  const applyProfileMarks: Record<string, number> = {};
  const markApplyProfile = (label: string): void => {
    applyProfileMarks[label] = Math.round(getPerfMs() - startTime);
  };

  // Ensure event emitters are attached (may be lost after store serialization)
  if (!env.emit) {
    attachEventEmitters(env);
  }

  try {
    const rejectRuntimeInput = (message: string): never => {
      log.error(`❌ ${message}`);
      throw new Error(message);
    };
    if (envRecord(env)[ENV_REPLAY_MODE_KEY] === true) {
      runtimeLog.debug('input.replay.apply', {
        runtimeTxs: runtimeInput.runtimeTxs.length,
        entityInputs: runtimeInput.entityInputs.length,
      });
    }
    // SECURITY: Validate runtime input
    if (!runtimeInput) {
      rejectRuntimeInput('Null runtime input provided');
    }
    if (!Array.isArray(runtimeInput.runtimeTxs)) {
      rejectRuntimeInput(`Invalid runtimeTxs: expected array, got ${typeof runtimeInput.runtimeTxs}`);
    }
    if (!Array.isArray(runtimeInput.entityInputs)) {
      rejectRuntimeInput(`Invalid entityInputs: expected array, got ${typeof runtimeInput.entityInputs}`);
    }
    if (runtimeInput.reliableReceipts !== undefined && !Array.isArray(runtimeInput.reliableReceipts)) {
      rejectRuntimeInput(`Invalid reliableReceipts: expected array, got ${typeof runtimeInput.reliableReceipts}`);
    }

    validateRuntimeJIngressLimits(env, runtimeInput);

    // Collect incoming J-inputs into early jOutbox (will be merged with handler jOutputs later)
    // These are NOT pushed to jReplica.mempool — they go to jOutbox → JAdapter post-save
    const earlyJOutbox: JInput[] = [];
    if (runtimeInput.jInputs && Array.isArray(runtimeInput.jInputs)) {
      const validatedJInputs = validateJInputs(runtimeInput.jInputs, 'RUNTIME_INPUT_J');
      runtimeLog.debug('joutbox.incoming', { jInputs: runtimeInput.jInputs.length });
      for (const jInput of validatedJInputs) {
        const jReplica = env.jReplicas?.get(jInput.jurisdictionName);
        if (!jReplica) {
          rejectRuntimeInput(`Unknown J jurisdiction: ${jInput.jurisdictionName}`);
        }
        runtimeLog.debug('joutbox.collect', {
          jurisdictionName: jInput.jurisdictionName,
          jTxs: jInput.jTxs.length,
          types: jInput.jTxs.map(t => t.type),
        });
        earlyJOutbox.push(jInput);
      }
    }

    // SECURITY: Resource limits
    if (runtimeInput.runtimeTxs.length > 1000) {
      rejectRuntimeInput(`Too many runtime transactions: ${runtimeInput.runtimeTxs.length} > 1000`);
    }
    if (runtimeInput.entityInputs.length > 10000) {
      rejectRuntimeInput(`Too many entity inputs: ${runtimeInput.entityInputs.length} > 10000`);
    }
    if ((runtimeInput.reliableReceipts?.length ?? 0) > 10000) {
      rejectRuntimeInput(`Too many reliable receipts: ${runtimeInput.reliableReceipts!.length} > 10000`);
    }

    const validatedRuntimeTxs = [...runtimeInput.runtimeTxs];
    let validatedEntityInputs = runtimeInput.entityInputs.map((input, i) => {
      try {
        const isReplay = envRecord(env)[ENV_REPLAY_MODE_KEY] === true;
        for (const tx of input.entityTxs ?? []) assertScheduledWakeTxAuthorized(tx, isReplay);
        return normalizeRuntimeEntityInput(env, validateEntityInput(input), `runtimeInput[${i}]`);
      } catch (error) {
        logError('RUNTIME_TICK', `🚨 CRITICAL FINANCIAL ERROR: Invalid EntityInput[${i}] before merge!`, {
          error: (error as Error).message,
          entityId: shortId(input?.entityId, 12),
          signerId: shortId(input?.signerId, 12),
          sourceRuntimeId: shortId(input?.from, 12),
          sourceRuntimeHeight: (input as Partial<RoutedEntityInput>).sourceRuntimeFrame?.height ?? null,
          entityTxTypes: Array.isArray(input?.entityTxs) ? input.entityTxs.map(tx => tx?.type) : [],
        });
        throw error; // Fail fast
      }
    });

    const isReplay = envRecord(env)[ENV_REPLAY_MODE_KEY] === true;
    const immediateReliableReceipts: Array<{
      runtimeId: string;
      receipt: ReliableDeliveryReceipt;
    }> = [];
    const atomicCrossJInputIndexes = new Set(
      selectPotentialCrossJAccountInputPairs(validatedEntityInputs)
        .flatMap(pair => [pair.sourceInputIndex, pair.targetInputIndex]),
    );
    const admittedEntityInputs: RoutedEntityInput[] = [];
    for (const [inputIndex, input] of validatedEntityInputs.entries()) {
      const sourceRuntimeId = normalizeRuntimeId(input.from);
      // Local inputs and non-reliable remote inputs enter the frame directly.
      // Reliable remote ingress is registered only on this isolated working
      // Env, never by transport against the live committed Env.
      if (!sourceRuntimeId || !getInputReliableIdentity(input)) {
        admittedEntityInputs.push(input);
        continue;
      }
      const registration = registerReliableIngress(env, sourceRuntimeId, input, {
        allowContiguousPendingAccountAck: atomicCrossJInputIndexes.has(inputIndex),
      });
      // WAL replay contains only inputs selected by the original committed
      // frame. Recreate its frontier and apply the exact persisted batch.
      if (isReplay || registration.kind === 'ordinary' || registration.kind === 'enqueue') {
        admittedEntityInputs.push(input);
        continue;
      }
      if (registration.kind === 'receipt') {
        immediateReliableReceipts.push({ runtimeId: sourceRuntimeId, receipt: registration.receipt });
      }
    }
    validatedEntityInputs = admittedEntityInputs;

    const mergedRuntimeTxs = [...validatedRuntimeTxs];
    const mergedInputs = mergeEntityInputs([...validatedEntityInputs], input =>
      hasVerifiedEntityCommitPrecertificate(env, input),
    );
    markApplyProfile('validateMerge');

    if (runtimeInput.reliableReceipts && runtimeInput.reliableReceipts.length > 0) {
      applyReliableDeliveryReceipts(env, runtimeInput.reliableReceipts);
    }
    const runtimeTxJOutbox: JInput[] = [];
    const lineageRefreshGuards = new Map<string, ReturnType<typeof beginRuntimeCheckpointLineageRefresh>>();
    const refreshLineageBeforeEntityApply = (rawEntityId: string, force = false): void => {
      const entityId = rawEntityId.trim().toLowerCase();
      if (force) {
        lineageRefreshGuards.get(entityId)?.finalize();
        lineageRefreshGuards.delete(entityId);
        refreshRuntimeCheckpointLineageForEntity(env, entityId);
        return;
      }
      if (lineageRefreshGuards.has(entityId)) return;
      lineageRefreshGuards.set(entityId, beginRuntimeCheckpointLineageRefresh(env, entityId));
    };
    // RuntimeTxs are replayable R-machine commands. Most are local metadata
    // transitions; retryJSubmit additionally materializes a sealed post-commit
    // J side effect whose attempt record is persisted before external I/O.
    for (const runtimeTx of mergedRuntimeTxs) {
      runtimeTxJOutbox.push(
        ...(await applyRuntimeTx(env, runtimeTx, {
          isReplay,
        })),
      );
      if (runtimeTx.type === 'importReplica') {
        // A repeated import can add another validator-local replica for the
        // same Entity in this R-frame, so rebuild that Entity's replica-set
        // anchor after every import rather than relying on the touched set.
        refreshLineageBeforeEntityApply(runtimeTx.entityId, true);
      }
    }
    markApplyProfile('runtimeTxs');

    // Seal each Entity at most once immediately before its first E-frame in
    // this R-frame. Internal cross-j cascades use the same hook. Subsequent
    // commits for that Entity intentionally retain the contiguous links until
    // the enclosing Runtime WAL commit.
    markApplyProfile('lineage');

    const routingDeps = getRuntimeEntityRoutingDeps();
    const initialJOutbox = [...earlyJOutbox, ...runtimeTxJOutbox];
    const preparedEntityInputs = await prepareAtomicCrossJAccountInputs(
      env,
      mergedInputs,
      initialJOutbox,
      isReplay,
      routingDeps,
    );
    markApplyProfile('atomicCrossJPreflight');
    const appliedEntityBatch = await applyMergedEntityInputs(env, preparedEntityInputs.inputs, initialJOutbox, {
      isReplay,
      routingDeps,
      beforeEntityApply: refreshLineageBeforeEntityApply,
    });
    for (const guard of lineageRefreshGuards.values()) guard.finalize();
    if (preparedEntityInputs.pairs.length > 0) {
      runtimeLog.info('crossj.atomic_pair_commit', {
        pairCount: preparedEntityInputs.pairs.length,
        outcomes: appliedEntityBatch.inputOutcomes.map(({ outcome }, inputIndex) => ({
          inputIndex,
          entityId: preparedEntityInputs.inputs[inputIndex]?.entityId ?? 'missing',
          kind: outcome.kind,
        })),
        outputSummary: safeStringify(
          appliedEntityBatch.entityOutbox.map((output, outputIndex) => ({
            outputIndex,
            ...summarizeCrossJAccountInput(output, outputIndex),
          })),
        ),
      });
    }
    markApplyProfile('entityApply');
    const failedAtomicIndexes = crossJPairIndexesThatDidNotCommit(
      preparedEntityInputs.pairs,
      appliedEntityBatch.inputOutcomes,
    );
    if (failedAtomicIndexes.size > 0) {
      throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_COMMIT_DIVERGED_FROM_PREFLIGHT');
    }
    markCommittedCrossJAtomicAckOutputs(appliedEntityBatch.entityOutbox, preparedEntityInputs.pairs);
    const { entityOutbox, appliedEntityInputs, entityFrameCommitted, jOutbox } = appliedEntityBatch;

    // Reliable receiver authority is part of the R-machine post-state, not a
    // transport side effect. Plan it before deciding whether this tick owns a
    // WAL height. Otherwise a terminal receipt-only transition can ACK/GC an
    // input while no replayable frame records the new frontier.
    const reliableIngressCommits = commitReliableIngress(env, appliedEntityInputs);
    markApplyProfile('reliableCommit');
    applyCommittedLocalReliableReceipts(env, reliableIngressCommits, {
      isReplay,
      replayInputs: validatedEntityInputs,
    });
    markApplyProfile('reliableLocalReceipts');
    releaseUncommittedReliableIngress(env, validatedEntityInputs, appliedEntityInputs);
    markApplyProfile('reliableRelease');
    // Releasing a rejected/deferred ingress mutates only the live transport
    // waiter set. It is deliberately absent from snapshots and cannot own a
    // WAL height. Durable active/terminal frontier commits remain replayable.
    const reliableIngressStateChanged = reliableIngressCommits.length > 0;

    if (jOutbox.length > 0) {
      for (const jInput of jOutbox) {
        for (const jTx of jInput.jTxs) {
          const jTxBatchSize = (jTx.data as { batchSize?: number } | undefined)?.batchSize;
          env.emit('JBatchQueued', {
            entityId: jTx.entityId,
            batchSize: jTxBatchSize,
            jurisdictionName: jInput.jurisdictionName,
          });
        }
      }
    }

    const hasRuntimeTxs = mergedRuntimeTxs.length > 0;
    const meaningfulEntityInputCount = appliedEntityInputs.reduce((count, input) => {
      const hasEntityTxs = (input.entityTxs?.length || 0) > 0;
      const hasProposal = !!input.proposedFrame;
      const hasHashPrecommits = !!input.hashPrecommits && input.hashPrecommits.size > 0;
      const hasJPrefixAttestations = !!input.jPrefixAttestations && input.jPrefixAttestations.size > 0;
      const hasLeaderTimeoutVote = !!input.leaderTimeoutVote;
      return (
        count +
        (hasEntityTxs || hasProposal || hasHashPrecommits || hasJPrefixAttestations || hasLeaderTimeoutVote ? 1 : 0)
      );
    }, 0);
    // A local empty tick may commit work already held in the Entity/Account
    // mempools. Input shape cannot detect that transition. The authoritative
    // signal is the validated Entity height advancing exactly H -> H+1.
    const runtimeEntityInputCount = entityFrameCommitted
      ? Math.max(meaningfulEntityInputCount, appliedEntityInputs.length)
      : meaningfulEntityInputCount;
    const hasEntityInputs = runtimeEntityInputCount > 0;
    const hasReliableReceipts = (runtimeInput.reliableReceipts?.length ?? 0) > 0;
    const hasOutputs = entityOutbox.length > 0;
    const hasJOutputs = jOutbox.length > 0;

    if (
      hasRuntimeTxs ||
      hasEntityInputs ||
      hasReliableReceipts ||
      hasOutputs ||
      hasJOutputs ||
      reliableIngressStateChanged
    ) {
      // Emit runtime tick event
      env.emit('RuntimeTick', {
        height: env.height + 1,
        runtimeTxs: mergedRuntimeTxs.length,
        entityInputs: runtimeEntityInputCount,
        outputs: entityOutbox.length,
      });

      // Update env in-place first.
      // This is intentional blockchain-style execution semantics: we execute the
      // next frame against one mutable working state, then persist the resulting
      // post-state as the committed frame below. That is simpler and safer than
      // trying to keep a separate pre-commit shadow env in lockstep.
      env.height++;
      // IMPORTANT: Do NOT mutate env.timestamp here.
      // process() sets a single frame timestamp before applyRuntimeInput(),
      // and that exact value must be used both for frame hashing and WAL journal.
    } else {
      if (env.quietRuntimeLogs !== true) {
        runtimeLog.debug('frame.skip_empty');
      }
      // Clear env.extra even when skipping frame to prevent stale solvency expectations
      env.extra = undefined;
    }

    if (!env.gossip) {
      runtimeLog.warn('gossip.missing_recreate', { height: env.height });
      env.gossip = createGossipLayer();
      runtimeLog.info('gossip.recreated', { height: env.height });
    }
    markApplyProfile('finalize');

    const durableReliableIngressSources = new Map<string, Set<string>>();
    for (const commit of reliableIngressCommits) {
      if (!commit.key) continue;
      const sources = durableReliableIngressSources.get(commit.key) ?? new Set<string>();
      commit.targetRuntimeIds.forEach(source => sources.add(source));
      durableReliableIngressSources.set(commit.key, sources);
    }
    for (const ledger of [
      env.runtimeState?.reliableIngressReceiptLedger,
      env.runtimeState?.reliableIngressTerminalWatermarks,
    ]) {
      for (const [frontierKey, receipt] of ledger ?? []) {
        const parsed = JSON.parse(frontierKey) as { sourceRuntimeId?: unknown };
        const source = normalizeRuntimeId(parsed.sourceRuntimeId);
        if (!source) throw new Error('RELIABLE_INGRESS_FRONTIER_SOURCE_RUNTIME_INVALID');
        const key = reliableIdentityExactKey(receipt.body.identity);
        const sources = durableReliableIngressSources.get(key) ?? new Set<string>();
        sources.add(source);
        durableReliableIngressSources.set(key, sources);
      }
    }
    const durableReceiptOnlyInputs = validatedEntityInputs.flatMap(input =>
      splitRoutedOutputByDeliveryLane(input).flatMap(lane => {
        if (lane.leaderTimeoutVote?.signature === '' && isLocalEntityLeaderTimeoutVote(lane.leaderTimeoutVote)) {
          // This is a local scheduler command, not authenticated transport
          // ingress. Consensus replaces it with the signed canonical value in
          // appliedEntityInputs before WAL persistence.
          return [];
        }
        const identity = getInputReliableIdentity(lane);
        if (!identity) return [];
        const sources = durableReliableIngressSources.get(reliableIdentityExactKey(identity));
        if (!sources || sources.size === 0) return [];
        if (lane.from) return [lane];
        return [...sources].sort().map(source => ({ ...lane, from: source }));
      }),
    );
    // `existing` may be the canonical merge of several independently
    // certified delivery lanes. Provenance annotates that applied batch;
    // replacing it with one receipt lane silently drops the other txs from WAL
    // and makes crash replay build a different Entity frame.
    const persistedEntityInputs = mergeDurableReceiptOnlyInputs(appliedEntityInputs, durableReceiptOnlyInputs);
    markApplyProfile('durableReceiptInputs');
    const appliedRuntimeInput: RuntimeInput = {
      runtimeTxs: mergedRuntimeTxs,
      entityInputs: persistedEntityInputs,
      ...(runtimeInput.jInputs && runtimeInput.jInputs.length > 0 ? { jInputs: runtimeInput.jInputs } : {}),
      ...(runtimeInput.reliableReceipts && runtimeInput.reliableReceipts.length > 0
        ? { reliableReceipts: runtimeInput.reliableReceipts }
        : {}),
    };
    const applyElapsedMs = Math.round(getPerfMs() - startTime);
    if (RUNTIME_APPLY_PROFILE || applyElapsedMs >= RUNTIME_APPLY_SLOW_MS) {
      runtimeLog.info('apply.profile', {
        height: env.height,
        elapsedMs: applyElapsedMs,
        runtimeTxs: mergedRuntimeTxs.length,
        entityInputs: appliedEntityInputs.length,
        entityTxs: appliedEntityInputs.reduce((sum, input) => sum + Number(input.entityTxs?.length || 0), 0),
        outputs: entityOutbox.length,
        jOutputs: jOutbox.length,
        phases: cumulativeMarksToPhases(applyProfileMarks, applyElapsedMs),
      });
    }
    if (DEBUG) {
      runtimeLog.debug('tick.completed', {
        height: env.height - 1,
        elapsedMs: applyElapsedMs,
      });
    }
    return {
      entityOutbox,
      mergedInputs: preparedEntityInputs.inputs,
      jOutbox,
      appliedRuntimeInput,
      reliableIngressCommits,
      immediateReliableReceipts,
    };
  } catch (error) {
    // Strict scenarios already surface the thrown value at their outer boundary.
    // Logging directly to process stderr here would make the strict console trap throw a
    // second Error and erase the original stack, hiding the actual failing reducer.
    if (env.strictScenario) throw error;
    runtimeLog.error('apply_input.failed', {
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    });
    throw error; // Don't swallow - fail fast and loud
  }
};

// Runtime bootstrap
export type RuntimeLocalSigner = Readonly<{
  label: string;
  seed?: Uint8Array | string;
}>;

export type RuntimeCreationOptions = Readonly<{
  trustedJurisdictionRpcBindings?: readonly TrustedJurisdictionRpcBinding[];
  localSigners?: readonly RuntimeLocalSigner[];
}>;

const main = async (runtimeSeedOverride?: string | null, options?: RuntimeCreationOptions): Promise<Env> => {
  const runtimeSeed = runtimeSeedOverride ?? null;
  if (options?.localSigners?.length && runtimeSeed === null) {
    throw new Error('RUNTIME_LOCAL_SIGNERS_REQUIRE_SEED');
  }
  if (runtimeSeed !== null) {
    for (const signer of options?.localSigners ?? []) {
      const label = String(signer.label || '').trim();
      if (!label) throw new Error('RUNTIME_LOCAL_SIGNER_LABEL_REQUIRED');
      const signerSeed = signer.seed ?? runtimeSeed;
      const signerId = deriveSignerAddressSync(signerSeed, label).toLowerCase();
      registerSignerKey(runtimeSeed, signerId, deriveSignerKeySync(signerSeed, label));
    }
  }
  const baseEnv = createEmptyEnv(runtimeSeed);

  let env = baseEnv;
  let restoredFromCoreDb = false;
  const restoreDisabled =
    !runtimeIsBrowser &&
    !!nodeProcess &&
    /^(1|true)$/i.test(String(nodeProcess.env['XLN_DISABLE_RUNTIME_RESTORE'] ?? ''));
  if (!restoreDisabled) {
    const loaded = await loadEnvFromDB(baseEnv.runtimeId, baseEnv.runtimeSeed, {
      ...(options?.trustedJurisdictionRpcBindings
        ? { trustedJurisdictionRpcBindings: options.trustedJurisdictionRpcBindings }
        : {}),
    });
    if (loaded) {
      env = loaded;
      restoredFromCoreDb = true;
      runtimeLog.info('main.restored', { runtime: String(env.runtimeId || '').slice(0, 12), height: env.height });
    }
  }

  attachEventEmitters(env);
  if (!restoredFromCoreDb) {
    try {
      await loadGossipProfilesFromInfraDb(env, infraGossipDbAccess);
    } catch (error) {
      runtimeLog.warn('main.infra_gossip_restore_skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!env.runtimeId && env.runtimeSeed) {
    try {
      env.runtimeId = deriveSignerAddressSync(env.runtimeSeed, '1');
      runtimeLog.debug('main.runtime_id_derived', { runtime: env.runtimeId.slice(0, 12) });
    } catch (error) {
      runtimeLog.warn('main.runtime_id_derive_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (runtimeIsBrowser) {
    runtimeLog.info('main.loop_start_browser');
    startRuntimeLoop(env);
  }

  return env;
};

// === TIME MACHINE API ===
const getHistory = (env: Env) => env.history || [];
const getSnapshot = (env: Env, index: number) => {
  const history = env.history || [];
  return index >= 0 && index < history.length ? history[index] : null;
};
const getCurrentHistoryIndex = (env: Env) => (env.history || []).length - 1;

// Clear database for a specific runtime and return a fresh env
/**
 * Queue an entity transaction for processing (helper for UI components)
 * Wraps applyRuntimeInput with a single entity tx
 */
export const queueEntityInput = async (
  env: Env,
  entityId: string,
  signerId: string,
  txData: { type: EntityTx['type'] } & Record<string, unknown>,
): Promise<void> => {
  enqueueRuntimeInputs(
    env,
    [
      {
        entityId,
        signerId,
        entityTxs: [{ type: txData.type, data: txData } as EntityTx],
      },
    ],
    undefined,
    undefined,
    env.timestamp,
  );
};

export {
  applyRuntimeInput,
  getCurrentHistoryIndex,
  getEntityDisplayInfoFromProfile,
  getHistory,
  getSnapshot,
  main,
  resolveEntityName,
  searchEntityNames,
  setBrowserVMJurisdiction,
};

// Runtime is a pure library - no auto-execution side effects.
// Browser and server entrypoints call xln.main() explicitly.

const runtimeStateApi = createRuntimeStateApi({
  ensureRuntimeConfig,
  infraGossipDbAccess,
  trackInfraDbWrite,
});

export const prewarmRuntimeSignerCache = runtimeStateApi.prewarmRuntimeSignerCache;
export const createEmptyEnv = runtimeStateApi.createEmptyEnv;
export { cloneRuntimeFrameMempool };

const runtimeRecoveryApi = createRuntimeRecoveryApi({
  ensureRuntimeConfig,
  createEmptyEnv,
  getStorageDb,
  getFrameDb,
  tryOpenStorageDb,
  tryOpenFrameDb,
  closeRuntimeDb,
  closeInfraDb,
  enqueueRuntimeContinuation,
  infraGossipDbAccess,
  generateHookPings,
  startJurisdictionWatchers,
  getRuntimeOutputRoutingDeps,
  applyRuntimeInput,
});

export const restoreEnvFromCheckpointSnapshot = runtimeRecoveryApi.restoreEnvFromCheckpointSnapshot;
export const restoreEnvFromRecoveryBundles = runtimeRecoveryApi.restoreEnvFromRecoveryBundles;
export const persistRestoredEnvToDB = runtimeRecoveryApi.persistRestoredEnvToDB;
const replayRecoveryFrameJournals = runtimeRecoveryApi.replayRecoveryFrameJournals;
const assertPersistedContractConfigReady = runtimeRecoveryApi.assertPersistedContractConfigReady;
const registerCommittedSingleSignerWallets = runtimeRecoveryApi.registerCommittedSingleSignerWallets;
const reconcileCommittedRuntimeInfraEffects = runtimeRecoveryApi.reconcileCommittedRuntimeInfraEffects;
const hasPendingLocalReliableOutput = runtimeRecoveryApi.hasPendingLocalReliableOutput;
const applyDeterministicRuntimeOutputPlan = runtimeRecoveryApi.applyDeterministicRuntimeOutputPlan;
const applyCommittedLocalReliableReceipts = runtimeRecoveryApi.applyCommittedLocalReliableReceipts;

// === CONSENSUS PROCESSING ===
// ONE TICK = ONE ITERATION. No cascade. E→E communication always requires new tick.

export const processRuntime = async (env: Env, inputs?: EntityInput[], runtimeDelay = 0) => {
  const liveEnv = env;
  const processState = ensureRuntimeState(env);
  const releaseProcessLock = await acquireRuntimeFrameWriter(processState);

  const processProfile = createRuntimeProcessProfile(liveEnv, getRuntimeWorkReason(env));
  const frame = createFrameExecutionState();
  try {
    // IMPORTANT: capture frame baseline only after acquiring the process lock.
    // If captured before waiting on an in-flight tick, we can mis-detect
    // frame advancement and overwrite WAL entries with empty runtime input.
    const frameHeightBeforeTick = env.height;
    const frameTimestampBeforeTick = env.timestamp;
    env.lastProcessEnteredAt = Date.now();
    env.activeProcessProgressAt = env.lastProcessEnteredAt;
    env.activeProcessProgressStep = 'entered';

    if (!env.emit) {
      attachEventEmitters(env);
    }

    if (env.stopAtFrame !== undefined && env.height >= env.stopAtFrame) {
      console.log(`\n⏸️  FRAME STEPPING: Stopped at frame ${env.height}`);
      console.log('═'.repeat(80));
      const { formatRuntime } = await import('./qa/runtime-ascii');
      console.log(formatRuntime(env, { maxAccounts: 10, maxLocks: 20, maxSwaps: 20 }));
      console.log('═'.repeat(80) + '\n');
      console.log('💾 State captured - use jq on /tmp/{scenario}-runtime.json for deep queries');
      throw new Error(`FRAME_STEP: Stopped at frame ${env.height} for debugging`);
    }

    const ingressNow = env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs();
    if (inputs && inputs.length > 0) {
      enqueueRuntimeInputs(env, inputs, undefined, undefined, ingressNow);
    }
    if (env.pendingOutputs && env.pendingOutputs.length > 0) {
      enqueueRuntimeContinuation(env, env.pendingOutputs, undefined, undefined, ingressNow);
      env.pendingOutputs = [];
    }
    if (env.networkInbox && env.networkInbox.length > 0) {
      enqueueRuntimeContinuation(env, env.networkInbox, undefined, undefined, ingressNow);
      env.networkInbox = [];
    }
    processProfile.mark('ingressQueues');
    await materializePendingJurisdictionImportResults(env, runtimeTx => {
      enqueueRuntimeContinuation(
        env,
        undefined,
        [runtimeTx],
        undefined,
        env.scenarioMode ? env.timestamp : getWallClockMs(),
      );
    });
    processProfile.mark('jurisdictionImports');
    const pendingProfileCertificationEntityIds = processState.pendingProfileCertificationEntityIds;
    const profileCertificationInputs = collectDueLocalProfileCertificationInputs(
      env,
      pendingProfileCertificationEntityIds,
    );
    // Undefined means the first post-start scan covered every local Entity.
    // Later scans consume only Entities dirtied by the preceding committed
    // Runtime frame; a crash naturally restores the one-time full scan.
    processState.pendingProfileCertificationEntityIds = new Set();
    if (profileCertificationInputs.length > 0) {
      // Derived local work belongs to the already-open ingress boundary. Do
      // not replace an explicit queued timestamp with the wall clock observed
      // later by process(); that would make the same signed input hash
      // differently depending on scheduler latency.
      const profileIngressTimestamp = ensureRuntimeMempool(env).queuedAt ?? ingressNow;
      enqueueRuntimeContinuation(env, profileCertificationInputs, undefined, undefined, profileIngressTimestamp);
    }
    processProfile.mark('profileCertification');
    processProfile.mark('enqueue');

    if (!hasRuntimeWork(env)) {
      processProfile.outcome = 'no-work';
      return env;
    }

    const frameGateNow = env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs();
    if (!isRuntimeFrameReady(env, frameGateNow, runtimeDelay)) {
      processProfile.outcome = 'not-ready';
      return env;
    }
    processProfile.mark('frameReady');

    const mempoolQueuedAt = ensureRuntimeMempool(env).queuedAt;
    const quietRuntimeLogs = env.quietRuntimeLogs === true;
    frame.transaction = createRuntimeFrameTransaction(env);
    env = frame.transaction.workingEnv;
    let state = ensureRuntimeState(env);
    const mempool = ensureRuntimeMempool(env);
    for (const jReplica of env.jReplicas?.values?.() ?? []) {
      jReplica.jadapter?.setQuietLogs?.(quietRuntimeLogs);
    }

    if (env.scenarioMode) {
      env.timestamp = requireBoundaryInteger(
        requireBoundaryInteger(env.timestamp, 'RUNTIME_TIMESTAMP_INVALID') + 100,
        'RUNTIME_TIMESTAMP_OVERFLOW',
      );
    } else {
      const liveNow = getWallClockMs();
      const previousTimestamp = requireBoundaryInteger(env.timestamp, 'RUNTIME_TIMESTAMP_INVALID');
      if (previousTimestamp > liveNow + TIMING.TIMESTAMP_DRIFT_MS) {
        throw new Error(`RUNTIME_CLOCK_AHEAD: env.timestamp=${previousTimestamp} wall=${liveNow}`);
      }
      const ingressTimestamp = requireBoundaryInteger(mempoolQueuedAt ?? liveNow, 'RUNTIME_MEMPOOL_TIMESTAMP_INVALID');
      const boundedIngressTimestamp = Math.min(ingressTimestamp, liveNow + TIMING.TIMESTAMP_DRIFT_MS);
      env.timestamp = Math.max(previousTimestamp, boundedIngressTimestamp);
    }
    for (const jReplica of env.jReplicas?.values?.() ?? []) {
      jReplica.jadapter?.setBlockTimestamp(env.timestamp);
    }

    // Inject pings for entities with due scheduled hooks (setTimeout-like)
    generateHookPings(env);

    const automaticWakeInputs = [...collectEntityMempoolWakeInputs(env), ...collectAccountMempoolWakeInputs(env)];
    const explicitEntityInputKeys = new Set(
      mempool.entityInputs.map(
        input => `${String(input.entityId || '').toLowerCase()}:${String(input.signerId || '').toLowerCase()}`,
      ),
    );
    const dedupedAutomaticWakeInputs = automaticWakeInputs.filter(input => {
      const key = `${input.entityId.toLowerCase()}:${input.signerId.toLowerCase()}`;
      if (explicitEntityInputKeys.has(key)) return false;
      explicitEntityInputKeys.add(key);
      return true;
    });
    const runtimeInput: RuntimeInput = {
      runtimeTxs: [...mempool.runtimeTxs],
      entityInputs: [...mempool.entityInputs, ...dedupedAutomaticWakeInputs],
      ...(mempool.jInputs && mempool.jInputs.length > 0 ? { jInputs: [...mempool.jInputs] } : {}),
      ...(mempool.reliableReceipts && mempool.reliableReceipts.length > 0
        ? { reliableReceipts: [...mempool.reliableReceipts] }
        : {}),
    };
    // Automatic Entity/account wakes join after the live mempool is detached.
    // Publish their exact count before the first await in frame processing.
    processState.inFlightEntityInputs = runtimeInput.entityInputs.length;
    let runtimeInputDrained = false;
    let runtimeInputForRequeue: RuntimeInput | undefined;
    frame.rollbackUndurable = async (
      error: unknown,
      options: { quarantine?: boolean; requeue?: boolean } = {},
    ): Promise<Error> => {
      const originalError = error instanceof Error ? error : new Error(String(error));
      const workingMempoolAfterAttempt = frame.transaction
        ? ensureRuntimeMempool(frame.transaction.workingEnv)
        : ensureRuntimeMempool(env);
      const rollbackErrors = frame.transaction ? await abortRuntimeFrameTransaction(frame.transaction) : [];
      env = liveEnv;
      state = ensureRuntimeState(env);
      frame.reliableIngressCommits = [];
      frame.reliableReceiptSenderCheckpoint = undefined;
      const quarantineResult =
        options.quarantine === false
          ? null
          : quarantineLiveRuntimeInput(liveEnv, runtimeInput, originalError, quietRuntimeLogs);
      if (!quarantineResult && options.requeue !== false) {
        const retry = runtimeInputDrained
          ? (() => {
              const attempted = runtimeInputForRequeue ?? cloneRuntimeFrameMempool(runtimeInput);
              if (attempted.queuedAt === undefined) {
                attempted.queuedAt = mempoolQueuedAt ?? frameTimestampBeforeTick;
              }
              return prependOlderRuntimeInput(attempted, workingMempoolAfterAttempt);
            })()
          : workingMempoolAfterAttempt;
        const restoredMempool = prependOlderRuntimeInput(retry, ensureRuntimeMempool(liveEnv));
        liveEnv.runtimeMempool = restoredMempool;
        liveEnv.runtimeInput = restoredMempool;
      }
      return rollbackErrors.length > 0
        ? new AggregateError([originalError, ...rollbackErrors], 'RUNTIME_APPLY_ROLLBACK_FAILED')
        : quarantineResult
          ? new RuntimeInputQuarantinedError(originalError)
          : originalError;
    };
    processProfile.metrics.runtimeTxs = runtimeInput.runtimeTxs.length;
    processProfile.metrics.entityInputs = runtimeInput.entityInputs.length;
    processProfile.metrics.entityTxs = runtimeInput.entityInputs.reduce(
      (sum, input) => sum + Number(input.entityTxs?.length || 0),
      0,
    );
    processProfile.metrics.jInputs = runtimeInput.jInputs?.length ?? 0;
    processProfile.metrics.reliableReceipts = runtimeInput.reliableReceipts?.length ?? 0;
    mempool.runtimeTxs = [];
    mempool.entityInputs = [];
    if (mempool.jInputs) mempool.jInputs = [];
    if (mempool.reliableReceipts) mempool.reliableReceipts = [];
    mempool.queuedAt = undefined;
    runtimeInputDrained = true;

    const jEventFramePrioritized = prioritizeJEventFrame(runtimeInput, mempool, mempoolQueuedAt ?? env.timestamp ?? 0);
    runtimeInput.entityInputs = prioritizeEntityConsensusInputs(runtimeInput.entityInputs, input =>
      hasVerifiedEntityCommitPrecertificate(env, input),
    );
    runtimeInput.entityInputs = prioritizeProtocolEntityInputs(runtimeInput.entityInputs);
    applyEntityHeightDurabilityBarrier(env, runtimeInput, mempool, mempoolQueuedAt ?? env.timestamp ?? 0);
    applyEntityTxFrameCap(
      runtimeInput,
      mempool,
      state.maxEntityTxsPerFrame ?? 0,
      mempoolQueuedAt ?? env.timestamp ?? 0,
    );
    applyEntityInputFrameCap(
      runtimeInput,
      mempool,
      state.maxEntityInputsPerFrame ?? 0,
      mempoolQueuedAt ?? env.timestamp ?? 0,
    );
    runtimeInput.entityInputs = await prepareHtlcPaymentEntityInputs(env, runtimeInput.entityInputs);
    runtimeInputForRequeue = cloneRuntimeFrameMempool(runtimeInput);
    if (ACCOUNT_CAUSAL_TRACE) {
      const ingress = summarizeRuntimeAccountCausality(runtimeInput.entityInputs);
      if (causalTraceContainsWork(ingress)) {
        processProfile.metrics.accountCausality = { ingress, egress: [] };
      }
    }
    processProfile.metrics.entityInputs = runtimeInput.entityInputs.length;
    processProfile.metrics.entityTxs = runtimeInput.entityInputs.reduce(
      (sum, input) => sum + Number(input.entityTxs?.length || 0),
      0,
    );
    processProfile.mark('mempoolFrame');
    const hasRuntimeInput =
      runtimeInput.runtimeTxs.length > 0 ||
      runtimeInput.entityInputs.length > 0 ||
      (runtimeInput.jInputs?.length ?? 0) > 0 ||
      (runtimeInput.reliableReceipts?.length ?? 0) > 0;
    let appliedRuntimeInputForPersistence: RuntimeInput | undefined;

    if ((runtimeInput.reliableReceipts?.length ?? 0) > 0 || hasPendingLocalReliableOutput(env)) {
      frame.reliableReceiptSenderCheckpoint = captureReliableReceiptSenderCheckpoint(env);
    }

    let entityOutbox: RoutedEntityInput[] = [];
    let jOutbox: JInput[] = [];
    let queuedJSubmitRetries: RuntimeTx[] = [];
    const changedEntityIds = new Set<string>();
    const getLocallySignableEntityIds = (): Set<string> => {
      const localEntityIds = new Set<string>();
      for (const replicaKey of env.eReplicas.keys()) {
        const signerId = extractSignerId(replicaKey);
        const entityId = extractEntityId(replicaKey).toLowerCase();
        if (!signerId) continue;
        if (getSignerPrivateKeyIfAvailable(env, signerId) !== null) localEntityIds.add(entityId);
      }
      return localEntityIds;
    };
    if (hasRuntimeInput) {
      if (!quietRuntimeLogs) {
        runtimeLog.debug('tick.input.processing', {
          entityInputs: runtimeInput.entityInputs.length,
          entityIds: runtimeInput.entityInputs.map(o => o.entityId.slice(-4)),
        });
        if (jEventFramePrioritized) {
          runtimeLog.debug('tick.input.deferred_for_j_event');
        }
        if (runtimeInput.runtimeTxs.length > 0) {
          runtimeLog.debug('tick.runtime_txs.processing', { runtimeTxs: runtimeInput.runtimeTxs.length });
        }
      }
      try {
        envRecord(env)[ENV_APPLY_ALLOWED_KEY] = true;
        const result = await applyRuntimeInput(env, runtimeInput);
        processProfile.mark('apply');
        if (!quietRuntimeLogs && (result.entityOutbox.length > 0 || result.jOutbox.length > 0)) {
          runtimeLog.debug('process.apply.output', {
            entityOutbox: result.entityOutbox.length,
            jOutbox: result.jOutbox.length,
          });
        }
        entityOutbox = result.entityOutbox;
        if (ACCOUNT_CAUSAL_TRACE) {
          const egress = summarizeRuntimeAccountCausality(entityOutbox);
          if (causalTraceContainsWork(egress)) {
            processProfile.metrics.accountCausality = {
              ingress: processProfile.metrics.accountCausality?.ingress ?? [],
              egress,
            };
          }
        }
        const splitJOutbox = splitJOutboxForDurableSubmit(result.jOutbox);
        registerPendingCommittedJOutbox(env, splitJOutbox.durable);
        queuedJSubmitRetries = splitJOutbox.retries;
        jOutbox = splitJOutbox.maintenance;
        // Local authorization symbols prove that a command entered through a
        // trusted in-process adapter. They are neither deterministic protocol
        // data nor needed on replay (replay is authorized by the committed
        // frame). Persisting them would make an otherwise valid frame depend
        // on process-local object metadata, so strip them at this boundary.
        appliedRuntimeInputForPersistence = cloneIsolatedRuntimeInput(result.appliedRuntimeInput);
        frame.reliableIngressCommits = result.reliableIngressCommits;
        frame.immediateReliableReceiptDeliveries = result.immediateReliableReceipts;
        refreshScheduledWakeIndex(env, new Set(runtimeInput.entityInputs.map(input => input.entityId.toLowerCase())));
        for (const runtimeTx of runtimeInput.runtimeTxs) {
          if (runtimeTx.type === 'importReplica') {
            changedEntityIds.add(runtimeTx.entityId.toLowerCase());
          }
        }
        // Every Entity state mutation is represented by the canonical applied
        // input, including sibling cross-j cascades. Re-announcing those exact
        // Entities is cheaper and safer than rebuilding every local public
        // profile twice per Runtime frame merely to detect a difference.
        for (const entityInput of result.appliedRuntimeInput.entityInputs) {
          if (entityInput.entityId) changedEntityIds.add(entityInput.entityId.toLowerCase());
        }
        const certificationCandidates = state.pendingProfileCertificationEntityIds ?? new Set<string>();
        for (const entityId of changedEntityIds) {
          const hasCertifiedManifest = [...env.eReplicas.values()].some(
            replica => replica.entityId.toLowerCase() === entityId && Boolean(replica.state.profileEncryptionManifest),
          );
          if (!hasCertifiedManifest) certificationCandidates.add(entityId);
        }
        state.pendingProfileCertificationEntityIds = certificationCandidates;
        processProfile.mark('fingerprints');
      } finally {
        envRecord(env)[ENV_APPLY_ALLOWED_KEY] = false;
      }
    }

    jOutbox = [...(state.pendingCommittedJOutbox ?? []), ...jOutbox];
    const jSideEffectIntentCount = jOutbox.length + queuedJSubmitRetries.length;
    const runtimeInfraEffectCount = (appliedRuntimeInputForPersistence?.runtimeTxs ?? []).filter(
      runtimeTx =>
        runtimeTx.type === 'importJ' || runtimeTx.type === 'completeImportJ' || runtimeTx.type === 'importReplica',
    ).length;

    const outputRoutingDeps = getRuntimeOutputRoutingDeps();
    const {
      localOutputs,
      remoteOutputs,
      deferredOutputs,
      readyPendingOutputs,
      waitingPendingOutputs,
      retainedLocalReliableOutputs,
    } = applyDeterministicRuntimeOutputPlan(env, entityOutbox, outputRoutingDeps);
    processProfile.metrics.localOutputs = localOutputs.length;
    processProfile.metrics.remoteOutputs = remoteOutputs.length;
    processProfile.metrics.deferredOutputs = deferredOutputs.length;
    processProfile.metrics.readyPendingOutputs = readyPendingOutputs.length;
    processProfile.metrics.waitingPendingOutputs = waitingPendingOutputs.length;
    processProfile.metrics.jOutputs = jOutbox.length;
    processProfile.mark('planOutputs');
    if (localOutputs.length > 0 && !quietRuntimeLogs) {
      runtimeLog.debug('tick.local_outputs.queued', {
        localOutputs: localOutputs.length,
        reliableRetained: retainedLocalReliableOutputs.length,
        entityIds: localOutputs.map(o => o.entityId.slice(-4)),
      });
    }
    // Re-check due crontab work after apply. Hooks scheduled at the current
    // logical timestamp should run on the next tick without importing wall
    // clock time into runtime consensus.
    generateHookPings(env);
    // BrowserVM trie is NOT serialized per-frame — it's J-layer state.
    // Only serialized on shutdown/page-unload for reload recovery.

    const frameAdvanced = env.height !== frameHeightBeforeTick;
    processProfile.metrics.frameAdvanced = frameAdvanced;
    if (frameAdvanced) {
      if (hasRuntimeHistoryTraceForTesting(liveEnv)) {
        const committedFrameLogs = Array.isArray(env.frameLogs)
          ? env.frameLogs.map((entry): FrameLogEntry => ({ ...entry }))
          : [];
        frame.pendingTraceSnapshot = buildCanonicalEnvSnapshot(env, {
          runtimeInput: appliedRuntimeInputForPersistence ?? { runtimeTxs: [], entityInputs: [] },
          runtimeOutputs: env.pendingOutputs ?? [],
          description: env.extra?.description ?? `Frame ${env.height}`,
          meta: {
            title: env.extra?.subtitle?.title ?? `Frame ${env.height}`,
            ...(env.extra?.subtitle ? { subtitle: env.extra.subtitle } : {}),
            ...(env.frameDisplayMs !== undefined ? { displayMs: env.frameDisplayMs } : {}),
          },
          logs: committedFrameLogs,
          gossipProfiles: env.gossip?.getProfiles ? env.gossip.getProfiles() : [],
        });

        // The collector owns this explicit debug lifetime. Production Env does
        // not retain a second full copy of finalized state.
      }
      env.history = [];
      processProfile.mark('snapshot');
    }
    env.extra = undefined;

    // === COMMIT POINT: persist finalized R-frame ===
    // Persist only when a new runtime frame was actually applied.
    // Side-effect-only ticks (e.g. deferred network retries) must never
    // overwrite WAL entries for the current height.
    //
    // Why this ordering exists:
    // 1. applyRuntimeInput() computes the post-state for frame N in memory
    // 2. saveEnvToDB() makes frame N durable / replayable
    // 3. only after that do we treat downstream effects as safe to emit
    //
    // That keeps execution, hashing, and recovery aligned around one exact
    // post-state. A crash before save loses only the uncommitted in-memory
    // tail, just like a block that executed locally but was never committed.
    if (frameAdvanced) {
      if (!quietRuntimeLogs) {
        runtimeLog.debug('storage.save.start', { height: env.height });
      }
      try {
        const saveOutcome = await saveEnvToDB(env, appliedRuntimeInputForPersistence, env.pendingNetworkOutputs);
        processProfile.metrics.storageMs = saveOutcome.persistencePerfMs;
        if (saveOutcome.staleWriterStopped) {
          frame.rollbackHandled = true;
          const rollbackError = await frame.rollbackUndurable(new Error('STALE_RUNTIME_WRITER_STOPPED'), {
            quarantine: false,
            requeue: false,
          });
          env = liveEnv;
          state = ensureRuntimeState(env);
          const haltedState = state;
          transitionRuntimeLifecycle(haltedState, 'halted');
          haltedState.fatalDebugPayload = {
            message:
              `STALE_RUNTIME_WRITER_STOPPED: frame=${frameHeightBeforeTick + 1} ` +
              `runtime=${String(env.runtimeId || '').slice(0, 12)}`,
            height: Math.max(0, env.height ?? 0),
            timestamp: Math.max(0, env.timestamp ?? 0),
          };
          haltedState.stopLoop?.();
          processProfile.outcome = 'stale-writer-stopped';
          if (rollbackError.message !== 'STALE_RUNTIME_WRITER_STOPPED') throw rollbackError;
          return env;
        }
        frame.commitDisposition = 'committed';
        frame.reliableReceiptStateDurable = true;
        processProfile.mark('save');
        flushPendingAuditEvents(env);
        env.frameLogs = [];
        if (!frame.transaction) throw new Error('RUNTIME_FRAME_TRANSACTION_MISSING_AT_COMMIT');
        env = publishRuntimeFrameTransaction(frame.transaction);
        state = ensureRuntimeState(env);
        if (frame.pendingTraceSnapshot) {
          recordRuntimeHistoryTraceForTesting(env, frame.pendingTraceSnapshot);
        }
        if (!quietRuntimeLogs) {
          runtimeLog.debug('storage.save.done', { height: env.height });
        }
        processProfile.mark('publish');
      } catch (error) {
        if (error instanceof RuntimeFrameStorageError && error.commitStatus !== 'not-committed') {
          frame.commitDisposition = error.commitStatus === 'committed' ? 'committed' : 'unknown';
          frame.reliableReceiptStateDurable = true;
          clearPendingAuditEvents(env);
          if (frame.transaction && (error.commitStatus === 'committed' || error.commitStatus === 'unknown')) {
            env = publishRuntimeFrameTransaction(frame.transaction);
          } else {
            env = liveEnv;
          }
          state = ensureRuntimeState(env);
          const haltedState = state;
          transitionRuntimeLifecycle(haltedState, 'halted');
          haltedState.fatalDebugPayload = {
            message: error.message,
            height: Math.max(0, env.height ?? 0),
            timestamp: Math.max(0, env.timestamp ?? 0),
          };
          haltedState.stopLoop?.();
        } else {
          clearPendingAuditEvents(env);
        }
        throw error;
      }
    } else {
      frame.commitDisposition = 'committed';
      clearPendingAuditEvents(env);
      if (!frame.transaction) throw new Error('RUNTIME_FRAME_TRANSACTION_MISSING_AT_EMPTY_COMMIT');
      env = publishRuntimeFrameTransaction(frame.transaction);
      state = ensureRuntimeState(env);
    }

    if (frameAdvanced && appliedRuntimeInputForPersistence) {
      const syncNotificationError = notifyRuntimeSyncAfterCommit(env);
      if (syncNotificationError) {
        runtimeLog.error('runtime_sync.notification_failed', {
          error: syncNotificationError.message,
          height: env.height,
        });
      }
      notifyRuntimeFrameCommitted(env, appliedRuntimeInputForPersistence);
    }

    const recoveryBarrier = state.recoveryBackupBarrier;
    const pendingReliableReceiptDeliveryCount = frame.reliableIngressCommits.reduce(
      (count, commit) => count + commit.targetRuntimeIds.length,
      0,
    );
    const recoveryRemoteOutputCount = remoteOutputs.length + pendingReliableReceiptDeliveryCount;
    if (
      recoveryBarrier &&
      (recoveryRemoteOutputCount > 0 || jSideEffectIntentCount > 0 || runtimeInfraEffectCount > 0)
    ) {
      try {
        await recoveryBarrier(env, {
          height: env.height,
          remoteOutputCount: recoveryRemoteOutputCount,
          jInputCount: jSideEffectIntentCount + runtimeInfraEffectCount,
        });
      } catch (error) {
        env.error('system', 'RECOVERY_BACKUP_BARRIER_FAILED', {
          height: env.height,
          remoteOutputCount: recoveryRemoteOutputCount,
          jInputCount: jSideEffectIntentCount + runtimeInfraEffectCount,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    processProfile.mark('recoveryBackup');

    await reconcileCommittedRuntimeInfraEffects(env, appliedRuntimeInputForPersistence?.runtimeTxs ?? []);
    await materializePendingJurisdictionImportResults(env, runtimeTx => {
      enqueueRuntimeContinuation(
        env,
        undefined,
        [runtimeTx],
        undefined,
        env.scenarioMode ? env.timestamp : getWallClockMs(),
      );
    });
    processProfile.mark('runtimeInfra');

    frame.reliableReceiptDeliveries = [
      ...frame.immediateReliableReceiptDeliveries,
      ...finalizeReliableIngressCommit(env, frame.reliableIngressCommits),
    ];
    if (frame.reliableReceiptDeliveries.some(delivery => delivery.receipt.body.identity.kind === 'account-ack')) {
      runtimeLog.info('reliable.account_receipts.finalized', {
        receipts: frame.reliableReceiptDeliveries
          .filter(delivery => delivery.receipt.body.identity.kind === 'account-ack')
          .map(delivery => ({
            targetRuntimeId: delivery.runtimeId,
            height: delivery.receipt.body.identity.height,
            coverage: delivery.receipt.body.coverage,
            entityId: delivery.receipt.body.identity.entityId,
          })),
      });
    }

    if (queuedJSubmitRetries.length > 0) {
      enqueueRuntimeContinuation(env, undefined, queuedJSubmitRetries, undefined, env.timestamp);
    }

    // === SIDE EFFECTS (safe to fail — bilateral consensus retries) ===

    // A fresh account frame can reference a brand-new user entity. Publish the
    // sender profile before remote delivery so the counterparty can enforce the
    // same-jurisdiction invariant without racing gossip.
    const p2p = getP2P(env);
    const localEntityIds = getLocallySignableEntityIds();
    const changedLocalEntityIds = [...changedEntityIds].filter(entityId => localEntityIds.has(entityId));
    const knownProfileIds = new Set((env.gossip?.getProfiles?.() ?? []).map(profile => profile.entityId.toLowerCase()));
    const newLocalEntityIds = changedLocalEntityIds.filter(entityId => !knownProfileIds.has(entityId));
    const refreshLocalEntityIds = changedLocalEntityIds.filter(entityId => knownProfileIds.has(entityId));
    if (
      p2p &&
      remoteOutputs.length > 0 &&
      newLocalEntityIds.length > 0 &&
      typeof p2p.announceProfilesForEntitiesNow === 'function'
    ) {
      // Only a previously unknown sender must precede its first remote output.
      // Existing route-capacity refreshes are metadata and are coalesced below.
      await p2p.announceProfilesForEntitiesNow(newLocalEntityIds, 'pre-output-profile-refresh', false);
    } else if (!p2p && changedLocalEntityIds.length > 0) {
      // The in-process gossip store is the only discovery surface in this
      // topology, so certified profile changes must be observable when the
      // frame promise resolves. Live P2P runtimes coalesce refreshes below.
      await announceCertifiedLocalProfiles(env, changedLocalEntityIds);
    }
    processProfile.mark('profileAnnounce');

    // 1. Broadcast entity outputs via P2P (fire-and-forget)
    if (remoteOutputs.length > 0 && env.quietRuntimeLogs !== true) {
      runtimeLog.debug('side_effect.remote_outputs.dispatch', { remoteOutputs: remoteOutputs.length });
    }
    const dispatchDeferred = dispatchEntityOutputs(env, remoteOutputs, outputRoutingDeps);

    if (refreshLocalEntityIds.length > 0) {
      p2p?.announceProfilesForEntities(refreshLocalEntityIds, 'routing-profile-refresh');
    }
    const deferredNewLocalEntityIds = p2p && remoteOutputs.length === 0 ? newLocalEntityIds : [];
    if (deferredNewLocalEntityIds.length > 0) {
      p2p?.announceProfilesForEntities(deferredNewLocalEntityIds, 'routing-profile-new');
    }

    const allDeferred = [...deferredOutputs, ...dispatchDeferred];
    const rescheduledNetworkOutputs = rescheduleDeferredOutputs(
      env,
      readyPendingOutputs,
      allDeferred,
      waitingPendingOutputs,
      outputRoutingDeps,
    );
    env.pendingNetworkOutputs = buildPendingNetworkOutputs([
      ...rescheduledNetworkOutputs,
      ...retainedLocalReliableOutputs,
    ]);
    processProfile.metrics.pendingNetworkAfter = env.pendingNetworkOutputs.length;
    processProfile.metrics.deferredNetworkMeta = env.runtimeState?.deferredNetworkMeta?.size ?? 0;
    processProfile.mark('dispatchOutputs');

    // A committed business response and its transport receipt share one
    // post-WAL boundary. Queue the useful Entity envelope first on the same
    // ordered connection; otherwise the sender spends a complete R-frame
    // persisting receipt GC before it can apply ACK+next Account proposal.
    if (frame.reliableReceiptDeliveries.length > 0) {
      const receiptP2P = getP2P(env);
      for (const delivery of frame.reliableReceiptDeliveries) {
        const directResult = state.directReliableReceiptDispatch?.(delivery.runtimeId, delivery.receipt);
        const usedDirect = Boolean(directResult && isDeliveryDelivered(directResult));
        const result = usedDirect
          ? directResult
          : (receiptP2P?.enqueueReliableReceiptDelivery(delivery.runtimeId, delivery.receipt) ?? directResult);
        if (delivery.receipt.body.identity.kind === 'account-ack') {
          runtimeLog.info('reliable.account_receipt.dispatch', {
            targetRuntimeId: delivery.runtimeId,
            height: delivery.receipt.body.identity.height,
            coverage: delivery.receipt.body.coverage,
            transport: usedDirect ? 'direct' : 'p2p',
            delivered: Boolean(result && isDeliveryDelivered(result)),
            code: result?.code ?? null,
          });
        }
        if (!result || !isDeliveryDelivered(result)) {
          env.warn('network', 'RELIABLE_RECEIPT_SEND_DEFERRED', {
            targetRuntimeId: delivery.runtimeId,
            delivery: result ?? null,
          });
        }
      }
    }
    processProfile.mark('dispatchReceipts');

    // 2. Execute J-batches via JAdapter.submitTx (events arrive next frame via j-watcher)
    await submitRuntimeJOutbox(env, jOutbox, {
      enqueueRuntimeInputs: enqueueRuntimeContinuation,
    });
    processProfile.mark('jOutbox');

    state.lastFrameAt = getWallClockMs();

    if (env.strictScenario) {
      const { assertRuntimeStateStrict } = await import('./protocol/assertions');
      await assertRuntimeStateStrict(env);
      processProfile.mark('strict');
    }

    // CRITICAL: Notify frontend after snapshot is pushed to history
    // Without this, UI (TimeMachine, AccountPanel) never learns about new frames
    notifyEnvChange(env);
    processProfile.mark('notify');

    processProfile.outcome = 'completed';
    return env;
  } catch (error) {
    if (frame.commitDisposition === 'undurable' && !frame.rollbackHandled && frame.rollbackUndurable) {
      frame.rollbackHandled = true;
      const rollbackError = await frame.rollbackUndurable(error, {
        quarantine: !(error instanceof RuntimeFrameStorageError),
      });
      if (rollbackError instanceof RuntimeInputQuarantinedError) {
        processProfile.outcome = 'input-dropped';
        return liveEnv;
      }
      throw rollbackError;
    }
    if (
      frame.commitDisposition === 'undurable' &&
      !frame.rollbackHandled &&
      frame.transaction &&
      !frame.transaction.published
    ) {
      frame.rollbackHandled = true;
      const workingMempool = ensureRuntimeMempool(frame.transaction.workingEnv);
      const cleanupErrors = await abortRuntimeFrameTransaction(frame.transaction);
      const restoredMempool = prependOlderRuntimeInput(workingMempool, ensureRuntimeMempool(liveEnv));
      liveEnv.runtimeMempool = restoredMempool;
      liveEnv.runtimeInput = restoredMempool;
      env = liveEnv;
      if (cleanupErrors.length > 0) {
        const originalError = error instanceof Error ? error : new Error(String(error));
        throw new AggregateError([originalError, ...cleanupErrors], 'RUNTIME_FRAME_TRANSACTION_ABORT_FAILED');
      }
    }
    throw error;
  } finally {
    if (!frame.reliableReceiptStateDurable) {
      rollbackReliableIngressCommit(env, frame.reliableIngressCommits);
      if (frame.reliableReceiptSenderCheckpoint) {
        rollbackReliableDeliveryReceipts(env, frame.reliableReceiptSenderCheckpoint);
      }
    }
    if (processProfile.outcome === 'unknown') {
      processProfile.outcome = 'thrown';
    }
    processProfile.finish(env);
    processState.inFlightEntityInputs = 0;
    delete liveEnv.activeProcessProgressAt;
    delete liveEnv.activeProcessProgressStep;
    releaseProcessLock();
  }
};

const runtimeStorageApi = createRuntimeStorageApi({
  getStorageDb,
  getFrameDb,
  tryOpenStorageDb,
  rotateStorageEpochDb,
  tryOpenFrameDb,
  closeRuntimeDb,
  closeInfraDb,
  waitForPromiseBeforeTimeout,
  createEmptyEnv,
  replayRecoveryFrameJournals,
});

export const waitForRuntimeProcessingIdle = runtimeStorageApi.waitForRuntimeProcessingIdle;
const getRuntimeProcessGlobal = runtimeStorageApi.getRuntimeProcessGlobal;
export const RuntimeStorageWriteTimeoutError = runtimeStorageApi.RuntimeStorageWriteTimeoutError;
export type RuntimeStorageWriteTimeoutError = InstanceType<typeof RuntimeStorageWriteTimeoutError>;
export const RuntimeFrameStorageError = runtimeStorageApi.RuntimeFrameStorageError;
export type RuntimeFrameStorageError = InstanceType<typeof RuntimeFrameStorageError>;
export const saveEnvToDB = runtimeStorageApi.saveEnvToDB;
export const readPersistedStorageFrameRecord = runtimeStorageApi.readPersistedStorageFrameRecord;
export const listPersistedEntityIdsAtHeight = runtimeStorageApi.listPersistedEntityIdsAtHeight;
export const verifyRuntimeChain = runtimeStorageApi.verifyRuntimeChain;
const resolvePersistedLatestHeight = runtimeStorageApi.resolvePersistedLatestHeight;
const resolvePersistedCheckpointHeights = runtimeStorageApi.resolvePersistedCheckpointHeights;
const loadEnvFromStorageByReplay = runtimeStorageApi.loadEnvFromStorageByReplay;
export const {
  getPersistedLatestHeight,
  loadEntityStateFromStorageDb,
  loadEntityAccountDocFromStorageDb,
  loadEntityViewPageFromStorageDb,
  inspectStorageDb,
  listPersistedCheckpointHeights,
  readPersistedStorageHead,
  verifyLiveRuntimeStorage,
  readPersistedFrameJournal,
  readPersistedRuntimeActivityJournal,
  readPersistedAccountFrameHistory,
  readPersistedEntityFrameHistory,
  readPersistedFrameJournals,
  readPersistedRuntimeActivityPage,
  readPersistedCheckpointSnapshot,
  buildPersistedRuntimeRecording,
  openDetachedRuntimeRecording,
} = createPersistenceQueries({
  tryOpenStorageDb,
  getStorageDb,
  tryOpenFrameDb,
  getFrameDb,
  resolvePersistedLatestHeight,
  resolvePersistedCheckpointHeights,
  readPersistedStorageFrameRecord,
  loadEnvFromStorageByReplay,
  closeRuntimeDb,
  restoreEnvFromRecoveryBundles,
  withStorageConsistentRead,
});

export const loadEnvFromDB = async (
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  options?: {
    fromSnapshotHeight?: number;
    trustedJurisdictionRpcBindings?: readonly TrustedJurisdictionRpcBinding[];
  },
): Promise<Env | null> => {
  try {
    const restored = await loadEnvFromStorageByReplay(
      runtimeId,
      runtimeSeed,
      Number.isFinite(options?.fromSnapshotHeight) ? Math.floor(Number(options?.fromSnapshotHeight)) : undefined,
    );
    const latestEnv = restored?.env ?? null;

    if (latestEnv) {
      // Persisted payloads and retry evidence are verified byte-for-byte by
      // loadEnvFromStorage. Only after that boundary may a new transport
      // session discard stale wall-clock deadlines and retry reliable heads.
      markRestoredReliableOutputsDue(latestEnv);
      await rehydrateRestoredRuntimeInfra(latestEnv, {
        isBrowser: runtimeIsBrowser,
        loadGossipProfiles: targetEnv => loadGossipProfilesFromInfraDb(targetEnv, infraGossipDbAccess),
        assertPersistedContractConfigReady,
        setBrowserVMJurisdiction,
        ...(options?.trustedJurisdictionRpcBindings
          ? { trustedJurisdictionRpcBindings: options.trustedJurisdictionRpcBindings }
          : {}),
      });
      registerCommittedSingleSignerWallets(latestEnv);
    }

    return latestEnv;
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    runtimeLog.error('load_env_from_db.failed', { error: message });
    throw err;
  }
};

export const clearDB = async (env?: Env): Promise<void> => {
  const targetEnv = env ?? createEmptyEnv(null);

  if (!runtimeIsBrowser && nodeProcess) {
    try {
      await closeRuntimeDb(targetEnv);
      await closeInfraDb(targetEnv);
      const fs = await import('fs/promises');
      await fs.rm(dbRootPath, { recursive: true, force: true });
      await fs.mkdir(dbRootPath, { recursive: true });
      runtimeLog.info('db.clear_root_complete', { path: dbRootPath });
    } catch (err) {
      runtimeLog.error('db.clear_root_failed', {
        path: dbRootPath,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    return;
  }

  if (!runtimeIsBrowser) return;

  try {
    const infraReady = await tryOpenInfraDb(targetEnv);
    const storageReady = await tryOpenStorageDb(targetEnv, 'current');
    const storagePreviousReady = await tryOpenStorageDb(targetEnv, 'previous');
    const frameReady = await tryOpenFrameDb(targetEnv);
    if (infraReady) {
      const infraDb = getInfraDb(targetEnv);
      await infraDb.clear();
    }
    if (storageReady) {
      const storageDb = getStorageDb(targetEnv, 'current');
      await storageDb.clear();
    }
    if (storagePreviousReady) {
      const previousStorageDb = getStorageDb(targetEnv, 'previous');
      await previousStorageDb.clear();
    }
    if (frameReady) {
      const frameDb = getFrameDb(targetEnv);
      await frameDb.clear();
    }
    runtimeLog.info('db.clear_complete');
  } catch (err) {
    runtimeLog.error('db.clear_failed', { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
};

const runtimeCommandApi = createRuntimeCommandApi({
  getP2P,
  getRuntimeOutputRoutingDeps,
});

export const submitCrossJurisdictionIntent = runtimeCommandApi.submitCrossJurisdictionIntent;
export const submitCrossJurisdictionSwap = runtimeCommandApi.submitCrossJurisdictionSwap;
