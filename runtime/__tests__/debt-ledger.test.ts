import { describe, expect, test } from 'bun:test';

import { decode, encode } from '../snapshot-coder';
import { cloneEntityState } from '../state-helpers';
import { handleJEvent, type JEventEntityTxData } from '../entity-tx/j-events';
import { createEmptyEnv } from '../runtime';
import type { ConsensusConfig, EntityState, JurisdictionEvent } from '../types';

const SIGNER_ID = '0x1111111111111111111111111111111111111111';
const ALICE = `0x${'11'.repeat(32)}`;
const BOB = `0x${'22'.repeat(32)}`;

const makeConfig = (): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [SIGNER_ID],
  shares: { [SIGNER_ID]: 1n },
});

const makeState = (entityId: string): EntityState => ({
  entityId,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: makeConfig(),
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockObservations: [],
  jBlockChain: [],
  entityEncPubKey: `${'0x'}${'11'.repeat(32)}`,
  entityEncPrivKey: `${'0x'}${'22'.repeat(32)}`,
  profile: {
    name: entityId === ALICE ? 'Alice' : 'Bob',
    isHub: false,
    avatar: '',
    bio: '',
    website: '',
  },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  swapBook: new Map(),
  lockBook: new Map(),
  swapTradingPairs: [],
  pendingSwapFillRatios: new Map(),
});

const makeJEventInput = (event: JurisdictionEvent, blockNumber: number, transactionHash: string): JEventEntityTxData => ({
  from: SIGNER_ID,
  event,
  observedAt: 1_000 + blockNumber,
  blockNumber,
  blockHash: `0x${String(blockNumber).padStart(64, '0')}`,
  transactionHash,
});

const findOnlyDebt = (state: EntityState, direction: 'out' | 'in', tokenId = 1) => {
  const bucket = (direction === 'out' ? state.outDebtsByToken : state.inDebtsByToken)?.get(tokenId);
  expect(bucket?.size).toBe(1);
  return Array.from(bucket!.values())[0]!;
};

describe('debt ledger', () => {
  test('mirrors debt lifecycle on debtor and creditor sides and survives clone/persist', async () => {
    const env = createEmptyEnv('debt-ledger-seed');
    env.quietRuntimeLogs = true;

    let aliceState = makeState(ALICE);
    let bobState = makeState(BOB);

    const created: JurisdictionEvent = {
      type: 'DebtCreated',
      blockNumber: 12,
      transactionHash: `0x${'aa'.repeat(32)}`,
      data: {
        debtor: ALICE,
        creditor: BOB,
        tokenId: 1,
        amount: '150',
        debtIndex: 3,
      },
    };

    aliceState = (await handleJEvent(aliceState, makeJEventInput(created, 12, String(created.transactionHash)), env)).newState;
    bobState = (await handleJEvent(bobState, makeJEventInput(created, 12, String(created.transactionHash)), env)).newState;

    const aliceOpen = findOnlyDebt(aliceState, 'out');
    const bobIncoming = findOnlyDebt(bobState, 'in');

    expect(aliceOpen.direction).toBe('out');
    expect(aliceOpen.counterparty).toBe(BOB);
    expect(aliceOpen.createdAmount).toBe(150n);
    expect(aliceOpen.remainingAmount).toBe(150n);
    expect(aliceOpen.status).toBe('open');
    expect(bobIncoming.direction).toBe('in');
    expect(bobIncoming.counterparty).toBe(ALICE);
    expect(bobIncoming.debtId).toBe(aliceOpen.debtId);

    const enforced: JurisdictionEvent = {
      type: 'DebtEnforced',
      blockNumber: 13,
      transactionHash: `0x${'bb'.repeat(32)}`,
      data: {
        debtor: ALICE,
        creditor: BOB,
        tokenId: 1,
        amountPaid: '100',
        remainingAmount: '50',
        newDebtIndex: 7,
      },
    };

    aliceState = (await handleJEvent(aliceState, makeJEventInput(enforced, 13, String(enforced.transactionHash)), env)).newState;
    bobState = (await handleJEvent(bobState, makeJEventInput(enforced, 13, String(enforced.transactionHash)), env)).newState;

    const alicePartial = findOnlyDebt(aliceState, 'out');
    const bobPartial = findOnlyDebt(bobState, 'in');
    expect(alicePartial.paidAmount).toBe(100n);
    expect(alicePartial.remainingAmount).toBe(50n);
    expect(alicePartial.currentDebtIndex).toBe(7);
    expect(alicePartial.status).toBe('open');
    expect(alicePartial.updates.map((update) => update.eventType)).toEqual(['DebtCreated', 'DebtEnforced']);
    expect(bobPartial.paidAmount).toBe(100n);
    expect(bobPartial.remainingAmount).toBe(50n);

    const forgiven: JurisdictionEvent = {
      type: 'DebtForgiven',
      blockNumber: 14,
      transactionHash: `0x${'cc'.repeat(32)}`,
      data: {
        debtor: ALICE,
        creditor: BOB,
        tokenId: 1,
        amountForgiven: '50',
        debtIndex: 7,
      },
    };

    aliceState = (await handleJEvent(aliceState, makeJEventInput(forgiven, 14, String(forgiven.transactionHash)), env)).newState;
    bobState = (await handleJEvent(bobState, makeJEventInput(forgiven, 14, String(forgiven.transactionHash)), env)).newState;

    const aliceSettled = findOnlyDebt(aliceState, 'out');
    const bobSettled = findOnlyDebt(bobState, 'in');
    expect(aliceSettled.forgivenAmount).toBe(50n);
    expect(aliceSettled.remainingAmount).toBe(0n);
    expect(aliceSettled.status).toBe('forgiven');
    expect(aliceSettled.currentDebtIndex).toBeNull();
    expect(aliceSettled.updates.map((update) => update.eventType)).toEqual(['DebtCreated', 'DebtEnforced', 'DebtForgiven']);
    expect(bobSettled.status).toBe('forgiven');

    const cloned = cloneEntityState(aliceState);
    const clonedDebt = findOnlyDebt(cloned, 'out');
    expect(clonedDebt.updates.map((update) => update.eventType)).toEqual(['DebtCreated', 'DebtEnforced', 'DebtForgiven']);
    expect(clonedDebt.remainingAmount).toBe(0n);

    const restored = decode<EntityState>(encode(aliceState));
    const restoredDebt = findOnlyDebt(restored, 'out');
    expect(restoredDebt.status).toBe('forgiven');
    expect(restoredDebt.paidAmount).toBe(100n);
    expect(restoredDebt.forgivenAmount).toBe(50n);
    expect(restoredDebt.updates).toHaveLength(3);
  });
});
