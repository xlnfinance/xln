import type { AccountLendingCovenant } from '@xln/core/types/account';
import type { AccountView, WalletView } from '../runtime/views';
import { TOUR_STEPS, type TourContext } from './steps';
export const owner = `0x${'a'.repeat(64)}`;
export const company = `0x${'0'.repeat(63)}1`;
export const frame = (entityId = owner, reserves = new Map<number, bigint>()) =>
  ({
    activeEntity: { core: { entityId, height: 2, reserves, config: { validators: ['signer'] } } },
  }) as NonNullable<WalletView['frame']>;
export const wallet = (changes: Partial<WalletView> = {}): WalletView => ({
  frame: frame(),
  entityId: owner,
  signerId: 'signer',
  name: 'Test',
  jurisdiction: 'Testnet',
  frameHeight: 10,
  summaries: [],
  names: new Map(),
  hubs: new Set(),
  accounts: [],
  reserves: [],
  onchain: [],
  totals: [],
  usd: {
    onchain: 0,
    reserve: 0,
    pending: 0,
    receivable: 0,
    secured: 0,
    risk: 0,
    owed: 0,
    net: 0,
    sendCapacity: 0,
    receiveCapacity: 0,
    feesEarned: 0,
    mmlExposure: 0,
  },
  paybookFeesEarned: 0n,
  loading: false,
  error: null,
  refresh: () => {},
  ...changes,
});
export const account = (changes: Partial<AccountView> = {}): AccountView =>
  ({
    counterpartyId: 'hub',
    isLeft: true,
    isHub: true,
    frameHeight: 1,
    tokens: [],
    dispute: 'none',
    doc: { state: { subcontracts: new Map() } },
    ...changes,
  }) as AccountView;
export const token = (credit = 0n, coll = 0n, signed = 0n) =>
  ({
    tokenId: 1,
    derived: { peerCreditLimit: credit },
    delta: { collateral: coll },
    signed,
  }) as AccountView['tokens'][number];
export const context = (changes: Partial<TourContext> = {}): TourContext => ({
  wallet: wallet({ frameHeight: 11 }),
  before: wallet(),
  tradeFilled: false,
  runtimeId: 'runtime',
  pathname: '/',
  dom: { has: () => true, text: () => 'Submitted', value: () => '5' },
  ...changes,
});
export const step = (id: string) => {
  const found = TOUR_STEPS.find(row => row.id === id);
  if (!found) throw new Error(`Missing chapter ${id}`);
  return found;
};
export const done = (id: string, ctx: TourContext) => step(id).done?.(ctx) ?? false;
export const covenant = (kind: AccountLendingCovenant['kind'], creditorIsLeft: boolean): AccountLendingCovenant => ({
  kind,
  creditorIsLeft,
  tokenId: 1,
  principal: 5_000_000n,
  interestBps: 100,
  openedAt: 1,
  accruedAt: 1,
  accruedInterest: 0n,
  interestRemainder: 0n,
  termMs: 86_400_000,
  lateMs: 0,
});
export function withClaim(kind: AccountLendingCovenant['kind'], creditorIsLeft: boolean, height = 11) {
  const row = account();
  row.doc.state.subcontracts = new Map([['claim', covenant(kind, creditorIsLeft)]]);
  return wallet({ accounts: [row], frameHeight: height });
}
