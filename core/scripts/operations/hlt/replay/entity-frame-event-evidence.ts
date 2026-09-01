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

/**
 * A Runtime frame's flat outbox is persisted and digested at the same WAL
 * commit as the Runtime state. Read its proposed EntityFrames in positional
 * output order; the next inbound proposal belongs to a later Runtime frame.
 */
export const buildHltEntityFrameEventEvidence = (
  frame: PersistedFrameJournal,
): HltEntityFrameEventEvidence => {
  const events: EntityFrameEvent[] = (frame.runtimeOutputs ?? []).flatMap(
    output => output.proposedFrame?.events ?? [],
  );
  const digest = sha256.create();
  digest.update(ENTITY_EVENTS_PARITY_DOMAIN);
  digest.update(encodeBinaryPayload(events));
  return {
    runtimeHeight: frame.height,
    eventCount: events.length,
    orderedEventDigest: `0x${Buffer.from(digest.digest()).toString('hex')}`,
  };
};
