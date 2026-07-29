import { LIMITS } from '../../config/constants';
import { safeStringify } from '../../protocol/serialization';
import type { EntityFrameEvent } from '../types';

/**
 * Entity events are signed history, not live state. They still cross the
 * consensus boundary, so an adversarial proposer must not be able to attach an
 * unbounded event payload to an otherwise valid frame.
 */
export const MAX_ENTITY_FRAME_EVENT_BYTES = LIMITS.MAX_FRAME_SIZE_BYTES;

export const getEntityFrameEventByteLength = (events: EntityFrameEvent[]): number =>
  new TextEncoder().encode(safeStringify(events)).byteLength;

export const assertEntityFrameEventByteBudget = (events: EntityFrameEvent[]): void => {
  const byteLength = getEntityFrameEventByteLength(events);
  if (byteLength > MAX_ENTITY_FRAME_EVENT_BYTES) {
    throw new Error(
      `ENTITY_FRAME_EVENT_BYTE_LIMIT_EXCEEDED:${byteLength}:${MAX_ENTITY_FRAME_EVENT_BYTES}`,
    );
  }
};

export const entityFrameEventsEqual = (
  derived: EntityFrameEvent[],
  committed: EntityFrameEvent[],
): boolean => {
  if (derived.length !== committed.length) return false;
  return derived.every((event, index) => {
    const candidate = committed[index];
    if (!candidate || candidate.type !== event.type || candidate.message !== event.message) return false;
    return event.type === 'status' ||
      (candidate.type === 'text' && candidate.validatorId === event.validatorId);
  });
};
