/**
 * What a presentation states about the step on screen, derived from its graph frames:
 * the Depository ledger (reserves and account collateral, with the change since the R-frame
 * before), which bar legend entries are actually visible, and amounts formatted for a
 * projector. Pure, so the card, the ledger and the stage can never disagree.
 */

import type { Delta, RuntimeAdapterGraphFrame } from '@xln/core/api/public/runtime-module';
import type { TrailGraphDebt } from '../../../../../core/scenarios/network-trail';

export type PresentationToken = { symbol: string; decimals: number };
export type TokenLookup = (tokenId: number) => PresentationToken;

export type LedgerRow = {
  key: string;
  label: string;
  tokenId: number;
  amount: bigint;
  /** Amount minus the same row one R-frame earlier (a new row counts from zero). */
  change: bigint;
};

export type DepositoryLedger = { reserves: LedgerRow[]; collateral: LedgerRow[]; debts: LedgerRow[] };

type GraphEntity = RuntimeAdapterGraphFrame['entities'][number];
type GraphAccount = GraphEntity['accounts']['items'][number];

const entitiesOf = (frames: ReadonlyMap<string, RuntimeAdapterGraphFrame>): GraphEntity[] =>
  Array.from(frames.values()).flatMap((frame) => frame.entities);

const stageX = (entity: GraphEntity): number => {
  const position = (entity.summary as { position?: { x?: unknown } }).position;
  return Number.isFinite(Number(position?.x)) ? Number(position?.x) : 0;
};

/** Banks in the order the stage shows them, left to right. */
const orderedEntities = (frames: ReadonlyMap<string, RuntimeAdapterGraphFrame>): GraphEntity[] =>
  entitiesOf(frames).sort((left, right) => stageX(left) - stageX(right) || left.summary.label.localeCompare(right.summary.label));

const reserveEntries = (entity: GraphEntity): Array<[number, bigint]> =>
  Array.from((entity.core?.reserves ?? new Map()) as Map<number | string, bigint>, ([tokenId, amount]) => [Number(tokenId), BigInt(amount)]);

/** Each bilateral account once, seen from its left entity when that copy exists. */
const accountsOf = (frames: ReadonlyMap<string, RuntimeAdapterGraphFrame>): Map<string, GraphAccount> => {
  const accounts = new Map<string, GraphAccount>();
  for (const entity of entitiesOf(frames)) {
    for (const account of entity.accounts.items) {
      const key = `${account.leftEntity}:${account.rightEntity}`;
      if (!accounts.has(key) || entity.summary.entityId === account.leftEntity) accounts.set(key, account);
    }
  }
  return accounts;
};

const collateralEntries = (account: GraphAccount): Array<[number, bigint]> =>
  Array.from(account.deltas as Map<number, Delta>, ([tokenId, delta]) => [Number(tokenId), BigInt(delta.collateral)]);

const keyedAmounts = (rows: Array<{ key: string; amount: bigint }>): Map<string, bigint> =>
  new Map(rows.map((row) => [row.key, row.amount]));

const reserveRows = (frames: ReadonlyMap<string, RuntimeAdapterGraphFrame>): Array<Omit<LedgerRow, 'change'>> =>
  orderedEntities(frames).flatMap((entity) => reserveEntries(entity).map(([tokenId, amount]) => ({
    key: `reserve:${entity.summary.entityId}:${tokenId}`,
    label: entity.summary.label,
    tokenId,
    amount,
  })));

const collateralRows = (frames: ReadonlyMap<string, RuntimeAdapterGraphFrame>): Array<Omit<LedgerRow, 'change'>> => {
  const order = new Map(orderedEntities(frames).map((entity, index) => [entity.summary.entityId, index]));
  const labels = new Map(entitiesOf(frames).map((entity) => [entity.summary.entityId, entity.summary.label]));
  const rows: Array<Omit<LedgerRow, 'change'> & { rank: number }> = [];
  for (const [key, account] of accountsOf(frames)) {
    const pair = [account.leftEntity, account.rightEntity].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    const label = pair.map((entityId) => labels.get(entityId) ?? entityId.slice(0, 8)).join('–');
    const rank = Math.min(...pair.map((entityId) => order.get(entityId) ?? 0));
    for (const [tokenId, amount] of collateralEntries(account)) rows.push({ key: `collateral:${key}:${tokenId}`, label, tokenId, amount, rank });
  }
  return rows.sort((left, right) => left.rank - right.rank || left.label.localeCompare(right.label)).map(({ rank: _rank, ...row }) => row);
};

/** On-chain debts, debtor by debtor in stage order, each debtor's queue first-come. */
const debtRows = (frames: ReadonlyMap<string, RuntimeAdapterGraphFrame>): Array<Omit<LedgerRow, 'change'>> => {
  const labels = new Map(entitiesOf(frames).map((entity) => [entity.summary.entityId, entity.summary.label]));
  return orderedEntities(frames).flatMap((entity) => ((entity.core as { debts?: TrailGraphDebt[] } | null)?.debts ?? []).map((debt) => ({
    key: `debt:${entity.summary.entityId}:${debt.creditor}:${debt.tokenId}:${debt.queueIndex}`,
    label: `${entity.summary.label} owes ${labels.get(debt.creditor) ?? debt.creditor.slice(0, 8)}`,
    tokenId: debt.tokenId,
    amount: debt.remaining,
  })));
};

const changeFrom = (current: Array<Omit<LedgerRow, 'change'>>, previous: Map<string, bigint>, baseline: boolean): LedgerRow[] =>
  current.map((row) => ({ ...row, change: baseline ? row.amount - (previous.get(row.key) ?? 0n) : 0n }));

/** A position row is shown while it holds money or has just changed. */
const withChange = (current: Array<Omit<LedgerRow, 'change'>>, previous: Map<string, bigint>, baseline: boolean): LedgerRow[] =>
  changeFrom(current, previous, baseline).filter((row) => row.amount !== 0n || row.change !== 0n);

export const depositoryLedger = (
  frames: ReadonlyMap<string, RuntimeAdapterGraphFrame>,
  previousFrames: ReadonlyMap<string, RuntimeAdapterGraphFrame>,
): DepositoryLedger => {
  const baseline = previousFrames.size > 0;
  return {
    // A bank's reserve stays listed at zero: an empty reserve is itself the news.
    reserves: changeFrom(reserveRows(frames), keyedAmounts(reserveRows(previousFrames)), baseline),
    collateral: withChange(collateralRows(frames), keyedAmounts(collateralRows(previousFrames)), baseline),
    debts: withChange(debtRows(frames), keyedAmounts(debtRows(previousFrames)), baseline),
  };
};

/** One entity's reserve of one token, by entity id. */
export const reservesByEntity = (frames: ReadonlyMap<string, RuntimeAdapterGraphFrame>, tokenId: number): Map<string, bigint> =>
  new Map(entitiesOf(frames).map((entity) => [
    entity.summary.entityId,
    reserveEntries(entity).find(([candidate]) => candidate === tokenId)?.[1] ?? 0n,
  ]));

export type LegendKey = 'collateral' | 'creditInUse' | 'creditRoom' | 'netPosition' | 'dispute';

type DeltaView = { collateral: bigint; inOwnCredit: bigint; outPeerCredit: bigint; ownCreditLimit: bigint; peerCreditLimit: bigint; totalCapacity: bigint };

/** The legend entries the stage is drawing right now; an absent element has no key. */
export const presentationLegendKeys = (
  frames: ReadonlyMap<string, RuntimeAdapterGraphFrame>,
  derive: (delta: Delta, isLeft: boolean) => DeltaView,
): Set<LegendKey> => {
  const keys = new Set<LegendKey>();
  for (const account of accountsOf(frames).values()) {
    if (account.activeDispute) keys.add('dispute');
    for (const delta of (account.deltas as Map<number, Delta>).values()) {
      const view = derive(delta, true);
      if (view.collateral > 0n) keys.add('collateral');
      if (view.inOwnCredit > 0n || view.outPeerCredit > 0n) keys.add('creditInUse');
      if (view.ownCreditLimit + view.peerCreditLimit > view.inOwnCredit + view.outPeerCredit) keys.add('creditRoom');
      if (view.totalCapacity > 0n) keys.add('netPosition');
    }
  }
  return keys;
};

const groupThousands = (value: bigint): string => value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Exact amount for the ledger: every digit the chain holds, decimals trimmed. */
export const formatLedgerAmount = (amount: bigint, token: PresentationToken): string => {
  const scale = 10n ** BigInt(token.decimals);
  const absolute = amount < 0n ? -amount : amount;
  const fraction = (absolute % scale).toString().padStart(token.decimals, '0').replace(/0+$/, '');
  return `${amount < 0n ? '−' : ''}${groupThousands(absolute / scale)}${fraction ? `.${fraction}` : ''}`;
};

const trimDecimals = (text: string): string => (text.includes('.') ? text.replace(/\.?0+$/, '') : text);

/**
 * Stage amount: short enough for a label, never hiding a change a viewer must see. Below
 * 10,000 every unit shows (950 stays 950, 1,000 stays 1,000); thousands round to 0.1K
 * (12.5K) and millions to thousands (4.96M, 2.0M). The ledger shows every digit.
 */
export const formatStageAmount = (amount: bigint, decimals: number): string => {
  const sign = amount < 0n ? '−' : '';
  const value = Math.abs(Number(amount)) / 10 ** decimals;
  if (value >= 999_950) {
    const text = trimDecimals((value / 1_000_000).toFixed(3));
    return `${sign}${text.includes('.') ? text : `${text}.0`}M`;
  }
  if (value >= 9_999.5) return `${sign}${trimDecimals((value / 1_000).toFixed(1))}K`;
  const rounded = trimDecimals(value.toFixed(2));
  const [whole, fraction] = rounded.split('.');
  return `${sign}${groupThousands(BigInt(whole!))}${fraction ? `.${fraction}` : ''}`;
};

/** A signed change for a flash chip: "+200K", "−50". */
export const formatStageChange = (change: bigint, decimals: number): string =>
  `${change > 0n ? '+' : ''}${formatStageAmount(change, decimals)}`;
