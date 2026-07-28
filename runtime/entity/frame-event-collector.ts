/**
 * Reducer-local carrier for events derived while applying one Entity frame.
 *
 * It is enumerable so immutable object spreads preserve it, but every
 * consensus and storage projection must explicitly exclude it. The next frame
 * clears the array before applying transactions.
 */
export const ENTITY_FRAME_EVENT_COLLECTOR = '__xlnEntityFrameEvents' as const;
