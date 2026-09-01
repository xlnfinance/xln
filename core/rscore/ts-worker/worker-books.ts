import {
  PAYBOOK_PHYSICAL_SLOT_COUNT,
  paybookPhysicalSlot,
} from '../../entity/books/book-intents';
import type { TsBookWorkerPayload, TsBookWorkerResult } from './protocol';

const reduceSlot = (slot: TsBookWorkerPayload['slots'][number]) => {
  if (!Number.isSafeInteger(slot.physicalSlot)
    || slot.physicalSlot < 0
    || slot.physicalSlot >= PAYBOOK_PHYSICAL_SLOT_COUNT) {
    throw new Error(`TS_BOOK_WORKER_PHYSICAL_SLOT_INVALID:${slot.physicalSlot}`);
  }
  const entries = new Map(slot.entries);
  let feesEarned = slot.feesEarned;
  for (const intent of slot.intents) {
    if (intent.kind === 'paybookFeesSet') {
      if (slot.physicalSlot !== 0) throw new Error('TS_BOOK_WORKER_FEES_SLOT_INVALID');
      feesEarned = intent.feesEarned;
      continue;
    }
    if (paybookPhysicalSlot(intent.hashlock) !== slot.physicalSlot) {
      throw new Error(`TS_BOOK_WORKER_INTENT_SLOT_MISMATCH:${intent.hashlock}:${slot.physicalSlot}`);
    }
    if (intent.kind === 'paybookSet') entries.set(intent.hashlock, intent.entry);
    else entries.delete(intent.hashlock);
  }
  return {
    physicalSlot: slot.physicalSlot,
    entries: [...entries],
    ...(feesEarned === undefined ? {} : { feesEarned }),
  };
};

/** Stateless callback: Book slots are never retained or owned by this worker. */
export const processBookSlots = (
  workerIndex: number,
  payload: TsBookWorkerPayload,
): TsBookWorkerResult => ({
  workerIndex,
  slots: payload.slots.map(reduceSlot),
});
