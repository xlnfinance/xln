import { expect, test } from 'bun:test';
import { addr, entity, makeJurisdiction, makeState } from '../../../../core/__tests__/helpers/cross-j';
import { applyDebtCreated, applyDebtEnforced } from '../../../../core/entity/tx/j-events-observations/debt';
import { projectEntityCoreDoc } from '../../../../core/storage/read/projections';
import { compactEntityCoreForRemote } from '../../../../core/api/runtime-adapter/read/compact-view';
import { emptyPageMeta } from '../../../../core/api/runtime-adapter/read/context';
import type { EntityState } from '../../../../core/entity/types';
import type { RuntimeAdapterViewFrame } from '@xln/core/api/public/runtime-module';
import { availableAt } from './move';

const debtor = entity('22');
const creditor = entity('11');
const frameFor = (state: EntityState): RuntimeAdapterViewFrame => ({
  head: {
    schemaVersion: 1,
    latestHeight: 0,
    latestMaterializedHeight: 0,
    latestSnapshotHeight: 0,
    snapshotPeriodFrames: 1,
    retainSnapshots: 1,
    epochMaxBytes: 1,
    accountMerkleRadix: 16,
    epochReplayBytes: 0,
    retainedWalBytes: 0,
  },
  height: 0,
  entities: [],
  activeEntityId: debtor,
  activeEntity: {
    summary: { entityId: debtor, label: 'Debtor', height: 0 },
    core: compactEntityCoreForRemote(projectEntityCoreDoc(state)),
    accounts: { ...emptyPageMeta(20), items: [] },
    books: { ...emptyPageMeta(20), items: [] },
  },
});
const reserveAvailable = (frame: RuntimeAdapterViewFrame, tokenId: number): bigint =>
  availableAt('reserve', { entityId: debtor, frame, accounts: [] }, tokenId, '', []);

test('Move subtracts all debts before bounded details, including the twenty-first token and claim', () => {
  const state = makeState(debtor, addr('33'), makeJurisdiction('Ethereum', 31_337, 'dd', 'ee'));
  for (let tokenId = 1; tokenId <= 21; tokenId++) {
    state.reserves.set(tokenId, 1_500n);
    for (let debtIndex = 0; debtIndex <= 20; debtIndex++) {
      applyDebtCreated(state, {
        type: 'DebtCreated',
        blockNumber: 1,
        transactionHash: `0x${'44'.repeat(32)}`,
        data: { creditor, debtor, tokenId, amount: '50', debtIndex },
      });
    }
  }
  const frame = frameFor(state);
  expect(frame.activeEntity?.core.outDebtsByToken?.size).toBe(20);
  expect(frame.activeEntity?.core.outDebtsByToken?.get(1)?.size).toBe(20);
  expect(frame.activeEntity?.core.outDebtsByToken?.has(21)).toBe(false);
  expect(reserveAvailable(frame, 1)).toBe(450n);
  expect(reserveAvailable(frame, 21)).toBe(450n);
  state.reserves.set(21, 1_000n);
  expect(reserveAvailable(frameFor(state), 21)).toBe(0n);
});

test('fully repaid debt stops reducing Move availability; missing debt never creates extra reserve', () => {
  const state = makeState(debtor, addr('33'), makeJurisdiction('Ethereum', 31_337, 'dd', 'ee'));
  state.reserves.set(1, 100n);
  applyDebtCreated(state, {
    type: 'DebtCreated',
    blockNumber: 1,
    transactionHash: `0x${'44'.repeat(32)}`,
    data: { creditor, debtor, tokenId: 1, amount: '50', debtIndex: 0 },
  });
  expect(reserveAvailable(frameFor(state), 1)).toBe(50n);
  applyDebtEnforced(state, {
    type: 'DebtEnforced',
    blockNumber: 2,
    transactionHash: `0x${'55'.repeat(32)}`,
    data: { creditor, debtor, tokenId: 1, amountPaid: '50', remainingAmount: '0', newDebtIndex: 1 },
  });
  const after = frameFor(state);
  expect(after.activeEntity?.core.debtTotals.outgoing.has(1)).toBe(false);
  expect(reserveAvailable(after, 1)).toBe(100n);
  expect(reserveAvailable(after, 2)).toBe(0n);
});
