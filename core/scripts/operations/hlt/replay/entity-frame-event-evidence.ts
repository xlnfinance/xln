import { sha256 } from '@noble/hashes/sha2.js';

import { encodeBinaryPayload } from '../../../../protocol/serialization/binary-codec';
import { Buffer } from '../../../../support/platform-crypto';
import type { EntityFrameEvent } from '../../../../entity/types';
import type { PersistedFrameJournal } from '../../../../storage/types';

const ENTITY_EVENTS_PARITY_DOMAIN = Buffer.from('xln.rscore.events-parity.v1', 'utf8');

export type HltEntityFrameEventEvidence = Readonly<{
  runtimeHeight: number;
  eventCount: number;
  orderedEventDigest: string;
}>;

export const buildHltEntityFrameEventEvidenceFromEvents = (
  runtimeHeight: number,
  events: readonly EntityFrameEvent[],
): HltEntityFrameEventEvidence => {
  const digest = sha256.create();
  digest.update(ENTITY_EVENTS_PARITY_DOMAIN);
  digest.update(encodeBinaryPayload(events));
  return {
    runtimeHeight,
    eventCount: events.length,
    orderedEventDigest: `0x${Buffer.from(digest.digest()).toString('hex')}`,
  };
};

/** Project EntityFrames that crossed the Runtime outbox boundary. */
export const buildHltEntityFrameEventEvidence = (
  frame: PersistedFrameJournal,
): HltEntityFrameEventEvidence =>
  buildHltEntityFrameEventEvidenceFromEvents(
    frame.height,
    (frame.runtimeOutputs ?? []).flatMap(
    output => output.proposedFrame?.events ?? [],
    ),
  );
