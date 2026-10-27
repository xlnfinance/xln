import { afterEach, expect, test } from 'bun:test';
import type { EntityState } from '@xln/core/entity/types';
import { applyEntityProviderActionExecuted } from '@xln/core/entity/tx/j-events-entity-provider-action';
import { observeTourPayment, useTourObservations } from './observations';
import { tourBaseline } from './outcomes';
import { TOUR_STEPS, type TourContext } from './steps';
import type { PaymentTerminalEvent } from '@xln/frontend/lib/stores/network/paymentTerminalMonitor';
import { owner, company, frame, wallet, account, token, context, done } from './fixtures';

afterEach(() => useTourObservations.setState({}, true));

const chapter = (id: string) => TOUR_STEPS.find(step => step.id === id)!;
const funded = (entityId = owner, amount = 20_000_000n) =>
  wallet({ entityId, frame: frame(entityId, new Map([[1, amount]])), frameHeight: 11 });
const invoice = {
  runtimeId: 'runtime',
  entityId: owner,
  tokenId: 1,
  amount: 5_000_000n,
  description: 'Tutorial invoice',
  fromHeight: 11,
};
const incoming: PaymentTerminalEvent = {
  runtimeId: 'runtime',
  height: 11,
  name: 'HtlcReceived',
  data: {
    entityId: owner,
    toEntity: owner,
    tokenId: 1,
    amount: '5000000',
    description: 'Tutorial invoice',
    hashlock: 'hash',
  },
};
const receiving = () =>
  context({
    before: wallet({ accounts: [account({ tokens: [token(0n, 0n, 10n)] })] }),
    wallet: wallet({ frameHeight: 11, accounts: [account({ tokens: [token(0n, 0n, 5_000_010n)] })] }),
    invoice,
    incoming,
  });

test('Move and Withdraw refresh after prerequisite reserve funding without changing chapters', () => {
  for (const id of ['move', 'withdraw']) {
    const empty = tourBaseline(null, id, wallet());
    const before = tourBaseline(empty, id, funded())!.wallet;
    expect(before.frame!.activeEntity!.core.reserves.get(1)).toBe(20_000_000n);
    const after = funded(owner, 15_000_000n);
    after.frameHeight = 12;
    after.accounts = [account({ tokens: [token(0n, 5_000_000n)] })];
    after.onchain = [{ tokenId: 1, amount: 5_000_000n, pending: 0n, jurisdiction: 'Testnet' }];
    expect(done(id, context({ before, wallet: after }))).toBe(true);
    expect(tourBaseline({ step: id, wallet: before }, id, after)!.wallet).toBe(before);
  }
});

test('each exercise switches baseline with the active entity; Company retains its original personal baseline', () => {
  for (const id of ['shares', 'cover', 'receive', 'move', 'withdraw']) {
    const personal = tourBaseline(null, id, wallet());
    const selected = funded(company);
    const baseline = tourBaseline(personal, id, selected)!;
    expect(baseline.wallet).toBe(selected);
    expect(tourBaseline(baseline, id, wallet())!.wallet.entityId).toBe(owner);
  }
  const personal = tourBaseline(null, 'company', wallet());
  expect(tourBaseline(personal, 'company', funded(company))).toBe(personal);
});

test('Cover explains when the active company has no hub account', () => {
  expect(chapter('cover').skipReason?.(context())).toContain('Select your original personal wallet');
  expect(
    chapter('cover').skipReason?.(context({ wallet: wallet({ accounts: [account({ isHub: false })] }) })),
  ).toBeTruthy();
  expect(chapter('cover').skipReason?.(context({ wallet: wallet({ accounts: [account()] }) }))).toBe('');
});

test('Receive rejects reserve transfers and requires this invoice’s committed incoming payment', () => {
  const ctx = receiving();
  expect(done('receive', ctx)).toBe(true);
  const changes: Partial<TourContext>[] = [
    { incoming: undefined },
    { invoice: undefined },
    { incoming: { ...incoming, name: 'HtlcFinalized' } },
    { incoming: { ...incoming, runtimeId: 'other' } },
    { incoming: { ...incoming, height: 10 } },
    ...[
      { toEntity: company },
      { entityId: company },
      { tokenId: 2 },
      { amount: '4000000' },
      { description: 'Other invoice' },
    ].map(data => ({ incoming: { ...incoming, data: { ...incoming.data, ...data } } })),
    { invoice: { ...invoice, hashlock: 'different' } },
    { invoice: { ...invoice, id: 'invoice-id' } },
  ];
  for (const change of changes) expect(done('receive', { ...ctx, ...change })).toBe(false);
  expect(done('receive', { ...ctx, invoice: { ...invoice, hashlock: 'hash' } })).toBe(true);
  expect(done('receive', { ...ctx, wallet: ctx.before! })).toBe(false);
});

test('Recovery stays until the restored identity commits the instructed payment debit', () => {
  const before = wallet({ accounts: [account({ tokens: [token(0n, 0n, 5_000_000n)] })] });
  const after = wallet({ frameHeight: 11, accounts: [account({ tokens: [token(0n, 0n, 4_000_000n)] })] });
  const restored = { runtimeId: 'runtime', entityIds: [owner], height: 10 };
  const outgoing: PaymentTerminalEvent = {
    runtimeId: 'runtime',
    height: 11,
    name: 'HtlcFinalized',
    data: { entityId: owner, fromEntity: owner, tokenId: 1, amount: '1000000', hashlock: 'paid' },
  };
  const ctx = context({ before, wallet: after, restored, outgoing });
  expect(done('recovery', ctx)).toBe(true);
  expect(done('recovery', { ...ctx, outgoing: undefined })).toBe(false);
  expect(done('recovery', { ...ctx, wallet: { ...before, frameHeight: 11 } })).toBe(false);
  const changes: Partial<PaymentTerminalEvent>[] = [
    { runtimeId: 'other' },
    { height: 10 },
    { name: 'HtlcReceived' },
    { data: { ...outgoing.data, entityId: company } },
    { data: { ...outgoing.data, tokenId: 2 } },
    { data: { ...outgoing.data, amount: '999999' } },
  ];
  for (const change of changes) expect(done('recovery', { ...ctx, outgoing: { ...outgoing, ...change } })).toBe(false);
});

test('Shares requires a strictly newer confirmed action nonce and both committed share reserves', () => {
  const before = wallet({ entityId: company, frame: frame(company) });
  const after = wallet({
    entityId: company,
    frameHeight: 11,
    frame: frame(
      company,
      new Map([
        [8, 10n],
        [9, 10n],
      ]),
    ),
  });
  const shareTokens = { runtimeId: 'runtime', entityId: company, ids: [8, 9] };
  const ctx = context({ before, wallet: after, shareTokens });
  expect(done('shares', ctx)).toBe(false);
  const released = { entityId: company } as EntityState;
  applyEntityProviderActionExecuted(
    released,
    {
      entityId: company,
      actionNonce: 1n,
      actionKind: 1,
      actionHash: `0x${'c'.repeat(64)}`,
    },
    1,
  );
  after.frame!.activeEntity!.core.entityProviderActionState = released.entityProviderActionState!;
  expect(released.entityProviderActionState!.confirmedNonce).toBe(1n);
  expect(done('shares', ctx)).toBe(true);
  before.frame!.activeEntity!.core.entityProviderActionState = { version: 1, confirmedNonce: 1n, generation: 0 };
  expect(done('shares', ctx)).toBe(false);
  after.frame!.activeEntity!.core.entityProviderActionState!.confirmedNonce = 2n;
  expect(done('shares', ctx)).toBe(true);
  after.frame!.activeEntity!.core.reserves.set(9, 0n);
  expect(done('shares', ctx)).toBe(false);
});

test('Governance is exercisable only with a separate registered target, settled CONTROL majority and elapsed delay', () => {
  const takeover = {
    runtimeId: 'runtime',
    entityId: owner,
    targetId: company,
    controlMajority: true,
    proposedBoardHash: `0x${'b'.repeat(64)}`,
    activateAt: 100n,
    currentUnix: 100n,
  };
  const ctx = context({ takeover });
  expect(chapter('governance').skipReason?.(ctx)).toBe('');
  const changes: Partial<TourContext>[] = [
    { takeover: undefined },
    ...[
      { targetId: owner },
      { controlMajority: false },
      { runtimeId: 'other' },
      { entityId: company },
      { currentUnix: 99n },
    ].map(change => ({ takeover: { ...takeover, ...change } })),
  ];
  for (const change of changes) expect(chapter('governance').skipReason?.({ ...ctx, ...change })).toBeTruthy();
});

test('terminal observations retain correlated committed evidence across unrelated receipt notifications', () => {
  useTourObservations.setState({ invoice });
  observeTourPayment(incoming);
  expect(done('receive', { ...receiving(), ...useTourObservations.getState() })).toBe(true);
  observeTourPayment({ ...incoming, data: { ...incoming.data, description: 'Unrelated' } });
  expect(useTourObservations.getState().incoming).toBe(incoming);
  const restored = { runtimeId: 'runtime', entityIds: [owner], height: 10 };
  useTourObservations.setState({ restored });
  const outgoing: PaymentTerminalEvent = {
    ...incoming,
    name: 'HtlcFinalized',
    data: { ...incoming.data, fromEntity: owner, amount: '1000000' },
  };
  observeTourPayment(outgoing);
  observeTourPayment({ ...outgoing, name: 'HtlcFailed' });
  expect(useTourObservations.getState().outgoing).toBe(outgoing);
});
