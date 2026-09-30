// P1 enforceable (design/account-model.md section 5), sampled: a spoke disputes its hub Account through the protocol
// (prepareDispute, the drafted disputeStart broadcast, the clocks past the challenge window, the deadline hook's
// finalize), and the real Depository's payout must be what the frozen Account said each side is owed.
//
// With Δ = ondelta + offdelta and c the collateral, finalize pays Left Δ and Right c − Δ in every case
// (Depository._applyAccountDelta: the collateral split plus the shortfall moved from the debtor's reserve, or booked
// as debt when the reserve runs short). So per token, a side's reserve change plus the debt its peer newly owes it,
// minus the debt it newly owes its peer, is Δ for Left and c − Δ for Right.
//
// Only an Account without clauses is sampled: an open HTLC, swap or pull resolves on chain by evidence the check
// would have to model too.
import type { BrowserVMProvider } from "../../../../core/jurisdiction/adapter/browservm/browservm-provider.ts";
import type { AccountReplica, EntityId, EntityTx } from "../../../xln.ts";
import { HUB, SPOKES, type World } from "../world.ts";
import { beliefLines, lagging } from "./belief.ts";

/** Ticks the lifecycle may take for each phase before the sample gives up (and says so). */
const PATIENCE = 12;

type Side = { readonly id: EntityId; readonly reserve: bigint; readonly owes: bigint };
type Before = {
  readonly tokenId: number; readonly collateral: bigint; readonly ondelta: bigint; readonly offdelta: bigint;
  readonly left: Side; readonly right: Side;
};
export type Enforced =
  | { readonly _tag: "skipped"; readonly why: string }
  | { readonly _tag: "checked"; readonly spoke: number; readonly lines: readonly string[] };

/** What the check reads from the chain: a fake of these three reads stands in for the Depository in the unit tests. */
export type ChainView = Pick<BrowserVMProvider, "getDebts" | "getReserves" | "getCollateral">;
export const vmOf = (w: World): ChainView => w.chain.getBrowserVM() as unknown as BrowserVMProvider;
const replicaOf = (w: World, x: number, y: number): AccountReplica | undefined =>
  [...w.lane.runtime().entities.values()].find((e) => e.state.id === w.ids[x])?.accountReplicas.get(w.ids[y]!);
const clauseFree = (r: AccountReplica): boolean =>
  r.state.locks.size === 0 && r.state.offers.size === 0 && (r.state.pulls?.size ?? 0) === 0
  && r.state.settlement === undefined;
/** og's batch for x holds nothing and nothing is in flight, so the disputeStart goes out alone. */
const batchIdle = (w: World, x: number): boolean => {
  const b = w.batchOf(x);
  const rows = Object.values((b?.batch ?? {}) as Record<string, unknown>).filter(Array.isArray) as unknown[][];
  return b?.sentBatch === undefined && rows.every((r) => r.length === 0);
};
const ready = (w: World, x: number): boolean => {
  const a = w.ogAccount(x, HUB);
  const r = replicaOf(w, x, HUB);
  return a?.counterpartyDisputeProofHanko !== undefined && (a.status ?? "active") === "active"
    && r !== undefined && r._tag === "open" && r.dispute.counterparty !== undefined && clauseFree(r) && batchIdle(w, x);
};

const owedTo = async (vm: ChainView, debtor: EntityId, creditor: EntityId, tokenId: number): Promise<bigint> =>
  ((await vm.getDebts(debtor, tokenId)) ?? [])
    .filter((d) => d.creditor.toLowerCase() === creditor.toLowerCase())
    .reduce((n, d) => n + d.amount, 0n);
const sideOf = async (vm: ChainView, id: EntityId, peer: EntityId, tokenId: number): Promise<Side> =>
  ({ id, reserve: await vm.getReserves(id, tokenId), owes: await owedTo(vm, id, peer, tokenId) });

/** The chain's collateral and ondelta beside the frozen Account's offdelta, and both sides' reserves and debts. */
export const before = (vm: ChainView, r: AccountReplica): Promise<readonly Before[]> => {
  const { left, right } = r.state.account.id;
  return Promise.all([...r.state.account.deltas.values()].map(async (d): Promise<Before> => {
    const tokenId = Number(d.tokenId);
    const onChain = await vm.getCollateral(left, right, tokenId);
    return {
      tokenId, collateral: onChain.collateral, ondelta: onChain.ondelta, offdelta: d.offdelta,
      left: await sideOf(vm, left, right, tokenId), right: await sideOf(vm, right, left, tokenId),
    };
  }));
};
const gained = async (vm: ChainView, s: Side, peer: Side, tokenId: number): Promise<bigint> => {
  const after = await sideOf(vm, s.id, peer.id, tokenId);
  const peerOwes = await owedTo(vm, peer.id, s.id, tokenId);
  return after.reserve - s.reserve - (after.owes - s.owes) + (peerOwes - peer.owes);
};
export const payoutLines = async (vm: ChainView, rows: readonly Before[]): Promise<readonly string[]> =>
  (await Promise.all(rows.map(async (b) => {
    const delta = b.ondelta + b.offdelta;
    const [left, right] = [await gained(vm, b.left, b.right, b.tokenId), await gained(vm, b.right, b.left, b.tokenId)];
    return left === delta && right === b.collateral - delta
      ? []
      : [`P1 token ${b.tokenId}: Δ ${delta} collateral ${b.collateral}; the chain paid Left ${left} (owed ${delta}) `
        + `and Right ${right} (owed ${b.collateral - delta})`];
  }))).flat();

/** Ticks with no input until `done` holds or patience runs out; a lane diff ends it too. */
const until = async (w: World, done: () => boolean, left = PATIENCE): Promise<readonly string[] | "done" | "stuck"> => {
  if (done()) return "done";
  if (left === 0) return "stuck";
  await w.chain.pollNow?.();
  const diffs = await w.lane.tick([], []);
  return diffs.length > 0 ? diffs : until(w, done, left - 1);
};
const say = (w: World, x: number, txs: readonly EntityTx[]) => w.lane.tick([], [w.user(x, txs)]);

/**
 * One dispute on a ready spoke's hub Account, checked against the Depository. Lane diffs along the way come back as
 * they are; a lifecycle that stalls is reported, not silently skipped.
 */
const stalled = (s: number, why: string): Enforced => ({ _tag: "checked", spoke: s, lines: [`P1 ${why}`] });
const closed = (w: World, x: number, y: number): boolean =>
  w.ogAccount(x, y)?.status === "disputed" && w.ogAccount(x, y)?.activeDispute === undefined;
const prepare = (hub: EntityId): EntityTx =>
  ({ type: "prepareDispute", data: { counterpartyEntityId: hub, description: "P1" } }) as never;
const BROADCAST = { type: "j_broadcast", data: {} } as never as EntityTx;

/**
 * One dispute on a ready spoke's hub Account, checked against the Depository. Lane diffs along the way come back as
 * they are; a lifecycle that stalls is reported, not silently skipped.
 */
export const enforceOne = async (w: World): Promise<Enforced | readonly string[]> => {
  const spokes = SPOKES.filter((x) => ready(w, x));
  if (spokes.length === 0) return { _tag: "skipped", why: "no spoke holds a clause-free hub Account with a witness" };
  const s = spokes[w.ri(spokes.length)]!;
  const prepared = await say(w, s, [prepare(w.ids[HUB]!)]);
  if (prepared.length > 0) return prepared;
  const frozen = replicaOf(w, s, HUB);
  if (frozen === undefined || frozen._tag === "open") return stalled(s, "prepareDispute did not freeze the Account");
  const rows = await before(vmOf(w), frozen);
  const drafted = await until(w, () => ((w.batchOf(s)?.batch?.disputeStarts?.length ?? 0) > 0));
  if (drafted !== "done") return drafted === "stuck" ? stalled(s, "no disputeStart drafted") : drafted;
  const sent = await say(w, s, [BROADCAST]);
  if (sent.length > 0) return sent;
  const timeoutOf = () => w.ogAccount(s, HUB)?.activeDispute?.disputeTimeout;
  // og writes the queued dispute with disputeTimeout 0; DisputeStarted from the chain sets the real one
  const started = await until(w, () => (timeoutOf() ?? 0) > 0);
  if (started !== "done") return started === "stuck" ? stalled(s, "DisputeStarted never observed") : started;
  w.lane.jumpClock(Number(timeoutOf()) * 1000);
  const finalized = await until(w, () => closed(w, s, HUB) && closed(w, HUB, s));
  if (finalized !== "done") return finalized === "stuck" ? stalled(s, "DisputeFinalized never observed") : finalized;
  const held = new Map(rows.map((b) => [b.tokenId, b] as const));
  return { _tag: "checked", spoke: s, lines: [...beliefLines("P1", frozen, held), ...(await payoutLines(vmOf(w), rows))] };
};

/**
 * P3 at rest: with no input the lane polls the chain and ticks until every Account holds what the chain holds. Lane diffs along the way come
 * back as they are; an Account still behind when patience runs out is the J event the Runtime never applied.
 */
export const settleBelief = async (w: World, left = PATIENCE): Promise<readonly string[]> => {
  const behind = await lagging(vmOf(w), w.lane.runtime());
  if (behind.length === 0 || left === 0) return behind.map((l) => `${l} (still behind after ${PATIENCE} quiet frames)`);
  await w.chain.pollNow?.();
  const diffs = await w.lane.tick([], []);
  return diffs.length > 0 ? diffs : settleBelief(w, left - 1);
};
