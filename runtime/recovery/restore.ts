import { Level } from 'level';
import { nodeProcess, runtimeIsBrowser } from '../runtime/platform';
import {
  cloneIsolatedRoutedEntityInputs,
  cloneIsolatedRuntimeInput,
  cloneIsolatedRuntimeSnapshot,
} from './../protocol/runtime-input-clone';
import { requireBoundaryInteger } from './../protocol/boundary-validation';
import {
  buildDurableRuntimeMachineSnapshot,
  buildReplayVerifiableRuntimeMachineSnapshot,
  authorizeRestoredRuntimeInput,
  normalizePersistedSnapshotInPlace,
  restoreDurableRuntimeSnapshot,
} from '../storage/wal/snapshot';
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
import { clearPendingAuditEvents, dropPendingHistoryRecords, peekPendingHistoryRecords } from '../runtime/env-events';
import { getCachedSignerPrivateKey } from './../account/crypto';
import type { Profile } from './../networking/gossip';
import { normalizeRuntimeId } from './../networking/runtime-id';
import {
  markRestoredReliableOutputsDue,
  type RuntimeOutputRoutingDeps,
} from '../runtime/output-routing';
import { refreshScheduledWakeIndex } from '../runtime/scheduled-wake';
import { ensureRuntimeState } from '../runtime/runtime-state';
import {
  finalizeReliableIngressCommit,
} from '../runtime/reliable-delivery';
import {
  applyCommittedLocalReliableReceipts,
  applyRecoveryRuntimeOutputPlan,
  hasPendingLocalReliableOutput,
} from '../runtime/recovery-output';
import {
  assertPersistedContractConfigReady,
  reconcileRecoveryInfraEffects,
  registerCommittedSingleSignerWallets,
} from '../runtime/recovery-infra';
import { restoreDurableOutputRetryState } from '../runtime/durable-output-retry';
import { registerPendingCommittedJOutbox, splitJOutboxForDurableSubmit } from '../runtime/j-submit-state';
import { clearReplayOutputSignerHints, installReplayOutputSignerHints } from './../state-helpers';
import { safeStringify } from './../protocol/serialization';
import {
  computeCanonicalEntityHash,
  computeCanonicalRuntimeStateHash,
  computeCanonicalStateHashFromEnv,
} from './../storage/canonical-hash';
import {
  assertRecoveryRuntimeMachineMatches,
  listRecoveryRuntimeMachineMismatchFields,
} from '../storage/recovery/machine';
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
import type { RuntimeState, ReliableDeliveryReceipt, RoutedEntityInput, RuntimeTx } from './../types';
import { clearDatabase } from './../utils';
import type { PersistedFrameJournal } from './../storage/types';
import { assertRuntimeRecoveryBundleAuthenticity } from './../recovery/bundle';
import type { RuntimeRecoveryBundleV1 } from './../recovery/types';
import { rehydrateRestoredRuntimeInfra } from '../runtime/infra';
import { loadGossipProfilesFromInfraDb } from '../runtime/infra-gossip-store';
import { normalizeDbNamespace, type StorageDbRole, withStorageWriterLock } from './../storage/runtime-dbs';
import { createStructuredLogger } from '../infra/logger';

type RuntimeModule = typeof import('../runtime');

export type RuntimeRecoveryDeps = Pick<
  RuntimeModule,
  'closeRuntimeDb' | 'closeInfraDb' | 'startJurisdictionWatchers'
> & {
  ensureRuntimeConfig(env: RuntimeState): NonNullable<RuntimeState['runtimeConfig']>;
  createEmptyEnv: RuntimeModule['createEmptyEnv'];
  getStorageDb(env: RuntimeState, role?: StorageDbRole): Level<Buffer, Buffer>;
  getRuntimeWalDb(env: RuntimeState): Level<Buffer, Buffer>;
  tryOpenStorageDb(env: RuntimeState, role?: StorageDbRole): Promise<boolean>;
  tryOpenRuntimeWalDb(env: RuntimeState): Promise<boolean>;
  enqueueRuntimeContinuation(
    env: RuntimeState,
    inputs?: import('../types').EntityInput[],
    runtimeTxs?: RuntimeTx[],
    jInputs?: import('../types').JInput[],
    explicitTimestamp?: number,
    reliableReceipts?: ReliableDeliveryReceipt[],
  ): void;
  infraGossipDbAccess: Parameters<typeof loadGossipProfilesFromInfraDb>[1];
  generateHookPings(env: RuntimeState, nowMs?: number, queuedAt?: number): void;
  getRuntimeOutputRoutingDeps(): RuntimeOutputRoutingDeps;
  applyRuntimeInput: RuntimeModule['applyRuntimeInput'];
};

const ENV_APPLY_ALLOWED_KEY = Symbol.for('xln.runtime.env.apply.allowed');
const ENV_REPLAY_MODE_KEY = Symbol.for('xln.runtime.env.replay.mode');
const envRecord = (env: RuntimeState): Record<PropertyKey, unknown> => env as unknown as Record<PropertyKey, unknown>;
const runtimeLog = createStructuredLogger('runtime');

export const createRuntimeRecoveryApi = (deps: RuntimeRecoveryDeps) => {
  const {
    ensureRuntimeConfig,
    createEmptyEnv,
    getStorageDb,
    getRuntimeWalDb,
    tryOpenStorageDb,
    tryOpenRuntimeWalDb,
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
  ): Promise<RuntimeState> => {
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
        browserVMState: structuredClone(browserVMState) as RuntimeState['browserVMState'],
      });
    }
    const snapshotGossip =
      normalizedSnapshot['gossip'] && typeof normalizedSnapshot['gossip'] === 'object'
        ? (normalizedSnapshot['gossip'] as { profiles?: unknown })
        : null;
    const snapshotGossipProfiles = Array.isArray(snapshotGossip?.profiles)
      ? (snapshotGossip.profiles as Profile[])
      : [];
    env.runtimeMempool = { runtimeTxs: [], entityInputs: [] };
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

  const replayRecoveryFrameJournals = async (env: RuntimeState, frames: PersistedFrameJournal[]): Promise<void> => {
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
          const replayHistoryViewRecords = peekPendingHistoryRecords(env, env.height, env.timestamp);
          finalizeReliableIngressCommit(env, replayResult.reliableIngressCommits);
          // Audit events are flushed only after the live WAL commit and are not
          // consensus/recovery state. Replay must neither retain nor re-emit them.
          clearPendingAuditEvents(env);
          env.runtimeMempool = frame.pendingRuntimeInput
            ? authorizeRestoredRuntimeInput(cloneIsolatedRuntimeInput(frame.pendingRuntimeInput))
            : { runtimeTxs: [], entityInputs: [] };
          env.pendingNetworkOutputs = cloneIsolatedRoutedEntityInputs(frame.runtimeOutputs ?? []);
          restoreDurableOutputRetryState(env, frame.runtimeOutputRetryState ?? [], frame.runtimeOutputs ?? []);
          // These activity records were consumed by the same atomic storage
          // batch as the Runtime frame. Compare the committed post-state, not
          // the writer's pre-commit buffer.
          dropPendingHistoryRecords(env, replayHistoryViewRecords.length);
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
              excludePersistedHistoryRecords: true,
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
              const expectedMachine = frame.runtimeMachine;
              const actualMachine = buildDurableRuntimeMachineSnapshot(env);
              const differingMachineKeys = expectedMachine
                ? listRecoveryRuntimeMachineMismatchFields(expectedMachine, actualMachine)
                : ['runtimeMachine'];
              throw new Error(
                `RECOVERY_JOURNAL_STATE_HASH_MISMATCH:height=${frameHeight}:` +
                  `expected=${frame.runtimeStateHash}:actual=${actualStateHash}:` +
                  `runtimeMachineDiff=${differingMachineKeys.join(',') || 'none'}`,
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

  const failRecoveryRestoreAfterCleanup = async (env: RuntimeState, error: unknown): Promise<never> => {
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
  ): Promise<RuntimeState> => {
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
    env: RuntimeState,
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
    if (!(await tryOpenRuntimeWalDb(env))) {
      throw new Error('RECOVERY_PERSIST_RUNTIME_WAL_OPEN_FAILED');
    }

    const currentDb = getStorageDb(env, 'current');
    const walDb = getRuntimeWalDb(env);
    const puts = materialized.docs;
    const replicaMetas = buildStorageReplicaMetaCommitment(env, lineagePlan).entries;
    const replacement = await replaceRestoredStorageBase({
      currentDb,
      walDb,
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
    env: RuntimeState,
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

  const reconcileCommittedRuntimeInfraEffects = (
    env: RuntimeState,
    runtimeTxs: readonly RuntimeTx[],
  ) => reconcileRecoveryInfraEffects(
    env,
    runtimeTxs,
    startJurisdictionWatchers,
  );

  const applyDeterministicRuntimeOutputPlan = (
    env: RuntimeState,
    entityOutbox: readonly RoutedEntityInput[],
    outputRoutingDeps: RuntimeOutputRoutingDeps,
  ) => applyRecoveryRuntimeOutputPlan(
    env,
    entityOutbox,
    outputRoutingDeps,
    enqueueRuntimeContinuation,
  );

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
