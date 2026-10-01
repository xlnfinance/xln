// R-FUNDED: a reserve payment is signed only if the reserve covers it, always; oldest first, skipping one that does not
// fit. An unfunded payment would soft-fail, burn its nonce and be signed again next round.
//
// "Covers" is the contract's spendable reserve: the reserve net of every outstanding debt (`WideMath.spendable`).
// A debt is paid from the reserve first (`enforceDebts` lowers both by the same amount), so what an Entity may spend
// moves only by the movements themselves, and it is judged here in the order the contract applies them. The planner
// never leans on the contract's implicit flash credit for a debt-free initiator: it signs what the reserve holds.
import type { Settlement } from "../../chain/batch/batch.ts";
import type { SettlementDiff } from "../../chain/money.ts";
import { match } from "../../kernel/core/tagged.ts";
import type { JOp, OpKind } from "../op/ops.ts";

/** What the Depository holds for one Entity and token: the reserve and every debt still outstanding against it. */
export type Holding = Readonly<{ reserve: bigint; debt: bigint }>;

/** The Entity's holdings by internal token id. A token it holds nothing of is absent. */
export type Treasury = ReadonlyMap<bigint, Holding>;

/** The reserve net of debt, which is negative while debts exceed the reserve. */
const netOf = (h: Holding | undefined): bigint => (h === undefined ? 0n : h.reserve - h.debt);

/** What the Entity may spend of a token now: its net reserve, never below zero. */
export const spendable = (t: Treasury, tokenId: bigint): bigint => {
  const net = netOf(t.get(tokenId));
  return net > 0n ? net : 0n;
};

/** One change of the Entity's own reserve: negative leaves it. */
export type Movement = Readonly<{ tokenId: bigint; delta: bigint }>;

const isLeft = (self: string, s: Settlement): boolean => s.leftEntity.toLowerCase() === self.toLowerCase();

const ownMovement = (self: string, s: Settlement, d: SettlementDiff): Movement =>
  ({ tokenId: d.tokenId, delta: isLeft(self, s) ? d.leftDiff : d.rightDiff });

/** What an op does to the Entity's own reserve. A dispute pays out by its proof, which a plan cannot count on. */
export const movementsOf = (self: string, op: JOp): readonly Movement[] => match(op, {
  deposit: ({ leg }) => [{ tokenId: leg.internalTokenId, delta: leg.amount }],
  reserve_to_reserve: ({ transfer: t }) => [{ tokenId: t.tokenId, delta: -t.amount }],
  reserve_to_external: ({ withdrawal: w }) => [{ tokenId: w.tokenId, delta: -w.amount }],
  reserve_to_collateral: ({ funding: f }) =>
    [{ tokenId: f.tokenId, delta: -f.pairs.reduce((sum, p) => sum + p.amount, 0n) }],
  collateral_to_reserve: ({ withdrawal: w }) => [{ tokenId: w.tokenId, delta: w.amount }],
  settle: ({ settlement: s }) => s.diffs.map((d) => ownMovement(self, s, d)),
  dispute_start: () => [],
  dispute_counter: () => [],
  dispute_finalize: () => [],
  reveal_secret: () => [],
});

/** The order `Depository._processBatch` applies the kinds in: what raises the reserve first, then what lowers it. */
const CONTRACT_ORDER: Readonly<Record<OpKind, number>> = {
  deposit: 0, reserve_to_reserve: 1, collateral_to_reserve: 2, settle: 3, dispute_start: 4, dispute_counter: 5,
  reveal_secret: 6, dispute_finalize: 7, reserve_to_collateral: 8, reserve_to_external: 9,
};

const inContractOrder = (ops: readonly JOp[]): readonly JOp[] =>
  ops.toSorted((a, b) => CONTRACT_ORDER[a._tag] - CONTRACT_ORDER[b._tag]);

type Nets = ReadonlyMap<bigint, bigint>;

/** The nets after one movement, or nothing when an outflow is more than the net holds. */
const afterMovement = (nets: Nets, m: Movement): Nets | undefined => {
  const net = nets.get(m.tokenId) ?? 0n;
  return m.delta < 0n && net < -m.delta ? undefined : new Map([...nets, [m.tokenId, net + m.delta]]);
};

const startingNets = (t: Treasury): Nets => new Map([...t].map(([tokenId, h]) => [tokenId, netOf(h)] as const));

/** Whether the reserve, net of debt, covers every outflow of these ops when the contract applies them in its order. */
export const covers = (self: string, treasury: Treasury, ops: readonly JOp[]): boolean => {
  const movements = inContractOrder(ops).flatMap((op) => movementsOf(self, op));
  const last = movements.reduce<Nets | undefined>(
    (nets, m) => (nets === undefined ? nets : afterMovement(nets, m)), startingNets(treasury));
  return last !== undefined;
};

export type Funding = Readonly<{ funded: readonly JOp[]; waiting: readonly JOp[] }>;

/**
 * The ops a batch may carry now and the ones that wait. Oldest first, an op joins when the reserve still covers the
 * whole set with it, and one that does not fit waits while a younger one that does fit goes.
 */
export const fundedFirst = (self: string, treasury: Treasury, ops: readonly JOp[]): Funding =>
  ops.reduce<Funding>((plan, op) => (covers(self, treasury, [...plan.funded, op])
    ? { funded: [...plan.funded, op], waiting: plan.waiting }
    : { funded: plan.funded, waiting: [...plan.waiting, op] }), { funded: [], waiting: [] });
