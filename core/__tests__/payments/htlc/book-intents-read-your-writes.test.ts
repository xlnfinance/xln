import { expect, test } from 'bun:test';
import {
  applyBookIntentProgram,
  createBookIntentProgram,
} from '../../../entity/books/book-intents';
import { initCrontab } from '../../../entity/scheduler';
import { applyCommittedAccountFrameFollowups } from '../../../entity/tx/handlers/account/committed-frame-followups';
import { applyHtlcSecretFollowups } from '../../../entity/tx/handlers/account/committed-htlc-followups';
import { programPaymentTermination } from '../../../entity/paybook/lifecycle';
import { hashHtlcSecret } from '../../../protocol/htlc/utils';

const id = (byte: string): string => `0x${byte.repeat(64)}`;

test('Book program preserves create -> secret/fee -> delete read-your-writes order', () => {
  const hashlock = id('4');
  const inboundEntity = id('1');
  const state = {
    entityId: id('2'),
    timestamp: 100,
    paybook: { entries: new Map(), feesEarned: 0n },
    accounts: new Map(),
    crontabState: initCrontab(),
  } as any;
  const program = createBookIntentProgram();
  program.openSlot().putPaybookEntry(state, hashlock, {
    hashlock,
    tokenId: 1,
    amount: 10n,
    inboundEntity,
    outboundEntity: id('3'),
    pendingFee: 1n,
    createdTimestamp: 1,
  });
  const accountTxs: Array<{ accountId: string; tx: unknown }> = [];
  applyHtlcSecretFollowups({
    env: {},
    state,
    newState: state,
    outputs: [],
    accountTxs,
    candidateEffects: [],
    bookIntentSlot: program.openSlot(),
  } as never, [{ secret: id('7'), hashlock }]);
  programPaymentTermination(state, hashlock, program.openSlot());

  expect(state.paybook).toEqual({ entries: new Map(), feesEarned: 0n });
  expect(accountTxs).toEqual([{
    accountId: inboundEntity,
    tx: { type: 'htlc_resolve', data: { lockId: hashlock, outcome: 'secret', secret: id('7') } },
  }]);
  expect(program.slots().map(slot => [slot.position, slot.intents.map(intent => intent.kind)]))
    .toEqual([
      [0, ['paybookSet']],
      [1, ['paybookSet', 'paybookFeesSet']],
      [2, ['paybookDelete']],
    ]);

  applyBookIntentProgram(state, program);
  expect(state.paybook).toEqual({ entries: new Map(), feesEarned: 1n });
  expect(state.crontabState.hooks.has(`htlc-secret-ack:${hashlock}`)).toBe(false);
});

test('committed resolve followups observe earlier settled flags before deleting route', () => {
  const secret = id('7');
  const hashlock = hashHtlcSecret(secret);
  const inboundEntity = id('1');
  const outboundEntity = id('3');
  const state = {
    entityId: id('2'),
    timestamp: 100,
    paybook: { entries: new Map([[hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      originated: true,
      inboundEntity,
      outboundEntity,
      createdTimestamp: 1,
    }]]), feesEarned: 0n },
    accounts: new Map(),
  } as any;
  const program = createBookIntentProgram();
  const committedFrame = {
    height: 1,
    stateHash: id('9'),
    accountTxs: [{
      type: 'htlc_resolve',
      data: { lockId: hashlock, outcome: 'secret', secret },
    }],
  } as any;

  applyCommittedAccountFrameFollowups(
    state, inboundEntity, committedFrame, true, [], undefined, [], program.openSlot(),
  );
  expect(program.slots()[0]?.intents).toMatchObject([{ kind: 'paybookSet' }]);
  applyCommittedAccountFrameFollowups(
    state, outboundEntity, committedFrame, true, [], undefined, [], program.openSlot(),
  );
  expect(program.slots()[1]?.intents.map(intent => intent.kind)).toEqual([
    'paybookSet',
    'paybookDelete',
  ]);
  expect(state.paybook.entries.has(hashlock)).toBe(true);

  applyBookIntentProgram(state, program);
  expect(state.paybook.entries.has(hashlock)).toBe(false);
});
