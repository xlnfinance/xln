import type { DisputeFinalizationEvidence, ValidatorJEventBlock } from '../../types/jurisdiction-events';
import type { EntityInput } from '../../entity/types';
import type { RuntimeInput, RuntimeReplica, RuntimeTx } from '../../runtime/types';
import type { JReplica } from '../../types/jurisdiction-runtime';
import { createStructuredLogger, shortId } from '../../infra/logger';
import {
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
  getJEventJurisdictionRef,
} from '../machine/event-observation';
import { markLocalJAuthorityRuntimeTx } from '../machine/registration-evidence';
import {
  bindLocalJEventIngressSource,
  type LocalJEventIngressSource,
} from './local-ingress-source';
import { rawEventToJEvents } from './j-event-payloads';
import { isEventRelevantToEntity } from './event-relevance';
import {
  isEntityReplicaRelevantToWatcher,
  requireWatcherJurisdictionReplica,
} from './watcher-replica';
import type { JEventIngress } from './types';

const log = createStructuredLogger('jadapter.event-observation');

export type EventBatchCounter = {
  value: number;
  _seenLogs?: { set: Set<string>; order: string[] };
};

export type JEventsRuntimeInputBuildResult = {
  input: RuntimeInput;
  evidenceEvents: JEventIngress[];
};

export type JEventsRuntimeInputOptions = {
  blockNumber: number;
  blockHash: string;
  adapterLabel: string;
  txCounter?: EventBatchCounter;
  logBatch?: boolean;
  emitSettledDebugEvents?: boolean;
  watcherDepositoryAddress?: string;
  watcherChainId?: number;
  localSourceReplica?: JReplica;
};

export const assertJEventIngressOpen = (
  env: RuntimeReplica,
  label: string,
): void => {
  if (!env.infrastructure?.persistenceQuiescing || env.scenarioMode) return;
  env.error?.('jurisdiction', 'J_EVENT_INGRESS_QUIESCING', { label });
  throw new Error(`J_EVENT_INGRESS_QUIESCING:${label}`);
};

const enrichDisputeBatchNonces = (
  events: JEventIngress[],
): JEventIngress[] => {
  const nonceByTxAndEntity = new Map<string, string>();
  for (const event of events) {
    if (event.name !== 'HankoBatchProcessed') continue;
    const txHash = String(event.transactionHash || '').toLowerCase();
    const entityId = String(event.args['entityId'] ?? '').toLowerCase();
    const nonce = event.args['nonce'];
    if (txHash && entityId && nonce !== undefined && nonce !== null) {
      nonceByTxAndEntity.set(`${txHash}:${entityId}`, String(nonce));
    }
  }
  return events.map(event => {
    if (event.name !== 'DisputeStarted' && event.name !== 'DisputeFinalized') {
      return event;
    }
    const nonce = nonceByTxAndEntity.get(
      `${String(event.transactionHash || '').toLowerCase()}:` +
      `${String(event.args['sender'] ?? '').toLowerCase()}`,
    );
    return nonce === undefined ? event : { ...event, args: { ...event.args, batchNonce: nonce } };
  });
};

const resolveWatcher = (
  env: RuntimeReplica,
  options: JEventsRuntimeInputOptions,
): JReplica | undefined => {
  if (
    options.localSourceReplica &&
    (options.watcherDepositoryAddress || options.watcherChainId !== undefined)
  ) {
    throw new Error(`J_EVENT_LOCAL_SOURCE_SELECTOR_CONFLICT:${options.adapterLabel}`);
  }
  if (options.localSourceReplica) {
    return bindLocalJEventIngressSource(
      env,
      options.localSourceReplica,
      `${options.adapterLabel}:event-batch`,
    ).replica;
  }
  return options.watcherDepositoryAddress || options.watcherChainId !== undefined
    ? requireWatcherJurisdictionReplica(
        env,
        options.watcherDepositoryAddress,
        options.watcherChainId,
        'event-batch',
      )
    : undefined;
};

type Delivery = {
  entityId: string;
  signerId: string;
  jurisdictionRef: string;
  events: JEventIngress[];
};

const collectDeliveries = (
  env: RuntimeReplica,
  events: JEventIngress[],
  blockNumber: number,
  watcher: JReplica | undefined,
): Delivery[] => {
  const deliveries: Delivery[] = [];
  const watcherRef = watcher ? getJEventJurisdictionRef(watcher) : '';
  for (const [replicaKey, replica] of env.state.eReplicas) {
    if (watcher && !isEntityReplicaRelevantToWatcher(env, replica, watcher)) continue;
    const jurisdictionRef = getJEventJurisdictionRef(replica.state.config.jurisdiction);
    if (watcher && jurisdictionRef !== watcherRef) {
      throw new Error(
        `J_WATCHER_ENTITY_JURISDICTION_MISMATCH:event-batch` +
        `:watcher=${watcherRef}:entity=${jurisdictionRef}:replica=${replicaKey}`,
      );
    }
    const [keyEntityId, keySignerId] = replicaKey.split(':');
    const entityId = String(replica.entityId || keyEntityId || '').toLowerCase();
    const signerId = String(replica.signerId || keySignerId || '');
    if (!entityId || !signerId || blockNumber <= Number(replica.state.lastFinalizedJHeight || 0)) continue;
    const relevant = events.filter(event => isEventRelevantToEntity(event, entityId));
    if (relevant.length > 0) {
      deliveries.push({ entityId, signerId, jurisdictionRef, events: relevant });
    }
  }
  return deliveries;
};

const evidenceEntries = (
  events: JEventIngress[],
  blockHash: string,
): Array<[string, JEventIngress]> =>
  events.map((event, index) => [
    event.transactionHash
      ? `${event.transactionHash.toLowerCase()}:${event.logIndex ?? event.name}:${index}`
      : `${event.blockHash ?? blockHash}:${event.name}:${index}`,
    event,
  ]);

const buildDelivery = (
  env: RuntimeReplica,
  delivery: Delivery,
  options: JEventsRuntimeInputOptions,
): { runtimeTx: RuntimeTx; evidence: Array<[string, JEventIngress]> } | null => {
  const events = delivery.events.flatMap(event =>
    rawEventToJEvents(event, delivery.entityId));
  if (events.length === 0) return null;
  const settled = events.filter(event => event.type === 'AccountSettled').length;
  if (options.emitSettledDebugEvents && settled > 0) {
    log.info('j_event.deliver_settled', {
      entityId: shortId(delivery.entityId, 8),
      signerId: shortId(delivery.signerId, 8),
      blockNumber: options.blockNumber,
      accountSettled: settled,
    });
    env.infrastructure?.p2p?.sendDebugEvent?.({
      level: 'info', code: 'REB_STEP', step: 4, status: 'ok',
      event: 'j_event_delivered', entityId: delivery.entityId,
      signerId: delivery.signerId, blockNumber: options.blockNumber,
      accountSettled: settled,
    });
  }
  if (options.txCounter) options.txCounter.value += 1;
  const disputeEvidence = delivery.events
    .map(event => event.disputeFinalizationEvidence)
    .filter((item): item is DisputeFinalizationEvidence => Boolean(item));
  const evidenceHash = disputeEvidence.length > 0
    ? canonicalDisputeFinalizationEvidenceHash(disputeEvidence)
    : undefined;
  const block: ValidatorJEventBlock = {
    jurisdictionRef: delivery.jurisdictionRef,
    jHeight: options.blockNumber,
    jBlockHash: options.blockHash.toLowerCase(),
    eventsHash: canonicalJurisdictionEventsHash(events),
    events,
    ...(evidenceHash ? { disputeFinalizationEvidenceHash: evidenceHash } : {}),
    ...(disputeEvidence.length > 0
      ? { disputeFinalizationEvidence: disputeEvidence }
      : {}),
  };
  const observeTx: Extract<RuntimeTx, { type: 'observeJRange' }> = {
    type: 'observeJRange',
    data: {
      entityId: delivery.entityId,
      signerId: delivery.signerId,
      jurisdictionRef: delivery.jurisdictionRef,
      scannedThroughHeight: options.blockNumber,
      tipBlockHash: options.blockHash.toLowerCase(),
      blocks: [block],
    },
  };
  if (options.logBatch) {
    log.info('event_batch.delivered_to_entity', {
      adapterLabel: options.adapterLabel,
      entityId: shortId(delivery.entityId),
      count: events.length,
    });
  }
  return {
    runtimeTx: markLocalJAuthorityRuntimeTx(observeTx),
    evidence: evidenceEntries(delivery.events, options.blockHash),
  };
};

export const buildJEventObservationInput = (
  env: RuntimeReplica,
  rawEvents: JEventIngress[],
  options: JEventsRuntimeInputOptions,
): JEventsRuntimeInputBuildResult | null => {
  if (rawEvents.length === 0) return null;
  if (options.logBatch) {
    log.info('event_batch.canonical', {
      adapterLabel: options.adapterLabel,
      blockNumber: options.blockNumber,
      count: rawEvents.length,
    });
  }
  const runtimeTxs: RuntimeTx[] = [];
  const entityInputs: EntityInput[] = [];
  const evidence = new Map<string, JEventIngress>();
  const watcher = resolveWatcher(env, options);
  for (const delivery of collectDeliveries(
    env,
    enrichDisputeBatchNonces(rawEvents),
    options.blockNumber,
    watcher,
  )) {
    const built = buildDelivery(env, delivery, options);
    if (!built) continue;
    runtimeTxs.push(built.runtimeTx);
    for (const [key, event] of built.evidence) evidence.set(key, event);
  }
  if (runtimeTxs.length === 0) return null;
  return {
    input: {
      timestamp: Number.isFinite(options.blockNumber) && options.blockNumber > 0
        ? Math.floor(options.blockNumber)
        : 0,
      runtimeTxs,
      entityInputs,
    },
    evidenceEvents: [...evidence.values()],
  };
};

export type { LocalJEventIngressSource };
export { rawEventToJEvents };
