import { signAccountFrame } from '../../account/crypto';
import { applyJEvent } from '../../entity/tx/j-events';
import {
  buildJEventRangeDigest,
  canonicalJEventRangeHash,
  foldJHistoryRoot,
} from '../../jurisdiction/history-consensus';
import { canonicalJurisdictionEventsHash, getJEventJurisdictionRef } from '../../jurisdiction/event-observation';
import { finalizedJHistoryRoot } from '../../jurisdiction/local-history';
import type {
  DisputeFinalizationEvidence,
  EntityState,
  Env,
  JurisdictionEvent,
  JurisdictionEventData,
} from '../../types';
import type { JEventApplyResult } from '../../entity/tx/j-events-types';

export type LegacyJEventInput = {
  from: string;
  jurisdictionRef: string;
  event: JurisdictionEvent;
  events?: JurisdictionEvent[];
  observedAt: number;
  blockNumber: number;
  blockHash: string;
  transactionHash?: string;
  eventsHash?: string;
  signature?: string;
  disputeFinalizationEvidence?: DisputeFinalizationEvidence[];
  disputeFinalizationEvidenceHash?: string;
};

const signRange = (
  state: EntityState,
  env: Env,
  signerId: string,
  unsigned: Omit<JurisdictionEventData, 'from' | 'signature' | 'observedAt'>,
): JurisdictionEventData => ({
  from: signerId,
  observedAt: unsigned.scannedThroughHeight,
  signature: signAccountFrame(env, signerId, buildJEventRangeDigest({
    entityId: state.entityId,
    signerId,
    ...unsigned,
  })),
  ...unsigned,
});

export const buildJEventRangeData = (
  state: EntityState,
  data: LegacyJEventInput,
  env: Env,
): JurisdictionEventData => {
  const events = (data.events ?? [data.event]).map((event, index) => ({
    ...event,
    blockNumber: data.blockNumber,
    blockHash: data.blockHash,
    ...(event.transactionHash || data.transactionHash
      ? { transactionHash: event.transactionHash ?? data.transactionHash }
      : {}),
    logIndex: event.logIndex ?? index,
    eventIndex: event.eventIndex ?? 0,
  })) as JurisdictionEvent[];
  const eventsHash = canonicalJurisdictionEventsHash(events);
  const evidence = data.disputeFinalizationEvidence ?? [];
  const blocks: JurisdictionEventData['blocks'] = [{
    blockNumber: data.blockNumber,
    blockHash: data.blockHash,
    eventsHash,
    events,
    ...(evidence.length > 0 ? { disputeFinalizationEvidence: evidence } : {}),
    ...(data.disputeFinalizationEvidenceHash
      ? { disputeFinalizationEvidenceHash: data.disputeFinalizationEvidenceHash }
      : {}),
  }];
  const jurisdictionRef = getJEventJurisdictionRef(state.config.jurisdiction);
  const unsigned = {
    jurisdictionRef,
    baseHeight: state.lastFinalizedJHeight,
    scannedThroughHeight: data.blockNumber,
    tipBlockHash: data.blockHash,
    eventHistoryRoot: foldJHistoryRoot(finalizedJHistoryRoot(state), [{
      jurisdictionRef,
      jHeight: data.blockNumber,
      jBlockHash: data.blockHash,
      eventsHash,
    }]),
    rangeHash: canonicalJEventRangeHash(jurisdictionRef, blocks),
    blocks,
  };
  return signRange(state, env, data.from, unsigned);
};

export const applyJEventRange = async (
  state: EntityState,
  data: LegacyJEventInput,
  env: Env,
): Promise<JEventApplyResult> => applyJEvent(state, buildJEventRangeData(state, data, env), env);
