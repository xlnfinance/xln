import { signAccountFrame } from '../../account/crypto';
import { createAccountConsensusContext } from '../../entity/account/account-consensus-context';
import { applyJEvent } from '../../entity/tx/j-events';
import {
  buildJEventRangeDigest,
  canonicalJEventRangeHash,
  foldJHistoryRoot,
} from '../../jurisdiction/machine/history-consensus';
import { canonicalJurisdictionEventsHash, getJEventJurisdictionRef } from '../../jurisdiction/machine/event-observation';
import { finalizedJHistoryRoot } from '../../jurisdiction/machine/local-history';
import type { DisputeFinalizationEvidence, JurisdictionEvent, JurisdictionEventData } from '../../types/jurisdiction-events';
import type { EntityState } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import type { JEventApplyResult } from '../../entity/tx/j-events-types';
import {
  applyBookIntentProgram,
  createBookIntentProgram,
} from '../../entity/books/book-intents';

export type TestJEventRangeInput = {
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
  env: RuntimeReplica,
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
  data: TestJEventRangeInput,
  env: RuntimeReplica,
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
      ...(data.disputeFinalizationEvidenceHash
        ? { disputeFinalizationEvidenceHash: data.disputeFinalizationEvidenceHash }
        : {}),
    }]),
    rangeHash: canonicalJEventRangeHash(jurisdictionRef, blocks),
    blocks,
  };
  return signRange(state, env, data.from, unsigned);
};

export const applyJEventRange = async (
  state: EntityState,
  data: TestJEventRangeInput,
  env: RuntimeReplica,
): Promise<JEventApplyResult> => {
  const bookIntents = createBookIntentProgram();
  const result = await applyJEvent(
    state,
    buildJEventRangeData(state, data, env),
    env,
    createAccountConsensusContext(env),
    [],
    false,
    bookIntents.openSlot(),
  );
  applyBookIntentProgram(result.newState, bookIntents);
  return result;
};
