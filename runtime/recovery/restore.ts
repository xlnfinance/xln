import { Level } from 'level';
import { ethers } from 'ethers';
import { nodeProcess, runtimeIsBrowser } from '../machine/platform';
import {
  cloneIsolatedRoutedEntityInputs,
  cloneIsolatedRuntimeInput,
  cloneIsolatedRuntimeSnapshot,
} from './../protocol/runtime-input-clone';
import { requireBoundaryInteger } from './../protocol/boundary-validation';
import { requireDurableJurisdictionStack } from './../jurisdiction/contract-address';
import {
  buildDurableRuntimeMachineSnapshot,
  buildReplayVerifiableRuntimeMachineSnapshot,
  authorizeRestoredRuntimeInput,
  normalizePersistedSnapshotInPlace,
  projectReplayVerifiableRuntimeMachine,
  restoreDurableRuntimeSnapshot,
} from './../wal/snapshot';
import { setBrowserVMJurisdiction } from './../jadapter';
import {
  assertCertifiedBoardRootsAvailable,
  collectReachableCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
} from './../jurisdiction/board-registry';
import {
  assertConsumptionRootsAvailable,
  collectReachableConsumptionNodes,
  getConsumptionNodeStore,
  getLiveConsumptionAccumulatorStates,
} from './../entity/consumption-store';
import { collectReachableAccountJClaimNodes } from './../account/j-claim-accumulator';
import {
  assertAccountJClaimRootsAvailable,
  getAccountJClaimNodeStore,
  getLiveAccountJClaimAccumulatorStates,
} from './../account/j-claim-store';
import { clearPendingAuditEvents, dropPendingFrameDbRecords, peekPendingFrameDbRecords } from '../machine/env-events';
import { getCachedSignerPrivateKey, getLocalSignerPrivateKey } from './../account/crypto';
import type { Profile } from './../networking/gossip';
import { normalizeRuntimeId } from './../networking/runtime-id';
import {
  buildPendingNetworkOutputs,
  getReliableOutputIdentity,
  markRestoredReliableOutputsDue,
  planEntityOutputs,
  pruneReceiptedReliableOutputs,
  splitRoutedOutputByDeliveryLane,
  splitPendingOutputsByRetryWindow,
  type RuntimeOutputRoutingDeps,
} from '../machine/output-routing';
import { refreshScheduledWakeIndex } from '../machine/scheduled-wake';
import { ensureRuntimeState } from '../machine/runtime-state';
import {
  applyReliableDeliveryReceipts,
  finalizeReliableIngressCommit,
  registerReliableIngress,
  registerReliableReceiptIngress,
  matchReceiptsToOutputs,
  type ReliableIngressCommit,
} from '../machine/reliable-delivery';
import { restoreDurableOutputRetryState } from '../machine/durable-output-retry';
import { registerPendingCommittedJOutbox, splitJOutboxForDurableSubmit } from '../machine/j-submit-state';
import { clearReplayOutputSignerHints, installReplayOutputSignerHints } from './../state-helpers';
import { safeStringify } from './../protocol/serialization';
import {
  canonicalizeStorageAuditValue,
  computeCanonicalEntityHash,
  computeCanonicalRuntimeStateHash,
  computeCanonicalStateHashFromEnv,
} from './../storage/canonical-hash';
import {
  applyCertifiedEntityLineagePlan,
  buildCertifiedEntityLineagePlan,
  buildRuntimeCheckpointLineagePlan,
} from './../storage/entity-lineage';
import { assertCertifiedRegistrationEvidenceStore } from './../jurisdiction/registration-evidence';
import { computeStoragePostStateHash, replaceRestoredStorageBase } from './../storage';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  DEFAULT_EPOCH_MAX_BYTES,
  DEFAULT_RETAIN_SNAPSHOTS,
  DEFAULT_SNAPSHOT_PERIOD_FRAMES,
  STORAGE_SCHEMA_VERSION,
} from './../storage/keys';
import { hydrateEntityStateFromStorage, projectAccountDoc, projectEntityCoreDoc } from './../storage/projections';
import {
  buildStorageLiveReplicaMetaCommitment,
  buildStorageReplicaMetaCommitment,
  buildStorageReplicaMetaCommitmentFromCheckpointPlan,
  inspectStorageReplicaMetaEntries,
  summarizeStorageReplicaMetaEntries,
  summarizeStorageReplicaMetaFields,
  summarizeStorageReplicaMetaHeads,
} from './../storage/replicas';
import type { StorageDoc, StoragePersistenceBoundaryHook } from './../storage/types';
import {
  assertCertifiedJHistoryIntegrity,
  assertValidatorJHistoryMatchesCertifiedAnchor,
} from './../jurisdiction/local-history';
import type { EntityReplica, Env, JReplica, ReliableDeliveryReceipt, RoutedEntityInput, RuntimeTx } from './../types';
import { clearDatabase } from './../utils';
import type { PersistedFrameJournal } from './../storage/types';
import { assertRuntimeRecoveryBundleAuthenticity } from './../recovery/bundle';
import type { RuntimeRecoveryBundleV1 } from './../recovery/types';
import { ensureLiveJAdapterForReplica, rehydrateRestoredRuntimeInfra } from '../machine/infra';
import { findWatcherJurisdictionReplica } from './../jadapter/helpers';
import { loadGossipProfilesFromInfraDb } from '../machine/infra-gossip-store';
import { normalizeDbNamespace, type StorageDbRole, withStorageWriterLock } from './../storage/runtime-dbs';
import { createStructuredLogger } from '../infra/logger';

type RuntimeModule = typeof import('../runtime');

export type RuntimeRecoveryDeps = Pick<
  RuntimeModule,
  'closeRuntimeDb' | 'closeInfraDb' | 'startJurisdictionWatchers'
> & {
  ensureRuntimeConfig(env: Env): NonNullable<Env['runtimeConfig']>;
  createEmptyEnv: RuntimeModule['createEmptyEnv'];
  getStorageDb(env: Env, role?: StorageDbRole): Level<Buffer, Buffer>;
  getFrameDb(env: Env): Level<Buffer, Buffer>;
  tryOpenStorageDb(env: Env, role?: StorageDbRole): Promise<boolean>;
  tryOpenFrameDb(env: Env): Promise<boolean>;
  enqueueRuntimeContinuation(
    env: Env,
    inputs?: import('../types').EntityInput[],
    runtimeTxs?: RuntimeTx[],
    jInputs?: import('../types').JInput[],
    explicitTimestamp?: number,
    reliableReceipts?: ReliableDeliveryReceipt[],
  ): void;
  infraGossipDbAccess: Parameters<typeof loadGossipProfilesFromInfraDb>[1];
  generateHookPings(env: Env, nowMs?: number, queuedAt?: number): void;
  getRuntimeOutputRoutingDeps(): RuntimeOutputRoutingDeps;
  applyRuntimeInput: RuntimeModule['applyRuntimeInput'];
};

const ENV_APPLY_ALLOWED_KEY = Symbol.for('xln.runtime.env.apply.allowed');
const ENV_REPLAY_MODE_KEY = Symbol.for('xln.runtime.env.replay.mode');
const envRecord = (env: Env): Record<PropertyKey, unknown> => env as unknown as Record<PropertyKey, unknown>;
const runtimeLog = createStructuredLogger('runtime');

export const createRuntimeRecoveryApi = (deps: RuntimeRecoveryDeps) => {
  const {
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
  } = deps;

  const normalizeCheckpointReplicaMap = (raw: unknown): Map<string, unknown> => {
    if (raw instanceof Map) return new Map(raw.entries());
    if (!Array.isArray(raw)) return new Map();
    return new Map(
      raw
        .filter((entry): entry is [string, unknown] => Array.isArray(entry) && entry.length >= 2)
        .map(([key, value]) => [String(key), value]),
    );
  };

  // Recovery bundles deliberately reuse the canonical checkpoint snapshot. That keeps
  // the restore path aligned with the storage replay oracle instead of inventing a
  // second persistence format that would drift over time.
  const restoreEnvFromCheckpointSnapshot = async (
    snapshot: Record<string, unknown>,
    options?: {
      runtimeSeed?: string | null;
      runtimeId?: string | null;
      readOnly?: boolean;
    },
  ): Promise<Env> => {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('RECOVERY_CHECKPOINT_INVALID');
    }

    const normalizedSnapshot = cloneIsolatedRuntimeSnapshot(snapshot);
    normalizePersistedSnapshotInPlace(normalizedSnapshot, {
      normalizeReplicaMap: normalizeCheckpointReplicaMap,
      normalizeJReplicaMap: normalizeCheckpointReplicaMap,
    });

    const snapshotRuntimeSeed =
      typeof normalizedSnapshot['runtimeSeed'] === 'string' ? normalizedSnapshot['runtimeSeed'] : null;
    const runtimeSeed = options?.runtimeSeed !== undefined ? options.runtimeSeed : snapshotRuntimeSeed;
    const env = createEmptyEnv(runtimeSeed ?? null);

    const snapshotRuntimeId = normalizeRuntimeId(
      options?.runtimeId ?? String(normalizedSnapshot['runtimeId'] || env.runtimeId || ''),
    );
    if (!snapshotRuntimeId) {
      throw new Error('RECOVERY_CHECKPOINT_RUNTIME_ID_REQUIRED');
    }

    env.runtimeId = snapshotRuntimeId;
    env.dbNamespace = normalizeDbNamespace(snapshotRuntimeId);
    env.height = requireBoundaryInteger(normalizedSnapshot['height'], 'RECOVERY_CHECKPOINT_HEIGHT_INVALID');
    env.timestamp = requireBoundaryInteger(normalizedSnapshot['timestamp'], 'RECOVERY_CHECKPOINT_TIMESTAMP_INVALID');
    env.eReplicas =
      normalizedSnapshot['eReplicas'] instanceof Map
        ? new Map(
            Array.from(normalizedSnapshot['eReplicas'].entries()).map(([key, value]) => [String(key), value as never]),
          )
        : new Map();
    env.jReplicas =
      normalizedSnapshot['jReplicas'] instanceof Map
        ? new Map(
            Array.from(normalizedSnapshot['jReplicas'].entries()).map(([key, value]) => [String(key), value as never]),
          )
        : new Map();
    env.activeJurisdiction =
      typeof normalizedSnapshot['activeJurisdiction'] === 'string'
        ? String(normalizedSnapshot['activeJurisdiction'])
        : env.activeJurisdiction;
    const browserVMState = normalizedSnapshot['browserVMState'];
    if (browserVMState !== undefined) {
      Object.assign(env, {
        browserVMState: structuredClone(browserVMState) as Env['browserVMState'],
      });
    }
    const snapshotGossip =
      normalizedSnapshot['gossip'] && typeof normalizedSnapshot['gossip'] === 'object'
        ? (normalizedSnapshot['gossip'] as { profiles?: unknown })
        : null;
    const snapshotGossipProfiles = Array.isArray(snapshotGossip?.profiles)
      ? (snapshotGossip.profiles as Profile[])
      : [];
    env.runtimeInput = { runtimeTxs: [], entityInputs: [] };
    env.frameLogs = [];
    env.networkInbox = [];
    env.pendingNetworkOutputs = [];
    env.overlay = [];
    restoreDurableRuntimeSnapshot(env, normalizedSnapshot);
    for (const replica of env.eReplicas.values()) {
      assertCertifiedJHistoryIntegrity(replica.state);
      assertValidatorJHistoryMatchesCertifiedAnchor(replica.state, replica.jHistory);
    }
    assertCertifiedBoardRootsAvailable(env);
    assertConsumptionRootsAvailable(env);
    assertAccountJClaimRootsAvailable(env);
    await assertCertifiedRegistrationEvidenceStore(env);

    if (!options?.readOnly) {
      await rehydrateRestoredRuntimeInfra(env, {
        isBrowser: runtimeIsBrowser,
        loadGossipProfiles: targetEnv => loadGossipProfilesFromInfraDb(targetEnv, infraGossipDbAccess),
        assertPersistedContractConfigReady,
        setBrowserVMJurisdiction,
      });
    }
    registerCommittedSingleSignerWallets(env);
    for (const profile of snapshotGossipProfiles) {
      env.gossip?.announce?.(profile);
    }

    return env;
  };

  const normalizeEmptyRecoveryIngressState = (machine: Record<string, unknown>): Record<string, unknown> => {
    const runtimeState = machine['runtimeState'];
    if (!runtimeState || typeof runtimeState !== 'object') return machine;
    const normalizedState = { ...(runtimeState as Record<string, unknown>) };
    for (const key of ['pendingReliableIngress', 'reliableIngressCommitting'] as const) {
      const value = normalizedState[key];
      if ((value instanceof Map || value instanceof Set) && value.size === 0) delete normalizedState[key];
    }
    const normalized = { ...machine };
    if (Object.keys(normalizedState).length > 0) normalized['runtimeState'] = normalizedState;
    else delete normalized['runtimeState'];
    return normalized;
  };

  const canonicalRecoveryMachine = (machine: Record<string, unknown>): string =>
    safeStringify(canonicalizeStorageAuditValue(normalizeEmptyRecoveryIngressState(machine)));

  const recoveryMachineMismatchFields = (
    expected: Record<string, unknown>,
    actual: Record<string, unknown>,
  ): string[] => {
    const fields = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const mismatches: string[] = [];
    for (const field of [...fields].sort()) {
      const expectedHasField = Object.prototype.hasOwnProperty.call(expected, field);
      const actualHasField = Object.prototype.hasOwnProperty.call(actual, field);
      if (expectedHasField !== actualHasField) {
        mismatches.push(field);
        continue;
      }
      if (canonicalRecoveryMachine({ value: expected[field] }) === canonicalRecoveryMachine({ value: actual[field] }))
        continue;
      if (field !== 'runtimeState') {
        mismatches.push(field);
        continue;
      }
      const expectedState =
        expected[field] && typeof expected[field] === 'object' ? (expected[field] as Record<string, unknown>) : {};
      const actualState =
        actual[field] && typeof actual[field] === 'object' ? (actual[field] as Record<string, unknown>) : {};
      const stateFields = new Set([...Object.keys(expectedState), ...Object.keys(actualState)]);
      for (const stateField of [...stateFields].sort()) {
        const expectedHasStateField = Object.prototype.hasOwnProperty.call(expectedState, stateField);
        const actualHasStateField = Object.prototype.hasOwnProperty.call(actualState, stateField);
        if (expectedHasStateField !== actualHasStateField) {
          mismatches.push(`runtimeState.${stateField}`);
          continue;
        }
        if (
          canonicalRecoveryMachine({ value: expectedState[stateField] }) !==
          canonicalRecoveryMachine({ value: actualState[stateField] })
        ) {
          mismatches.push(`runtimeState.${stateField}`);
        }
      }
    }
    return mismatches;
  };

  const readRecoveryMachineField = (machine: Record<string, unknown>, field: string): unknown => {
    if (!field.startsWith('runtimeState.')) return machine[field];
    const runtimeState = machine['runtimeState'];
    if (!runtimeState || typeof runtimeState !== 'object') return undefined;
    return (runtimeState as Record<string, unknown>)[field.slice('runtimeState.'.length)];
  };

  const assertRecoveryRuntimeMachineMatches = (
    env: Env,
    expectedMachine: Record<string, unknown>,
    height: number,
    options?: { includeIngressWorkingState?: boolean },
  ): void => {
    const actualMachine = buildReplayVerifiableRuntimeMachineSnapshot(env, {
      includeIngressWorkingState: options?.includeIngressWorkingState === true,
    });
    const expectedReplayMachine = projectReplayVerifiableRuntimeMachine(expectedMachine);
    const actual = canonicalRecoveryMachine(actualMachine);
    const expected = canonicalRecoveryMachine(expectedReplayMachine);
    if (actual !== expected) {
      const expectedHash = ethers.keccak256(ethers.toUtf8Bytes(expected));
      const actualHash = ethers.keccak256(ethers.toUtf8Bytes(actual));
      const mismatchFields = recoveryMachineMismatchFields(expectedReplayMachine, actualMachine);
      const firstField = mismatchFields[0] || 'unknown';
      const expectedValue = readRecoveryMachineField(expectedReplayMachine, firstField);
      const actualValue = readRecoveryMachineField(actualMachine, firstField);
      const detail = canonicalRecoveryMachine({
        actual: actualValue === undefined ? { present: false } : { present: true, value: actualValue },
        expected: expectedValue === undefined ? { present: false } : { present: true, value: expectedValue },
      }).slice(0, 5_000);
      throw new Error(
        `RECOVERY_JOURNAL_RUNTIME_MACHINE_MISMATCH:height=${height}:` +
          `fields=${mismatchFields.join(',') || 'unknown'}:` +
          `expected=${expectedHash}:actual=${actualHash}:detail=${detail}`,
      );
    }
  };

  const replayRecoveryFrameJournals = async (env: Env, frames: PersistedFrameJournal[]): Promise<void> => {
    // Live process() normalizes operational defaults before every reducer pass;
    // replay must enter the reducer with the same deterministic configuration.
    ensureRuntimeConfig(env);
    const previousReplayMode = envRecord(env)[ENV_REPLAY_MODE_KEY];
    envRecord(env)[ENV_REPLAY_MODE_KEY] = true;
    try {
      let expectedHeight = requireBoundaryInteger(
        requireBoundaryInteger(env.height, 'RECOVERY_JOURNAL_BASE_HEIGHT_INVALID') + 1,
        'RECOVERY_JOURNAL_HEIGHT_OVERFLOW',
      );
      for (const frame of frames) {
        const frameHeight = requireBoundaryInteger(frame.height, 'RECOVERY_JOURNAL_HEIGHT_INVALID');
        if (frameHeight !== expectedHeight) {
          throw new Error(`RECOVERY_JOURNAL_REPLAY_GAP: expected=${expectedHeight} actual=${frameHeight}`);
        }
        if (!/^0x[0-9a-f]{64}$/i.test(String(frame.replicaMetaDigest ?? ''))) {
          throw new Error(`RECOVERY_JOURNAL_REPLICA_META_DIGEST_MISSING:height=${frameHeight}`);
        }
        if (!/^0x[0-9a-f]{64}$/i.test(String(frame.postStateHash ?? ''))) {
          throw new Error(`RECOVERY_JOURNAL_POST_STATE_HASH_MISSING:height=${frameHeight}`);
        }
        env.timestamp = requireBoundaryInteger(
          frame.timestamp,
          `RECOVERY_JOURNAL_TIMESTAMP_INVALID:height=${frameHeight}`,
        );
        const outputSignerHints = new Map<string, string>();
        for (const output of frame.runtimeOutputs ?? []) {
          const carriesAccountInput = (output.entityTxs ?? []).some(
            tx =>
              tx.type === 'accountInput' ||
              (tx.type === 'consensusOutput' && tx.data.entityTxs.some(inner => inner.type === 'accountInput')),
          );
          if (!carriesAccountInput) continue;
          const entityId = String(output.entityId || '')
            .trim()
            .toLowerCase();
          const signerId = String(output.signerId || '')
            .trim()
            .toLowerCase();
          if (!entityId || !signerId) {
            throw new Error(`RECOVERY_OUTPUT_SIGNER_HINT_INVALID:height=${frameHeight}`);
          }
          const existing = outputSignerHints.get(entityId);
          if (existing && existing !== signerId) {
            throw new Error(
              `RECOVERY_OUTPUT_SIGNER_HINT_CONFLICT:height=${frameHeight}:` +
                `entity=${entityId}:left=${existing}:right=${signerId}`,
            );
          }
          outputSignerHints.set(entityId, signerId);
        }
        installReplayOutputSignerHints(env, outputSignerHints);
        envRecord(env)[ENV_APPLY_ALLOWED_KEY] = true;
        try {
          if (nodeProcess?.env?.['XLN_STORAGE_DEBUG_REPLICA_META'] === '1') {
            runtimeLog.info('recovery.replica_meta.pre', {
              height: frameHeight,
              consumptionNodes: getConsumptionNodeStore(env).size,
              consumptionRoots: [...env.eReplicas.values()].map(replica => ({
                entityId: replica.entityId,
                root: replica.state.consumptionAccumulator?.root ?? null,
                count: replica.state.consumptionAccumulator?.count?.toString() ?? null,
                mempool: replica.mempool.map(tx =>
                  tx.type === 'consensusOutput'
                    ? `consensusOutput:${tx.data.origin.sourceEntityId}:${tx.data.origin.sequence.toString()}`
                    : tx.type,
                ),
              })),
            });
          }
          const replayResult = await applyRuntimeInput(env, frame.runtimeInput ?? { runtimeTxs: [], entityInputs: [] });
          const splitJOutbox = splitJOutboxForDurableSubmit(replayResult.jOutbox);
          registerPendingCommittedJOutbox(env, splitJOutbox.durable);
          refreshScheduledWakeIndex(
            env,
            new Set(replayResult.appliedRuntimeInput.entityInputs.map(input => input.entityId.toLowerCase())),
          );
          applyDeterministicRuntimeOutputPlan(env, replayResult.entityOutbox, getRuntimeOutputRoutingDeps());
          generateHookPings(env);
          const replayFrameDbRecords = peekPendingFrameDbRecords(env, env.height, env.timestamp);
          finalizeReliableIngressCommit(env, replayResult.reliableIngressCommits);
          // Audit events are flushed only after the live WAL commit and are not
          // consensus/recovery state. Replay must neither retain nor re-emit them.
          clearPendingAuditEvents(env);
          env.runtimeMempool = frame.pendingRuntimeInput
            ? authorizeRestoredRuntimeInput(cloneIsolatedRuntimeInput(frame.pendingRuntimeInput))
            : undefined;
          env.runtimeInput = env.runtimeMempool ?? { runtimeTxs: [], entityInputs: [] };
          env.pendingNetworkOutputs = cloneIsolatedRoutedEntityInputs(frame.runtimeOutputs ?? []);
          restoreDurableOutputRetryState(env, frame.runtimeOutputRetryState ?? [], frame.runtimeOutputs ?? []);
          // These activity records were consumed by the same atomic storage
          // batch as the Runtime frame. Compare the committed post-state, not
          // the writer's pre-commit buffer.
          dropPendingFrameDbRecords(env, replayFrameDbRecords.length);
          // A sparse checkpoint gives a field-level diagnostic; use it before
          // the compact replica digest so recovery failures name the root cause.
          if (frame.runtimeMachine) {
            assertRecoveryRuntimeMachineMatches(env, frame.runtimeMachine, frameHeight);
          }
          // Rebuild the exact compact checkpoint shape used by the writer.
          // The generic rebase helper intentionally retains the latest lineage
          // link, while materialized Runtime checkpoints replace that link with
          // a local endpoint anchor. Mixing the two encodings makes identical
          // replay state fail its replica-meta digest at a checkpoint boundary.
          const replayCheckpointLineagePlan = frame.replicaMetaCheckpoint
            ? buildRuntimeCheckpointLineagePlan(env)
            : null;
          const actualReplicaMetaCommitment = replayCheckpointLineagePlan
            ? buildStorageReplicaMetaCommitmentFromCheckpointPlan(env, replayCheckpointLineagePlan, {
                omitIntermediateSingleSignerState: frame.replicaMetaStateMode === 'shared-entity-state',
              })
            : buildStorageLiveReplicaMetaCommitment(env);
          const actualReplicaMetaDigest = actualReplicaMetaCommitment.digest;
          if (actualReplicaMetaDigest !== frame.replicaMetaDigest) {
            const inputSummary = frame.runtimeInput.entityInputs.map(input => ({
              entityId: input.entityId,
              signerId: input.signerId,
              entityTxs: input.entityTxs?.map(tx => tx.type) ?? [],
              proposalHeight: input.proposedFrame?.height ?? null,
              hashPrecommits: input.hashPrecommits?.size ?? 0,
              hasSignerKey: input.signerId ? getCachedSignerPrivateKey(env, input.signerId) !== null : false,
            }));
            const appliedInputSummary = replayResult.appliedRuntimeInput.entityInputs.map(input => ({
              entityId: input.entityId,
              entityTxs: input.entityTxs?.map(tx => tx.type) ?? [],
              proposalHeight: input.proposedFrame?.height ?? null,
            }));
            throw new Error(
              `RECOVERY_JOURNAL_REPLICA_META_DIGEST_MISMATCH:height=${frameHeight}:` +
                `expected=${frame.replicaMetaDigest}:actual=${actualReplicaMetaDigest}:` +
                `actualEntries=${safeStringify(summarizeStorageReplicaMetaEntries(actualReplicaMetaCommitment.entries))}:` +
                `actualFields=${safeStringify(summarizeStorageReplicaMetaFields(actualReplicaMetaCommitment.entries))}:` +
                `actualHeads=${safeStringify(summarizeStorageReplicaMetaHeads(actualReplicaMetaCommitment.entries))}:` +
                `runtimeInput=${safeStringify(inputSummary)}:` +
                `appliedInput=${safeStringify(appliedInputSummary)}:` +
                `entityOutbox=${safeStringify(replayResult.entityOutbox.map(output => ({ entityId: output.entityId, txs: output.entityTxs?.map(tx => tx.type) ?? [] })))}:` +
                `actualMeta=${safeStringify(inspectStorageReplicaMetaEntries(actualReplicaMetaCommitment.entries)).slice(0, 8_000)}`,
            );
          }
          const actualPostStateHash = computeStoragePostStateHash({
            height: frameHeight,
            timestamp: env.timestamp,
            replicaMetaDigest: actualReplicaMetaDigest,
            runtimeMachine: buildReplayVerifiableRuntimeMachineSnapshot(env, {
              pendingNetworkOutputs: env.pendingNetworkOutputs ?? [],
              excludePersistedFrameDbRecords: true,
            }),
          });
          if (actualPostStateHash !== frame.postStateHash) {
            throw new Error(
              `RECOVERY_JOURNAL_POST_STATE_HASH_MISMATCH:height=${frameHeight}:` +
                `expected=${frame.postStateHash}:actual=${actualPostStateHash}`,
            );
          }
          if (frame.runtimeStateHash) {
            const actualStateHash = computeCanonicalStateHashFromEnv(env);
            if (actualStateHash !== frame.runtimeStateHash) {
              throw new Error(
                `RECOVERY_JOURNAL_STATE_HASH_MISMATCH:height=${frameHeight}:` +
                  `expected=${frame.runtimeStateHash}:actual=${actualStateHash}`,
              );
            }
          }
          if (replayCheckpointLineagePlan) {
            applyCertifiedEntityLineagePlan(env, replayCheckpointLineagePlan);
          }
        } finally {
          clearReplayOutputSignerHints(env);
          envRecord(env)[ENV_APPLY_ALLOWED_KEY] = false;
        }
        if (env.height !== frameHeight) {
          throw new Error(`RECOVERY_JOURNAL_REPLAY_HEIGHT_MISMATCH: expected=${frameHeight} actual=${env.height}`);
        }
        expectedHeight = requireBoundaryInteger(expectedHeight + 1, 'RECOVERY_JOURNAL_HEIGHT_OVERFLOW');
      }
    } finally {
      if (previousReplayMode === undefined) delete envRecord(env)[ENV_REPLAY_MODE_KEY];
      else envRecord(env)[ENV_REPLAY_MODE_KEY] = previousReplayMode;
      envRecord(env)[ENV_APPLY_ALLOWED_KEY] = false;
    }
  };

  const failRecoveryRestoreAfterCleanup = async (env: Env, error: unknown): Promise<never> => {
    const originalError = error instanceof Error ? error : new Error(String(error));
    const cleanup = await Promise.allSettled([closeRuntimeDb(env), closeInfraDb(env)]);
    const cleanupErrors = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => (result.reason instanceof Error ? result.reason : new Error(String(result.reason))));
    if (cleanupErrors.length > 0) {
      throw new AggregateError([originalError, ...cleanupErrors], 'RECOVERY_RESTORE_FAILED_WITH_CLEANUP_ERRORS');
    }
    throw originalError;
  };

  const restoreEnvFromRecoveryBundles = async (
    bundles: RuntimeRecoveryBundleV1[],
    options?: {
      runtimeSeed?: string | null;
      runtimeId?: string | null;
      targetHeight?: number;
      readOnly?: boolean;
    },
  ): Promise<Env> => {
    const trustedRuntimeSeed = options?.runtimeSeed;
    if (!trustedRuntimeSeed) throw new Error('RECOVERY_BUNDLE_TRUSTED_SEED_REQUIRED');
    const validated = (bundles || []).map(bundle =>
      assertRuntimeRecoveryBundleAuthenticity(bundle, trustedRuntimeSeed, options?.runtimeId),
    );
    const snapshots = validated.filter(bundle => (bundle.kind ?? 'snapshot') === 'snapshot');
    if (snapshots.length === 0) {
      throw new Error('RECOVERY_BUNDLE_SNAPSHOT_REQUIRED');
    }
    const requestedTarget = options?.targetHeight;
    if (requestedTarget !== undefined && (!Number.isSafeInteger(requestedTarget) || requestedTarget < 0)) {
      throw new Error(`RECOVERY_BUNDLE_TARGET_HEIGHT_INVALID:${String(requestedTarget)}`);
    }
    const candidates = snapshots
      .flatMap(snapshot => {
        if (requestedTarget !== undefined && snapshot.runtimeHeight > requestedTarget) return [];
        const snapshotHash = String(snapshot.checkpointHash || '').toLowerCase();
        const tail = validated
          .filter(
            bundle =>
              bundle.kind === 'journal_tail' &&
              bundle.baseRuntimeHeight === snapshot.runtimeHeight &&
              String(bundle.baseCheckpointHash || '').toLowerCase() === snapshotHash &&
              bundle.runtimeHeight > snapshot.runtimeHeight,
          )
          .filter(bundle => requestedTarget === undefined || bundle.runtimeHeight >= requestedTarget)
          .sort((left, right) => right.runtimeHeight - left.runtimeHeight)[0];
        if (requestedTarget !== undefined && snapshot.runtimeHeight < requestedTarget && !tail) return [];
        return {
          snapshot,
          tail,
          height: requestedTarget ?? tail?.runtimeHeight ?? snapshot.runtimeHeight,
        };
      })
      .sort((left, right) => {
        if (right.height !== left.height) return right.height - left.height;
        return right.snapshot.runtimeHeight - left.snapshot.runtimeHeight;
      });
    if (candidates.length === 0) {
      throw new Error(`RECOVERY_BUNDLE_TARGET_HEIGHT_UNAVAILABLE:${String(requestedTarget)}`);
    }
    const best = candidates[0]!;
    const env = await restoreEnvFromCheckpointSnapshot(best.snapshot.checkpoint!, options);
    if (best.tail && best.height > best.snapshot.runtimeHeight) {
      try {
        await replayRecoveryFrameJournals(
          env,
          (best.tail.frames || []).filter(frame => frame.height <= best.height),
        );
      } catch (error) {
        if (options?.readOnly) throw error;
        return failRecoveryRestoreAfterCleanup(env, error);
      }
    }
    if (env.height !== best.height) {
      const mismatch = new Error(`RECOVERY_BUNDLE_TARGET_HEIGHT_MISMATCH:expected=${best.height}:actual=${env.height}`);
      if (options?.readOnly) throw mismatch;
      return failRecoveryRestoreAfterCleanup(env, mismatch);
    }
    if (!options?.readOnly) markRestoredReliableOutputsDue(env);
    return env;
  };

  const collectCertifiedStorageDocs = (
    lineagePlan: ReturnType<typeof buildCertifiedEntityLineagePlan>,
  ): { docs: StorageDoc[]; canonicalEntityHashes: ReturnType<typeof computeCanonicalEntityHash>[] } => {
    const docs: StorageDoc[] = [];
    const canonicalEntityHashes: ReturnType<typeof computeCanonicalEntityHash>[] = [];

    for (const [entityId, selected] of lineagePlan.lookup.entries()) {
      const core = projectEntityCoreDoc(selected.state);
      const accounts = new Map(
        Array.from(
          selected.state.accounts.entries(),
          ([counterpartyId, account]) =>
            [String(counterpartyId || '').toLowerCase(), projectAccountDoc(account)] as const,
        ),
      );
      const books = new Map(
        Array.from(
          selected.state.orderbookExt?.books?.entries?.() ?? [],
          ([pairId, book]) => [String(pairId || '').trim(), book] as const,
        ),
      );
      const projectedState = hydrateEntityStateFromStorage({ core, accounts, books });
      const expectedHash = computeCanonicalEntityHash(selected.replica);
      const projectedHash = computeCanonicalEntityHash({ ...selected.replica, state: projectedState });
      if (projectedHash.hash !== expectedHash.hash) {
        throw new Error(
          `RECOVERY_IMPORT_PROJECTED_ENTITY_HASH_MISMATCH:entity=${entityId}:` +
            `expected=${expectedHash.hash}:projected=${projectedHash.hash}`,
        );
      }
      canonicalEntityHashes.push(expectedHash);
      docs.push({ family: 'entity', entityId, value: core });

      for (const [counterpartyId, account] of accounts.entries()) {
        const normalizedCounterparty = String(counterpartyId || '').toLowerCase();
        if (!normalizedCounterparty || !account) continue;
        docs.push({
          family: 'account',
          entityId,
          counterpartyId: normalizedCounterparty,
          value: account,
        });
      }

      for (const [pairId, book] of books.entries()) {
        const normalizedPairId = String(pairId || '').trim();
        if (!normalizedPairId || !book) continue;
        docs.push({
          family: 'book',
          entityId,
          pairId: normalizedPairId,
          value: book,
        });
      }
    }

    return { docs, canonicalEntityHashes };
  };

  // Recovery checkpoint imports are not an append to the local WAL. They seed a new
  // local persistence base at the recovered runtime height, anchored by a materialized
  // snapshot and a synthetic frame at that same height.
  const persistRestoredEnvToDBUnlocked = async (
    env: Env,
    options: { onPersistenceBoundary?: StoragePersistenceBoundaryHook } = {},
  ): Promise<void> => {
    const restoredHeight = Number(env.height);
    const restoredTimestamp = Number(env.timestamp);
    if (!Number.isSafeInteger(restoredHeight) || restoredHeight <= 0) {
      throw new Error('RECOVERY_PERSIST_HEIGHT_REQUIRED');
    }
    if (!Number.isSafeInteger(restoredTimestamp) || restoredTimestamp < 0) {
      throw new Error('RECOVERY_PERSIST_TIMESTAMP_INVALID');
    }
    for (const replica of env.eReplicas.values()) {
      assertCertifiedJHistoryIntegrity(replica.state);
      assertValidatorJHistoryMatchesCertifiedAnchor(replica.state, replica.jHistory);
    }
    const lineagePlan = buildCertifiedEntityLineagePlan(env);
    const materialized = collectCertifiedStorageDocs(lineagePlan);
    const certifiedBoardNodes = collectReachableCertifiedBoardNodes(
      getCertifiedBoardNodeStore(env),
      Array.from(env.eReplicas.values(), ({ state }) => state.certifiedBoardState?.boardRegistryRoot).filter(
        (root): root is string => Boolean(root),
      ),
    );
    const consumptionNodes = collectReachableConsumptionNodes(
      getConsumptionNodeStore(env),
      getLiveConsumptionAccumulatorStates(env),
    );
    const accountJClaimNodes = collectReachableAccountJClaimNodes(
      getAccountJClaimNodeStore(env),
      getLiveAccountJClaimAccumulatorStates(env),
    );
    const runtimeMachine = buildDurableRuntimeMachineSnapshot(env);
    const canonicalStateHash = computeCanonicalRuntimeStateHash(
      restoredHeight,
      restoredTimestamp,
      materialized.canonicalEntityHashes,
      runtimeMachine,
    );

    if (!(await tryOpenStorageDb(env, 'current'))) {
      throw new Error('RECOVERY_PERSIST_STORAGE_OPEN_FAILED');
    }
    if (!(await tryOpenFrameDb(env))) {
      throw new Error('RECOVERY_PERSIST_FRAME_DB_OPEN_FAILED');
    }

    const currentDb = getStorageDb(env, 'current');
    const frameDb = getFrameDb(env);
    const puts = materialized.docs;
    const replicaMetas = buildStorageReplicaMetaCommitment(env, lineagePlan).entries;
    const replacement = await replaceRestoredStorageBase({
      currentDb,
      historyDb: frameDb,
      height: restoredHeight,
      timestamp: restoredTimestamp,
      docs: puts,
      replicaMetas,
      headConfig: {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        snapshotPeriodFrames: Math.max(
          1,
          Number(env.runtimeConfig?.storage?.snapshotPeriodFrames ?? DEFAULT_SNAPSHOT_PERIOD_FRAMES),
        ),
        retainSnapshots: Math.max(1, Number(env.runtimeConfig?.storage?.retainSnapshots ?? DEFAULT_RETAIN_SNAPSHOTS)),
        epochMaxBytes: Math.max(1, Number(env.runtimeConfig?.storage?.epochMaxBytes ?? DEFAULT_EPOCH_MAX_BYTES)),
        accountMerkleRadix: env.runtimeConfig?.storage?.accountMerkleRadix === 256 ? 256 : DEFAULT_ACCOUNT_MERKLE_RADIX,
      },
      canonicalEntityHashes: materialized.canonicalEntityHashes,
      canonicalStateHash,
      runtimeMachine,
      certifiedBoardNodes: Array.from(certifiedBoardNodes, ([hash, node]) => ({ hash, node })),
      consumptionNodes: Array.from(consumptionNodes, ([hash, node]) => ({ hash, node })),
      accountJClaimNodes: Array.from(accountJClaimNodes, ([hash, node]) => ({ hash, node })),
      ...(options.onPersistenceBoundary ? { onPersistenceBoundary: options.onPersistenceBoundary } : {}),
    });

    if (await tryOpenStorageDb(env, 'previous')) {
      await clearDatabase(getStorageDb(env, 'previous'));
    }

    const state = ensureRuntimeState(env);
    state.storageEntityHashDocs = replacement.entityHashDocs;
    state.currentStorageOverlayMarks = [];
  };

  const persistRestoredEnvToDB = async (
    env: Env,
    options: { onPersistenceBoundary?: StoragePersistenceBoundaryHook } = {},
  ): Promise<void> => {
    if (!Number.isSafeInteger(Number(env.height)) || Number(env.height) <= 0) {
      throw new Error('RECOVERY_PERSIST_HEIGHT_REQUIRED');
    }
    if (!Number.isSafeInteger(Number(env.timestamp)) || Number(env.timestamp) < 0) {
      throw new Error('RECOVERY_PERSIST_TIMESTAMP_INVALID');
    }
    await withStorageWriterLock(env, () => persistRestoredEnvToDBUnlocked(env, options));
  };

  const assertPersistedContractConfigReady = (env: Env, label: string): void => {
    for (const [name, replica] of env.jReplicas.entries()) {
      try {
        requireDurableJurisdictionStack(replica);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${reason}:${label}:${name}`, { cause: error });
      }
    }
  };

  const findJurisdictionEntryByName = (env: Env, name: string): [string, JReplica] | null => {
    const normalized = String(name || '')
      .trim()
      .toLowerCase();
    for (const entry of env.jReplicas.entries()) {
      if (
        String(entry[0] || '')
          .trim()
          .toLowerCase() === normalized
      )
        return entry;
    }
    return null;
  };

  const registerCommittedSingleSignerWallet = (env: Env, replica: EntityReplica): void => {
    const validators = replica.state.config.validators;
    if (validators.length !== 1 || replica.state.config.threshold !== 1n) return;
    const signerId = String(validators[0] || '')
      .trim()
      .toLowerCase();
    if (!signerId) throw new Error(`ENTITY_SINGLE_SIGNER_MISSING:${replica.entityId}`);
    if (
      String(replica.signerId || '')
        .trim()
        .toLowerCase() !== signerId
    ) {
      throw new Error(`ENTITY_SINGLE_SIGNER_REPLICA_MISMATCH:${replica.entityId}:${replica.signerId}:${signerId}`);
    }
    const privateKey = getLocalSignerPrivateKey(env, signerId);
    if (privateKey === null) return;
    const jurisdiction = replica.state.config.jurisdiction;
    if (!jurisdiction?.depositoryAddress || !jurisdiction.chainId) {
      throw new Error(`ENTITY_JURISDICTION_BINDING_INCOMPLETE:${replica.entityId}`);
    }
    const jurisdictionReplica = findWatcherJurisdictionReplica(
      env,
      jurisdiction.depositoryAddress,
      jurisdiction.chainId,
    );
    if (!jurisdictionReplica) {
      throw new Error(
        `ENTITY_JURISDICTION_REPLICA_MISSING:${replica.entityId}:${jurisdiction.chainId}:${jurisdiction.depositoryAddress}`,
      );
    }
    const hasExternalRpc = (jurisdictionReplica.rpcs ?? []).some(rpc => {
      const normalized = String(rpc || '')
        .trim()
        .toLowerCase();
      return normalized.length > 0 && !normalized.startsWith('browservm:');
    });
    const liveAdapter = jurisdictionReplica.jadapter;
    if (!liveAdapter) {
      if (hasExternalRpc) {
        // RPC submission carries an already assembled Hanko and is signed by the
        // jurisdiction transaction sender. Entity private keys never belong in
        // the RPC adapter, whose registerEntityWallet implementation is a no-op.
        return;
      }
      runtimeLog.debug('browservm.wallet_bind_deferred', {
        entityId: replica.entityId,
        chainId: jurisdiction.chainId,
        depositoryAddress: jurisdiction.depositoryAddress,
      });
      return;
    }
    if (liveAdapter.mode !== 'browservm' && hasExternalRpc) return;
    const registerWallet = liveAdapter.registerEntityWallet;
    if (!registerWallet) {
      throw new Error(`ENTITY_JURISDICTION_WALLET_BINDER_MISSING:${replica.entityId}`);
    }
    registerWallet(replica.entityId, ethers.hexlify(privateKey));
  };

  const registerCommittedSingleSignerWallets = (env: Env, entityIds?: ReadonlySet<string>): void => {
    for (const replica of env.eReplicas.values()) {
      if (entityIds && !entityIds.has(replica.entityId.toLowerCase())) continue;
      registerCommittedSingleSignerWallet(env, replica);
    }
  };

  const reconcileCommittedRuntimeInfraEffects = async (env: Env, runtimeTxs: readonly RuntimeTx[]): Promise<void> => {
    const jurisdictionNames = new Set<string>();
    const importedEntityIds = new Set<string>();
    for (const runtimeTx of runtimeTxs) {
      if (runtimeTx.type === 'completeImportJ') jurisdictionNames.add(runtimeTx.data.name);
      if (runtimeTx.type === 'importJ' && findJurisdictionEntryByName(env, runtimeTx.data.name)) {
        jurisdictionNames.add(runtimeTx.data.name);
      }
      if (runtimeTx.type === 'importReplica') {
        importedEntityIds.add(runtimeTx.entityId.toLowerCase());
      }
    }
    for (const name of jurisdictionNames) {
      const entry = findJurisdictionEntryByName(env, name);
      if (!entry) throw new Error(`COMMITTED_JURISDICTION_REPLICA_MISSING:${name}`);
      const adapter = await ensureLiveJAdapterForReplica(env, entry[0], {
        allowBrowserVm: true,
        context: `postcommit:${entry[0]}`,
        attempts: typeof window !== 'undefined' ? 5 : 3,
      });
      if (!adapter) throw new Error(`COMMITTED_JURISDICTION_ADAPTER_MISSING:${entry[0]}`);
      if (adapter.mode === 'browservm') {
        const browserVM = adapter.getBrowserVM();
        if (!browserVM) throw new Error(`COMMITTED_BROWSERVM_MISSING:${entry[0]}`);
        setBrowserVMJurisdiction(env, adapter.addresses.depository, adapter.chainId, browserVM);
      }
    }
    if (jurisdictionNames.size > 0) {
      assertPersistedContractConfigReady(env, 'postcommit jurisdiction import');
      registerCommittedSingleSignerWallets(env);
      startJurisdictionWatchers(env);
    } else if (importedEntityIds.size > 0) {
      registerCommittedSingleSignerWallets(env, importedEntityIds);
    }
  };

  const hasPendingLocalReliableOutput = (env: Env): boolean => {
    const runtimeId = normalizeRuntimeId(env.runtimeId);
    if (!runtimeId) return false;
    return (env.pendingNetworkOutputs ?? []).some(
      output => normalizeRuntimeId(output.runtimeId) === runtimeId && getReliableOutputIdentity(output) !== null,
    );
  };

  const queueLocalOutputsWithReliability = (
    env: Env,
    localOutputs: readonly RoutedEntityInput[],
  ): RoutedEntityInput[] => {
    const runtimeId = normalizeRuntimeId(env.runtimeId);
    if (!runtimeId && localOutputs.some(output => getReliableOutputIdentity(output) !== null)) {
      throw new Error('RELIABLE_LOCAL_RUNTIME_ID_MISSING');
    }
    const inputs: RoutedEntityInput[] = [];
    const receipts: ReliableDeliveryReceipt[] = [];
    const retained: RoutedEntityInput[] = [];
    for (const originatedOutput of localOutputs) {
      const { sourceRuntimeFrame: _sourceRuntimeFrame, ...output } = originatedOutput;
      if (!getReliableOutputIdentity(output)) {
        inputs.push(output);
        continue;
      }
      const deliverable = { ...output, runtimeId: runtimeId! };
      retained.push(deliverable);
      const registration = registerReliableIngress(env, runtimeId!, deliverable);
      if (registration.kind === 'enqueue') inputs.push(deliverable);
      if (registration.kind === 'receipt') {
        registerReliableReceiptIngress(env, registration.receipt);
        receipts.push(registration.receipt);
      }
    }
    enqueueRuntimeContinuation(env, inputs, undefined, undefined, env.timestamp, receipts);
    return retained;
  };

  const applyDeterministicRuntimeOutputPlan = (
    env: Env,
    entityOutbox: readonly RoutedEntityInput[],
    outputRoutingDeps: RuntimeOutputRoutingDeps,
  ) => {
    const originatedEntityOutbox = entityOutbox.map(output =>
      output.sourceRuntimeFrame
        ? output
        : {
            ...output,
            sourceRuntimeFrame: {
              height: env.height,
              timestamp: env.timestamp,
            },
          },
    );
    const pendingBeforePlan = buildPendingNetworkOutputs(
      pruneReceiptedReliableOutputs(env, [...(env.pendingNetworkOutputs ?? []), ...originatedEntityOutbox]),
    );
    const { ready, waiting } = splitPendingOutputsByRetryWindow(env, pendingBeforePlan, outputRoutingDeps);
    const plan = planEntityOutputs(env, ready, outputRoutingDeps);
    const retainedLocalReliableOutputs = queueLocalOutputsWithReliability(env, plan.localOutputs);
    env.pendingNetworkOutputs = buildPendingNetworkOutputs([
      ...waiting,
      ...plan.deferredOutputs,
      ...plan.remoteOutputs.map(({ output }) => output),
      ...retainedLocalReliableOutputs,
    ]);
    return { ...plan, readyPendingOutputs: ready, waitingPendingOutputs: waiting, retainedLocalReliableOutputs };
  };

  const applyCommittedLocalReliableReceipts = (
    env: Env,
    commits: ReliableIngressCommit[],
    options: {
      isReplay?: boolean;
      replayInputs?: readonly RoutedEntityInput[];
    } = {},
  ): void => {
    const runtimeId = normalizeRuntimeId(env.runtimeId);
    if (!runtimeId) return;
    const localCommits: ReliableIngressCommit[] = [];
    for (const commit of commits) {
      if (!commit.receipt || !commit.targetRuntimeIds.includes(runtimeId)) continue;
      // Live execution proves sender ownership through the exact durable outbox
      // item. Sparse-WAL replay intentionally does not retain pre-frame state;
      // its authenticated `from === runtimeId` input is the equivalent proof and
      // the frame's post-state outputs are installed after reducer replay.
      localCommits.push(commit);
    }
    const pendingOutputs = env.pendingNetworkOutputs ?? [];
    const pendingMatches = matchReceiptsToOutputs(
      pendingOutputs,
      localCommits.flatMap(commit => (commit.receipt ? [commit.receipt] : [])),
    );
    const selected = new Map<ReliableDeliveryReceipt, RoutedEntityInput>(pendingMatches);
    if (options.isReplay) {
      const uncovered = localCommits.filter(commit => commit.receipt && !selected.has(commit.receipt));
      if (uncovered.length > 0) {
        const replayInputs = options.replayInputs?.flatMap(splitRoutedOutputByDeliveryLane) ?? [];
        const replayMatches = matchReceiptsToOutputs(
          replayInputs,
          uncovered.flatMap(commit => (commit.receipt ? [commit.receipt] : [])),
        );
        for (const commit of uncovered) {
          const receipt = commit.receipt!;
          const replayOutput = replayMatches.get(receipt);
          if (!replayOutput) {
            throw new Error(
              `RELIABLE_LOCAL_REPLAY_OUTPUT_PROOF_MISSING:` +
                `${receipt.body.identity.kind}:${receipt.body.identity.height}`,
            );
          }
          env.pendingNetworkOutputs = [...(env.pendingNetworkOutputs ?? []), replayOutput];
          selected.set(receipt, replayOutput);
        }
      }
    }
    const receipts = [...selected.keys()];
    const selectedSignatures = new Set(receipts.map(receipt => receipt.signature));
    for (const commit of localCommits) {
      if (!commit.receipt || !selectedSignatures.has(commit.receipt.signature)) continue;
      commit.targetRuntimeIds = commit.targetRuntimeIds.filter(target => target !== runtimeId);
    }
    if (receipts.length > 0) {
      const unique = [...new Map(receipts.map(receipt => [receipt.signature, receipt])).values()];
      applyReliableDeliveryReceipts(env, unique);
    }
  };

  return {
    restoreEnvFromCheckpointSnapshot,
    restoreEnvFromRecoveryBundles,
    persistRestoredEnvToDB,
    replayRecoveryFrameJournals,
    assertPersistedContractConfigReady,
    registerCommittedSingleSignerWallets,
    reconcileCommittedRuntimeInfraEffects,
    hasPendingLocalReliableOutput,
    applyDeterministicRuntimeOutputPlan,
    applyCommittedLocalReliableReceipts,
  };
};
