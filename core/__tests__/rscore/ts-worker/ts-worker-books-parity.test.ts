import { expect, test } from 'bun:test';
import {
  applyBookIntentProgram,
  createBookIntentProgram,
} from '../../../entity/books/book-intents';
import { TsAccountWorkerCoordinator } from '../../../rscore/ts-worker/coordinator';
import { encodeCanonicalConsensusBytes } from '../../../protocol/serialization/binary-codec';
import { computeIntegrityDigest } from '../../../support/bytes/integrity-checksum';

const id = (byte: string): string => `0x${byte.repeat(64)}`;
const OWNER = id('a');

const fixture = () => {
  const first = id('1');
  const second = id('2');
  const removed = id('3');
  const state = {
    paybook: {
      entries: new Map([
        [first, { hashlock: first, pendingFee: 2n, createdTimestamp: 1 }],
        [removed, { hashlock: removed, createdTimestamp: 1 }],
      ]),
      feesEarned: 4n,
    },
  } as any;
  const program = createBookIntentProgram();
  const writable = program.openSlot().getPaybookEntryForWrite(state, first);
  if (!writable) throw new Error('TEST_BOOK_ENTRY_MISSING');
  writable.secret = id('7');
  delete writable.pendingFee;
  program.openSlot().putPaybookEntry(state, second, {
    hashlock: second,
    inboundEntity: id('8'),
    createdTimestamp: 2,
  });
  program.openSlot().deletePaybookEntry(state, removed);
  program.openSlot().addPaybookFees(state, 2n);
  return { state, program };
};

const run = async (workerCount: 1 | 4) => {
  const { state, program } = fixture();
  const coordinator = await TsAccountWorkerCoordinator.create({
    ownerEntityId: OWNER,
    workerCount,
    accounts: new Map(),
  });
  try {
    await coordinator.applyAccountInputs({
      frameId: `books-w${workerCount}`,
      expectedAccountsRoot: coordinator.accountsRoot,
      entityTimestamp: 1,
      finalizedJHeight: 0,
      owningEntityIsHub: false,
      inputs: [],
    });
    const result = await coordinator.applyBookIntents(state, program.slots());
    return { state, result };
  } finally {
    coordinator.close();
  }
};

test('Book worker W1/W4 equals the positional local oracle', async () => {
  const oracle = fixture();
  applyBookIntentProgram(oracle.state, oracle.program);
  const w1 = await run(1);
  const w4 = await run(4);

  expect(w1.state.paybook).toEqual(oracle.state.paybook);
  expect(w4.state.paybook).toEqual(oracle.state.paybook);
  expect(w1.state.paybook).toEqual(w4.state.paybook);
  const digest = (value: unknown): string =>
    computeIntegrityDigest(encodeCanonicalConsensusBytes(value));
  expect(digest(w1.state.paybook)).toBe(digest(oracle.state.paybook));
  expect(digest(w4.state.paybook)).toBe(digest(oracle.state.paybook));
  expect(w1.result).toEqual({ activeSlots: 4, workers: 1 });
  expect(w4.result).toEqual({ activeSlots: 4, workers: 4 });
});
