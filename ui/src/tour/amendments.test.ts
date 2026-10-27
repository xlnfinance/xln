import { afterEach, expect, test } from 'bun:test';
import type { EntityState } from '@xln/core/entity/types';
import { applyEntityProviderActionExecuted } from '@xln/core/entity/tx/j-events-entity-provider-action';
import { projectEntityCoreDoc } from '@xln/core/storage/read/projections';
import { compactEntityCoreForRemote } from '@xln/core/api/runtime-adapter/read/compact-view';
import { PersistentEntityAccountMap } from '@xln/core/entity/state/persistent-account-map';
import { computeEntityAccountValueHash } from '@xln/core/entity/consensus/state-root';
import { recomputeEntityProviderActionHash } from '@xln/core/entity/entity-provider-action';
import type { EntityProviderActionIntent } from '@xln/core/types/entity-provider-actions';
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

test('Recovery requires a specific durable payment, even when an incoming credit offsets its debit', () => {
  const before = wallet({ accounts: [account({ tokens: [token(0n, 0n, 5_000_000n)] })] });
  const after = wallet({ frameHeight: 11, accounts: [account({ tokens: [token(0n, 0n, 4_000_000n)] })] });
  const restored = { runtimeId: 'runtime', entityIds: [owner], height: 10 };
  const outgoing: PaymentTerminalEvent = {
    runtimeId: 'runtime',
    height: 11,
    name: 'HtlcFinalized',
    data: { entityId: owner, fromEntity: owner, tokenId: 1, amount: '1000000', hashlock: `0x${'d'.repeat(64)}` },
  };
  const initiated = { ...outgoing, name: 'HtlcInitiated' as const };
  const ctx = context({ before, wallet: after, restored, outgoing, initiations: [initiated] });
  expect(done('recovery', ctx)).toBe(true);
  expect(done('recovery', { ...ctx, outgoing: undefined })).toBe(false);
  // A concurrent 1 USDC credit leaves the net balance unchanged; the durable
  // initiation and finalization still prove this hashlock's committed payment.
  expect(done('recovery', { ...ctx, wallet: { ...before, frameHeight: 11 } })).toBe(true);
  expect(done('recovery', { ...ctx, wallet: before })).toBe(false);
  const changes: Partial<PaymentTerminalEvent>[] = [
    { runtimeId: 'other' },
    { height: 10 },
    { height: 12 },
    { name: 'HtlcReceived' },
    { data: { ...outgoing.data, entityId: company } },
    { data: { ...outgoing.data, fromEntity: company } },
    { data: { ...outgoing.data, hashlock: undefined } },
    { data: { ...outgoing.data, hashlock: 'invalid' } },
    { data: { ...outgoing.data, tokenId: 2 } },
    { data: { ...outgoing.data, amount: '999999' } },
  ];
  for (const change of changes) expect(done('recovery', { ...ctx, outgoing: { ...outgoing, ...change } })).toBe(false);
  for (const change of [
    { runtimeId: 'other' }, { height: 12 },
    ...[{ entityId: company }, { fromEntity: company }, { hashlock: `0x${'e'.repeat(64)}` },
      { tokenId: 2 }, { amount: '2000000' }].map(data => ({ data: { ...initiated.data, ...data } })),
  ]) expect(done('recovery', { ...ctx, initiations: [{ ...initiated, ...change }] })).toBe(false);
});

test('Recovery rejects pre-backup initiation finalized after restore without a new payment', () => {
  const outgoing: PaymentTerminalEvent = {
    runtimeId: 'runtime', height: 13, name: 'HtlcFinalized',
    data: { entityId: owner, fromEntity: owner, tokenId: 1, amount: '1000000', hashlock: `0x${'d'.repeat(64)}` },
  };
  const ctx = context({
    before: wallet({ frameHeight: 11 }), wallet: wallet({ frameHeight: 13 }),
    restored: { runtimeId: 'runtime', entityIds: [owner], height: 10 }, outgoing,
  });
  for (const height of [9, 10, 11]) {
    const initiations = [{ ...outgoing, name: 'HtlcInitiated' as const, height }];
    expect(done('recovery', { ...ctx, initiations })).toBe(false);
  }
  expect(done('recovery', ctx)).toBe(false);
  const initiations = [{ ...outgoing, name: 'HtlcInitiated' as const, height: 12 }];
  expect(done('recovery', { ...ctx, initiations })).toBe(true);
  expect(done('recovery', { ...ctx, restored: { ...ctx.restored!, height: 12 }, initiations })).toBe(false);
});

test('first share release folds nonce 1 and survives the wallet projection before completing Shares', () => {
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
  const released = {
    ...after.frame!.activeEntity!.core,
    timestamp: 0,
    nonces: new Map(),
    proposals: new Map(),
    accounts: PersistentEntityAccountMap.empty(company, computeEntityAccountValueHash),
    paybook: { entries: new Map(), feesEarned: 0n },
    lastFinalizedJHeight: 0,
  } as EntityState;
  const intent: Omit<EntityProviderActionIntent, 'actionHash'> = {
    version: 1, entityId: company, entityNumber: 1n, chainId: 31337n,
    entityProviderAddress: `0x${'b'.repeat(40)}`, boardEpoch: 1n,
    actionNonce: 1n, generation: 1, createdAt: 0,
    payload: { kind: 'releaseControlShares', release: {
      recipientAddress: `0x${'e'.repeat(40)}`, controlAmount: 10n, dividendAmount: 10n, purpose: 'Tutorial',
    } },
  };
  const pending = { ...intent, actionHash: recomputeEntityProviderActionHash(intent) };
  released.entityProviderActionState = { version: 1, confirmedNonce: 0n, generation: 1, pending };
  after.frame!.activeEntity!.core = compactEntityCoreForRemote(projectEntityCoreDoc(released));
  expect(done('shares', ctx)).toBe(false);
  applyEntityProviderActionExecuted(
    released,
    {
      entityId: company,
      actionNonce: '1', // Normalized RPC event; Solidity emits stored nonce + 1.
      actionKind: 1,
      actionHash: pending.actionHash,
    },
    1,
  );
  expect(released.entityProviderActionState).toEqual({ version: 1, confirmedNonce: 1n, generation: 1 });
  after.frame!.activeEntity!.core = compactEntityCoreForRemote(projectEntityCoreDoc(released));
  expect(after.frame!.activeEntity!.core.entityProviderActionState).toEqual(released.entityProviderActionState);
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
    data: { ...incoming.data, fromEntity: owner, amount: '1000000', hashlock: `0x${'d'.repeat(64)}` },
  };
  const initiated = { ...outgoing, name: 'HtlcInitiated' as const };
  observeTourPayment({ ...initiated, height: 10 });
  expect(done('recovery', context({ ...useTourObservations.getState(), outgoing }))).toBe(false);
  observeTourPayment(initiated);
  observeTourPayment({ ...initiated, data: { ...initiated.data, hashlock: `0x${'e'.repeat(64)}` } });
  observeTourPayment(outgoing);
  observeTourPayment({ ...outgoing, name: 'HtlcFailed' });
  expect(useTourObservations.getState().outgoing).toBe(outgoing);
  expect(done('recovery', context(useTourObservations.getState()))).toBe(true);
});
