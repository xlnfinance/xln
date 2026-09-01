import type { EntityState, PaybookEntry } from '../types';

export type BookIntent = Readonly<{
  kind: 'paybookSet';
  hashlock: string;
  entry: PaybookEntry;
}> | Readonly<{
  kind: 'paybookDelete';
  hashlock: string;
}> | Readonly<{
  kind: 'paybookFeesSet';
  feesEarned: bigint;
}>;

export type BookIntentSlot = Readonly<{
  position: number;
  intents: readonly BookIntent[];
}>;

export type BookIntentSlotWriter = Readonly<{
  hasPaybookEntry(state: EntityState, hashlock: string): boolean;
  getPaybookEntry(state: EntityState, hashlock: string): PaybookEntry | undefined;
  getPaybookEntryForWrite(state: EntityState, hashlock: string): PaybookEntry | undefined;
  putPaybookEntry(state: EntityState, hashlock: string, entry: PaybookEntry): void;
  deletePaybookEntry(state: EntityState, hashlock: string): boolean;
  addPaybookFees(state: EntityState, amount: bigint): void;
}>;

export type BookIntentProgram = Readonly<{
  openSlot(): BookIntentSlotWriter;
  slots(): readonly BookIntentSlot[];
}>;

export const PAYBOOK_PHYSICAL_SLOT_COUNT = 256;

export const paybookPhysicalSlot = (hashlock: string): number => {
  const normalized = hashlock.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`PAYBOOK_PHYSICAL_SLOT_HASHLOCK_INVALID:${hashlock}`);
  }
  return Number.parseInt(normalized.slice(2, 4), 16);
};

/**
 * Frame-local Book program. Slots are allocated in Entity transaction order;
 * workers may execute independent physical shards in any order, but the fold
 * always consumes these dense positions and each slot's natural intent order.
 */
export const createBookIntentProgram = (): BookIntentProgram => {
  const slots: Array<{ position: number; intents: BookIntent[] }> = [];
  const pendingPaybook = new Map<string, PaybookEntry | null>();
  let pendingFees: bigint | undefined;
  const read = (state: EntityState, hashlock: string): PaybookEntry | undefined => {
    const pending = pendingPaybook.get(hashlock);
    if (pending !== undefined) return pending ?? undefined;
    return state.paybook.entries.get(hashlock);
  };
  return Object.freeze({
    openSlot(): BookIntentSlotWriter {
      const slot = { position: slots.length, intents: [] as BookIntent[] };
      slots.push(slot);
      return Object.freeze({
        hasPaybookEntry(state: EntityState, hashlock: string): boolean {
          return read(state, hashlock) !== undefined;
        },
        getPaybookEntry(state: EntityState, hashlock: string): PaybookEntry | undefined {
          return read(state, hashlock);
        },
        getPaybookEntryForWrite(state: EntityState, hashlock: string): PaybookEntry | undefined {
          const current = read(state, hashlock);
          if (!current) return undefined;
          // Migrated handlers mutate only top-level PaybookEntry fields. Keep
          // the candidate isolated without serializing immutable nested relay data.
          const entry = { ...current };
          pendingPaybook.set(hashlock, entry);
          slot.intents.push({ kind: 'paybookSet', hashlock, entry });
          return entry;
        },
        putPaybookEntry(state: EntityState, hashlock: string, entry: PaybookEntry): void {
          if (read(state, hashlock) !== undefined) {
            throw new Error(`BOOK_INTENT_PAYBOOK_PUT_DUPLICATE:${hashlock}`);
          }
          pendingPaybook.set(hashlock, entry);
          slot.intents.push({ kind: 'paybookSet', hashlock, entry });
        },
        deletePaybookEntry(state: EntityState, hashlock: string): boolean {
          if (read(state, hashlock) === undefined) return false;
          pendingPaybook.set(hashlock, null);
          slot.intents.push({ kind: 'paybookDelete', hashlock });
          return true;
        },
        addPaybookFees(state: EntityState, amount: bigint): void {
          pendingFees = (pendingFees ?? state.paybook.feesEarned) + amount;
          slot.intents.push({ kind: 'paybookFeesSet', feesEarned: pendingFees });
        },
      });
    },
    slots(): readonly BookIntentSlot[] {
      return slots;
    },
  });
};

/** Apply one completed Books stage in canonical positional order. */
export const applyBookIntentProgram = (
  state: EntityState,
  program: BookIntentProgram,
): void => {
  let expectedPosition = 0;
  for (const slot of program.slots()) {
    if (slot.position !== expectedPosition) {
      throw new Error(`BOOK_INTENT_SLOT_POSITION:${slot.position}:${expectedPosition}`);
    }
    expectedPosition += 1;
    for (const intent of slot.intents) {
      if (intent.kind === 'paybookSet') {
        state.paybook.entries.set(intent.hashlock, intent.entry);
      } else if (intent.kind === 'paybookDelete') {
        state.paybook.entries.delete(intent.hashlock);
      } else if (intent.kind === 'paybookFeesSet') {
        state.paybook.feesEarned = intent.feesEarned;
      }
    }
  }
};
