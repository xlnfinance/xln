import type { JPrefixAttestation } from '../../types/jurisdiction-events';
import type { EntityInput } from '../../entity/types';
import type { RuntimeReplica, RuntimeInput, RuntimeTx } from '../../runtime/types';
import { enqueueRuntimeInput } from '../../runtime/input-pipeline/input-queue';
import { createStructuredLogger, shortId } from '../../infra/logger';
import { getJEventJurisdictionRef } from '../machine/event-observation';
import { JBLOCK_LIVENESS_INTERVAL } from '../../entity/types';
import { recordValidatorJHistory } from '../machine/local-history';
import {
  buildLocalJPrefixAttestation,
  getLocalJPrefixAttestableHeight,
  hasDueLocalJPrefixAdvance,
  hasCurrentRoundJPrefixAttestation,
} from '../machine/history/j-prefix-consensus';
import { markLocalJAuthorityRuntimeTx } from '../machine/registration-evidence';
import {
  applyJHistoryRangeIngressTransform,
} from './ingress-transform';
import {
  assertJEventIngressOpen,
} from './event-observation';
import {
  isEntityReplicaRelevantToWatcher,
  requireWatcherJurisdictionReplica,
} from './watcher/observe/watcher-replica';

const log = createStructuredLogger('jadapter.history-ingress');

export type JHistoryRangeRuntimeInput = {
  input: RuntimeInput;
  /** Replicas whose authenticated local scan observation must become durable. */
  scannedReplicaKeys: string[];
  /** Subset that generated a J-range and therefore must reach Entity finality. */
  finalityReplicaKeys: string[];
};

export type JHistoryRangeReplicaKeys = Pick<
  JHistoryRangeRuntimeInput,
  'scannedReplicaKeys' | 'finalityReplicaKeys'
>;

type JHistoryRangeScope = 'watcher' | 'observed';

const mergeJPrefixAttestationInputs = (
  observed: EntityInput['jPrefixAttestations'],
  range: EntityInput['jPrefixAttestations'],
): Map<string, JPrefixAttestation> | undefined => {
  if (!observed && !range) return undefined;
  const merged = new Map(observed || []);
  for (const [signerId, attestation] of range || []) {
    if (merged.has(signerId)) {
      throw new Error(`J_HISTORY_RANGE_PREFIX_ATTESTATION_DUPLICATE:${signerId}`);
    }
    merged.set(signerId, attestation);
  }
  return merged;
};

export const appendJHistoryRange = (
  observedInput: RuntimeInput,
  rangeInput: RuntimeInput | null,
): RuntimeInput => {
  if (!rangeInput) return observedInput;
  const merged = new Map<string, EntityInput>();
  for (const input of observedInput.entityInputs || []) {
    merged.set(`${String(input.entityId).toLowerCase()}:${String(input.signerId).toLowerCase()}`, input);
  }
  for (const range of rangeInput.entityInputs) {
    const key = `${String(range.entityId).toLowerCase()}:${String(range.signerId).toLowerCase()}`;
    const observation = merged.get(key);
    if (!observation) {
      merged.set(key, range);
      continue;
    }
    const jPrefixAttestations = mergeJPrefixAttestationInputs(
      observation.jPrefixAttestations,
      range.jPrefixAttestations,
    );
    merged.set(key, {
      ...observation,
      ...range,
      entityTxs: [...(observation.entityTxs || []), ...(range.entityTxs || [])],
      ...(jPrefixAttestations ? { jPrefixAttestations } : {}),
    });
  }
  return {
    ...observedInput,
    timestamp: Math.max(
      Number(observedInput.timestamp ?? 0),
      Number(rangeInput.timestamp ?? 0),
    ),
    runtimeTxs: [...observedInput.runtimeTxs, ...rangeInput.runtimeTxs],
    entityInputs: [...merged.values()],
    ...(observedInput.jInputs || rangeInput.jInputs
      ? { jInputs: [...(observedInput.jInputs || []), ...(rangeInput.jInputs || [])] }
      : {}),
    ...(observedInput.reliableReceipts || rangeInput.reliableReceipts
      ? {
          reliableReceipts: [
            ...(observedInput.reliableReceipts || []),
            ...(rangeInput.reliableReceipts || []),
          ],
        }
      : {}),
  };
};

const combineRuntimeInputs = (inputs: RuntimeInput[]): RuntimeInput | null => {
  let combined: RuntimeInput | null = null;
  for (const input of inputs) combined = combined ? appendJHistoryRange(combined, input) : input;
  return combined;
};

export function buildJHistoryRangeRuntimeInput(
  env: RuntimeReplica,
  newlyObservedInputs: RuntimeInput[],
  scannedThroughHeight: number,
  tipBlockHash: string,
  depositoryAddress?: string,
  headers: Array<{ jHeight: number; jBlockHash: string }> = [],
  chainId?: number,
  scope: JHistoryRangeScope = 'watcher',
): JHistoryRangeRuntimeInput | null {
  if (!Number.isSafeInteger(scannedThroughHeight) || scannedThroughHeight <= 0) {
    throw new Error(`J_HISTORY_RANGE_INVALID_SCANNED_HEIGHT:${String(scannedThroughHeight)}`);
  }
  if (!String(tipBlockHash || '').trim()) throw new Error('J_HISTORY_RANGE_TIP_HASH_MISSING');
  const watcherReplica = depositoryAddress || chainId !== undefined
    ? requireWatcherJurisdictionReplica(env, depositoryAddress, chainId, 'history-range')
    : undefined;
  const watcherJurisdictionRef = watcherReplica ? getJEventJurisdictionRef(watcherReplica) : '';
  const observationsByReplica = new Map<string, Array<Extract<RuntimeTx, { type: 'observeJRange' }>>>();
  for (const runtimeInput of newlyObservedInputs) {
    for (const tx of runtimeInput.runtimeTxs || []) {
      if (tx.type !== 'observeJRange') continue;
      const key = `${String(tx.data.entityId).toLowerCase()}:${String(tx.data.signerId).toLowerCase()}`;
      observationsByReplica.set(key, [...(observationsByReplica.get(key) || []), tx]);
    }
  }

  const runtimeTxs: RuntimeTx[] = [];
  const entityInputs: EntityInput[] = [];
  const scannedReplicaKeys: string[] = [];
  const finalityReplicaKeys: string[] = [];
  for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
    if (watcherReplica && !isEntityReplicaRelevantToWatcher(env, replica, watcherReplica)) continue;
    const entityId = String(replica.state.entityId || replica.entityId || '').toLowerCase();
    const signerId = String(replica.signerId || '').toLowerCase();
    if (!entityId || !signerId) continue;
    const key = `${entityId}:${signerId}`;
    // A transaction receipt proves only the entities named by its events. It
    // cannot advance an unrelated entity's empty J range because the receipt
    // API does not carry the source jurisdiction. In a multi-J runtime with
    // deterministic deployments, doing so would copy chain A's block hash into
    // chain B's Entity history. Long-lived watchers are different: they pass an
    // exact (chainId, Depository) selector and may advance every matching Entity.
    if (scope === 'observed' && !observationsByReplica.has(key)) continue;
    const baseHeight = Number(replica.state.lastFinalizedJHeight || 0);
    const observations = observationsByReplica.get(key) || [];
    if (scannedThroughHeight <= baseHeight) continue;
    const scanDistanceMayReachLiveness = scannedThroughHeight - baseHeight >= JBLOCK_LIVENESS_INTERVAL;
    const jurisdictionRef = getJEventJurisdictionRef(replica.state.config.jurisdiction);
    if (watcherReplica && jurisdictionRef !== watcherJurisdictionRef) {
      throw new Error(
        `J_WATCHER_ENTITY_JURISDICTION_MISMATCH:history-range` +
        `:watcher=${watcherJurisdictionRef}:entity=${jurisdictionRef}:replica=${replicaKey}`,
      );
    }
    let tentativeHistory = replica.jHistory;
    for (const observation of observations) {
      tentativeHistory = recordValidatorJHistory(tentativeHistory, observation.data, replica.state);
    }
    const normalizedTipBlockHash = String(tipBlockHash).toLowerCase();
    const shouldRecordScanTip =
      headers.length > 0 ||
      !tentativeHistory ||
      tentativeHistory.scannedThroughHeight !== scannedThroughHeight ||
      tentativeHistory.tipBlockHash !== normalizedTipBlockHash;
    const scanTipObservation: Extract<RuntimeTx, { type: 'observeJRange' }> | null = shouldRecordScanTip
      ? {
        type: 'observeJRange',
        data: {
          entityId,
          signerId,
          jurisdictionRef,
          scannedThroughHeight,
          tipBlockHash: normalizedTipBlockHash,
          ...(headers.length > 0 ? { headers } : {}),
          blocks: [],
        },
      }
      : null;
    if (scanTipObservation) {
      tentativeHistory = recordValidatorJHistory(tentativeHistory, scanTipObservation.data, replica.state);
    }
    const hasDuePrefixAdvance = hasDueLocalJPrefixAdvance(replica.state, tentativeHistory);
    // Empty authenticated pages below liveness stay outside Runtime state. The
    // one exception is a page that closes the exact prefix for a previously
    // persisted sparse semantic event: that event must become attestable now.
    if (observations.length === 0 && !scanDistanceMayReachLiveness && !hasDuePrefixAdvance) continue;
    if (scanTipObservation) runtimeTxs.push(markLocalJAuthorityRuntimeTx(scanTipObservation));
    scannedReplicaKeys.push(replicaKey);
    // A semantic J event must hold the watcher cursor until the Entity has
    // certified the containing authenticated prefix. This obligation is
    // independent of whether this validator can emit a new attestation now:
    // it may already have signed the current Entity-height round, in which
    // case the event belongs to the next round after that one commits.
    if (observations.length > 0) finalityReplicaKeys.push(replicaKey);
    // An authenticated empty suffix is still durable local evidence, but it is
    // not an Entity range until the liveness interval is due. Treating every
    // scanned replica as pending finality deadlocks the watcher one empty block
    // after an event because no proposal is supposed to exist for that suffix.
    if (!hasDuePrefixAdvance) continue;
    if (!tentativeHistory) throw new Error(`J_HISTORY_DUE_WITHOUT_HISTORY:${replicaKey}`);
    if (hasCurrentRoundJPrefixAttestation(replica)) continue;
    if (getLocalJPrefixAttestableHeight(replica.state, tentativeHistory) === null) {
      log.debug('j_prefix.attestation_deferred', {
        entity: shortId(entityId),
        baseHeight: replica.state.lastFinalizedJHeight,
        scannedThroughHeight: tentativeHistory.scannedThroughHeight,
        reason: 'authenticated_headers_incomplete',
      });
      continue;
    }
    const attestation = buildLocalJPrefixAttestation(env, replica, tentativeHistory);
    if (!attestation) continue;
    entityInputs.push({
      entityId,
      signerId,
      jPrefixAttestations: new Map([[signerId, attestation]]),
    });
  }
  if (runtimeTxs.length === 0 && entityInputs.length === 0) return null;
  return {
    input: { timestamp: scannedThroughHeight, runtimeTxs, entityInputs },
    scannedReplicaKeys: scannedReplicaKeys.sort(),
    finalityReplicaKeys: finalityReplicaKeys.sort(),
  };
}

export function enqueueJHistoryRange(
  env: RuntimeReplica,
  newlyObservedInputs: RuntimeInput[],
  scannedThroughHeight: number,
  tipBlockHash: string,
  depositoryAddress?: string,
  headers: Array<{ jHeight: number; jBlockHash: string }> = [],
  chainId?: number,
): JHistoryRangeReplicaKeys {
  // This is the final common boundary for both RPC and BrowserVM watchers.
  // Outer poll cancellation checks reduce wasted I/O, but only this guard can
  // prove that no authenticated empty range is queued after quiesce begins.
  assertJEventIngressOpen(env, 'history-range');
  const ingress = applyJHistoryRangeIngressTransform({
    scannedThroughHeight,
    tipBlockHash,
    headers,
  });
  const built = buildJHistoryRangeRuntimeInput(
    env,
    newlyObservedInputs,
    ingress.scannedThroughHeight,
    ingress.tipBlockHash,
    depositoryAddress,
    ingress.headers,
    chainId,
  );
  const observedInput = combineRuntimeInputs(newlyObservedInputs);
  const input = observedInput
    ? appendJHistoryRange(observedInput, built?.input ?? null)
    : built?.input ?? null;
  if (input) enqueueRuntimeInput(env, input);
  if (!built) return { scannedReplicaKeys: [], finalityReplicaKeys: [] };
  return {
    scannedReplicaKeys: built.scannedReplicaKeys,
    finalityReplicaKeys: built.finalityReplicaKeys,
  };
}
