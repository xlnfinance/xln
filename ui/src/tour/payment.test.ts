import { afterEach, expect, test } from 'bun:test';
import type { PaymentTerminalEvent } from '@xln/frontend/lib/stores/network/paymentTerminalMonitor';
import { context, done, owner, company, wallet } from './fixtures';
import { observeTourPayment, observeTourRestore, pruneTourPayments, useTourObservations } from './observations';
import { useReceipts } from '../runtime/financial/receipt-state';
import type { TourContext } from './steps';

afterEach(() => {
  useTourObservations.setState({}, true);
  useReceipts.getState().dismiss();
});

const outgoing: PaymentTerminalEvent = {
  runtimeId: 'runtime', height: 13, name: 'HtlcFinalized',
  data: { entityId: owner, fromEntity: owner, tokenId: 1, amount: '25000000', hashlock: `0x${'d'.repeat(64)}` },
};
const initiated = { ...outgoing, name: 'HtlcInitiated' as const, height: 12 };
const paying = () => context({
  before: wallet({ frameHeight: 11 }), wallet: wallet({ frameHeight: 13 }),
  outgoing, openedReceipt: outgoing, initiations: [initiated], dom: { has: () => true, text: () => 'Paid', value: () => '' },
});

test('Pay rejects a Paid receipt for a payment sent before chapter entry', () => {
  const ctx = paying();
  expect(done('pay', { ...ctx, openedReceipt: { ...outgoing, height: 11 }, initiations: [{ ...initiated, height: 10 }] })).toBe(false);
  // Finalizing a pre-chapter initiation later is also insufficient.
  for (const height of [10, 11]) {
    expect(done('pay', { ...ctx, initiations: [{ ...initiated, height }] })).toBe(false);
  }
});

test('Pay requires receipt opening in addition to a new committed payment', () => {
  const ctx = paying();
  expect(done('pay', ctx)).toBe(true);
  expect(done('pay', { ...ctx, dom: { ...ctx.dom, text: () => '' } })).toBe(false);
  expect(done('pay', { ...ctx, openedReceipt: null })).toBe(false);
  expect(done('pay', { ...ctx, dom: { ...ctx.dom, has: () => false } })).toBe(false);
});

test('Pay waits for B to be opened when B commits while the user reads old receipt A', () => {
  const a = { ...outgoing, height: 10, data: { ...outgoing.data, hashlock: `0x${'a'.repeat(64)}` } };
  useReceipts.getState().show(a);
  useReceipts.getState().open();
  observeTourPayment(initiated);
  observeTourPayment(outgoing);
  useReceipts.getState().show(outgoing);
  const ctx = () => ({ ...paying(), ...useTourObservations.getState(), openedReceipt: useReceipts.getState().opened });
  expect(done('pay', ctx())).toBe(false);
  useReceipts.getState().open();
  expect(done('pay', ctx())).toBe(true);
  expect(done('pay', { ...ctx(), openedReceipt: { ...outgoing, runtimeId: 'other' } })).toBe(false);
});

test('Recovery discards pre-restore evidence even when restored heights catch up', () => {
  observeTourPayment(initiated);
  observeTourPayment(outgoing);
  observeTourRestore({ runtimeId: 'runtime', entityIds: [owner], height: 8 });
  const ctx = () => ({ ...paying(), ...useTourObservations.getState() });
  expect(done('recovery', ctx())).toBe(false);
  observeTourPayment(outgoing);
  expect(done('recovery', ctx())).toBe(false);
  observeTourPayment(initiated);
  expect(done('recovery', ctx())).toBe(true);
});

test('chapter entry prunes initiations at or below its baseline, preserving newer evidence', () => {
  observeTourPayment({ ...initiated, height: 10 });
  observeTourPayment({ ...initiated, height: 11 });
  observeTourPayment(initiated);
  observeTourPayment(outgoing);
  pruneTourPayments(11);
  expect(useTourObservations.getState().initiations).toEqual([initiated]);
  expect(useTourObservations.getState().outgoing).toBe(outgoing);
  pruneTourPayments(13);
  expect(useTourObservations.getState().initiations).toEqual([]);
});

test('Pay and Recovery require the same bounded, correlated committed payment evidence', () => {
  const ctx = { ...paying(), restored: { runtimeId: 'runtime', entityIds: [owner], height: 11 } };
  const mismatches = [{ entityId: company }, { fromEntity: company }, { hashlock: `0x${'e'.repeat(64)}` },
    { tokenId: 2 }, { amount: '1000000' }];
  const changes: Partial<TourContext>[] = [
    { before: undefined }, { wallet: wallet({ frameHeight: 11 }) },
    { wallet: wallet({ frameHeight: 13, loading: true }) },
    { wallet: wallet({ frameHeight: 13, entityId: company }) },
    { outgoing: undefined }, { initiations: undefined }, { initiations: [] },
    ...[{ runtimeId: 'other' }, { height: 11 }, { height: 14 }, { name: 'HtlcReceived' as const },
      ...[{ hashlock: 'invalid' }, { hashlock: undefined }, { amount: '999999' }, { amount: '-1' }].map(data => ({ data: { ...outgoing.data, ...data } })),
      ...mismatches.map(data => ({ data: { ...outgoing.data, ...data } })),
    ].map(change => ({ outgoing: { ...outgoing, ...change } })),
    ...[{ runtimeId: 'other' }, { height: 11 }, { height: 14 },
      ...mismatches.map(data => ({ data: { ...initiated.data, ...data } })),
    ].map(change => ({ initiations: [{ ...initiated, ...change }] })),
  ];
  for (const id of ['pay', 'recovery']) {
    expect(done(id, ctx)).toBe(true);
    for (const change of changes) {
      const receipt = id === 'pay' && 'outgoing' in change ? { openedReceipt: change.outgoing } : {};
      expect(done(id, { ...ctx, ...change, ...receipt })).toBe(false);
    }
    // Same-frame initiation/finalization and offsetting credit are valid.
    expect(done(id, { ...ctx, initiations: [{ ...initiated, height: 13 }] })).toBe(true);
  }
});

test('Pay collects committed initiation and finalization without a prior restore', () => {
  observeTourPayment(initiated);
  observeTourPayment(outgoing);
  observeTourPayment({ ...outgoing, name: 'HtlcFailed' });
  const observations = useTourObservations.getState();
  expect(observations.initiations).toEqual([initiated]);
  expect(observations.outgoing).toBe(outgoing);
  expect(done('pay', { ...paying(), ...observations })).toBe(true);
});
