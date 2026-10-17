import type { JPrefixAttestation } from '../../../types/jurisdiction-events';
import type { EntityInput, EntityReplica } from '../../../entity/types';
import type { RuntimeReplica, RuntimeInput, RuntimeTx } from '../../../runtime/types';
import { BLOCKCHAIN } from '../../../config/constants';
import { enqueueRuntimeInput } from '../../../runtime/mempool/input-queue';
import { carryJScanTip, dropCarriedJScanTips } from '../../../runtime/mempool/j-scan-carry';
import { createStructuredLogger, shortId } from '../../../support/logger';
import { getJEventJurisdictionRef } from '../../machine/event-observation';
import { recordValidatorJHistory } from '../../machine/local-history';
import {
  buildLocalJPrefixAttestation,
  getLocalJPrefixAttestableHeight,
  hasDueLocalJPrefixAdvance,
  hasCurrentRoundJPrefixAttestation,
} from '../../machine/history/j-prefix-consensus';
import { markLocalJAuthorityRuntimeTx } from '../../machine/registration-evidence';
import {
  applyJHistoryRangeIngressTransform,
} from './ingress-transform';
import {
  assertJEventIngressOpen,
} from './event-observation';
import {
  isEntityReplicaRelevantToWatcher,
  requireWatcherJurisdictionReplica,
} from '../watcher/observe/watcher-replica';

const log = createStructuredLogger('jadapter.history-ingress');

type ObserveJRangeTx = Extract<RuntimeTx, { type: 'observeJRange' }>;

export type JHistoryRangeRuntimeInput = {
  input: RuntimeInput;
  /** Replicas whose authenticated local scan observation must become durable. */
  scannedReplicaKeys: string[];
  /** Subset that generated a J-range and therefore must reach Entity finality. */
  finalityReplicaKeys: string[];
  /** Header-only pages below the checkpoint interval; never Runtime work on their own. */
  carriedScanTips: Array<{ replicaKey: string; tx: ObserveJRangeTx }>;
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
  };
};

const combineRuntimeInputs = (inputs: RuntimeInput[]): RuntimeInput | null => {
  let combined: RuntimeInput | null = null;
  for (const input of inputs) combined = combined ? appendJHistoryRange(combined, input) : input;
  return combined;
};

const buildScanTipObservation = (
  env: RuntimeReplica,
  replicaKey: string,
  replica: EntityReplica,
  current: EntityReplica['jHistory'],
  data: ObserveJRangeTx['data'],
) => {
  // Retain every carried header in the eventual WAL input. Authenticate
  // overlapping hashes through the canonical recorder before deduplicating.
  const carried = env.infrastructure?.carriedJScanTips?.get(replicaKey)?.data.headers ?? [];
  const headers = [
    ...carried.filter(
      header => header.jHeight > replica.state.lastFinalizedJHeight && header.jHeight <= data.scannedThroughHeight,
    ),
    ...(data.headers ?? []),
  ];
  const completeData = { ...data, ...(headers.length > 0 ? { headers } : {}) };
  const scannedHistory = recordValidatorJHistory(current, completeData, replica.state);
  const addsHeader = (height: number): boolean =>
    scannedHistory.blockHashes.get(height) !== current?.blockHashes.get(height);
  const changed =
    !current ||
    current.scannedThroughHeight !== scannedHistory.scannedThroughHeight ||
    current.contiguousThroughHeight !== scannedHistory.contiguousThroughHeight ||
    current.tipBlockHash !== scannedHistory.tipBlockHash ||
    addsHeader(data.scannedThroughHeight) ||
    headers.some(header => addsHeader(header.jHeight));
  const scanTipObservation: ObserveJRangeTx | null = changed
    ? {
        type: 'observeJRange',
        data: {
          ...completeData,
          ...(headers.length > 0
            ? { headers: [...new Map(headers.map(header => [header.jHeight, header])).values()] }
            : {}),
        },
      }
    : null;
  return { scannedHistory, scanTipObservation };
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
  const carriedScanTips: JHistoryRangeRuntimeInput['carriedScanTips'] = [];
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
    // Measure from the last recorded scan, not Entity finality: an idle Entity
    // never advances finality, so the latter would checkpoint every poll after 100.
    const lastRecordedScan = Math.max(baseHeight, replica.jHistory?.contiguousThroughHeight ?? baseHeight);
    const scanCheckpointDue = scannedThroughHeight - lastRecordedScan >= BLOCKCHAIN.JBLOCK_LIVENESS_INTERVAL;
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
    const { scannedHistory, scanTipObservation } = buildScanTipObservation(env, replicaKey, replica, tentativeHistory, {
      entityId,
      signerId,
      jurisdictionRef,
      scannedThroughHeight,
      tipBlockHash: String(tipBlockHash).toLowerCase(),
      ...(headers.length > 0 ? { headers } : {}),
      blocks: [],
    });
    if (scanTipObservation) tentativeHistory = scannedHistory;
    const hasDuePrefixAdvance = hasDueLocalJPrefixAdvance(replica.state, tentativeHistory);
    const hasDueJWork = observations.length > 0 || hasDuePrefixAdvance;
    if (!hasDueJWork && !scanTipObservation) continue;
    if (!hasDueJWork && scanTipObservation && !scanCheckpointDue) {
      // Header-only progress below the checkpoint interval is not Runtime work:
      // one WAL frame per poll made an idle wallet grow per block per chain.
      // It is carried and must still reach the WAL before the next financial
      // input, or a new 50-block HTLC ages past a peer's head; the Runtime
      // frame builder attaches it in front of that input (see j-scan-carry).
      carriedScanTips.push({ replicaKey, tx: markLocalJAuthorityRuntimeTx(scanTipObservation) });
      continue;
    }
    if (scanTipObservation) runtimeTxs.push(markLocalJAuthorityRuntimeTx(scanTipObservation));
    scannedReplicaKeys.push(replicaKey);
    // A semantic J event must hold the watcher cursor until the Entity has
    // certified the containing authenticated prefix. This obligation is
    // independent of whether this validator can emit a new attestation now:
    // it may already have signed the current Entity-height round, in which
    // case the event belongs to the next round after that one commits.
    const registrationBlock = replica.state.config.jurisdiction?.registrationBlock;
    const awaitingRegistration = registrationBlock !== undefined &&
      replica.state.lastFinalizedJHeight < registrationBlock && scannedThroughHeight < registrationBlock;
    // Pre-registration history is WAL-durable above, but cannot yet be signed
    // by this numbered Entity. Fencing here prevents fetching its authority.
    if (observations.length > 0 && !awaitingRegistration) finalityReplicaKeys.push(replicaKey);
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
  // An observed event can already carry every header while this validator has
  // signed the current round. Preserve its finality fence without adding a
  // duplicate scan transaction; callers merge this with that observed input.
  if (runtimeTxs.length === 0 && entityInputs.length === 0 && finalityReplicaKeys.length === 0 && carriedScanTips.length === 0) return null;
  return {
    input: { timestamp: scannedThroughHeight, runtimeTxs, entityInputs },
    scannedReplicaKeys: scannedReplicaKeys.sort(),
    finalityReplicaKeys: finalityReplicaKeys.sort(),
    carriedScanTips,
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
  // An enqueued page starts at or below the carried page and reaches further.
  dropCarriedJScanTips(env, built.scannedReplicaKeys);
  for (const { replicaKey, tx } of built.carriedScanTips) carryJScanTip(env, replicaKey, tx);
  return {
    scannedReplicaKeys: built.scannedReplicaKeys,
    finalityReplicaKeys: built.finalityReplicaKeys,
  };
}
