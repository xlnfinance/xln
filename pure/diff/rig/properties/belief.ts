// P3 believed-equals-chain (design/account-model.md section 5): after each Runtime frame, the collateral and ondelta each Account holds
// for a token are what the Depository holds for that pair and token. An Account learns them from J events, so a difference is a J event
// the Account missed or applied twice, or a batch the chain ran that the Account never expected.
//
// The walk polls the chain for events before it ticks the lane (enforce.ts's `until`, the lane itself), so a frame ends with every event
// the chain had emitted applied; a batch still in flight (sent, not yet mined) has emitted nothing and moved nothing.
import { committedView } from "../../../xln.ts";
import type { AccountReplica, Runtime } from "../../../xln.ts";

/** The one chain read P3 makes: the Depository's collateral and ondelta for a pair and a token. */
export type CollateralView = {
  readonly getCollateral: (left: string, right: string, tokenId: number) => Promise<{ readonly collateral: bigint; readonly ondelta: bigint }>;
};
export type Held = { readonly collateral: bigint; readonly ondelta: bigint };

/** Where an Account's own collateral and ondelta disagree with what the chain holds, per token. */
export const beliefLines = (property: string, r: AccountReplica, chain: ReadonlyMap<number, Held>): readonly string[] => {
  const view = committedView(r.state);
  if (!view.ok) return [`${property} committed view refused`];
  return [...chain].flatMap(([tokenId, onChain]) => {
    const d = view.value.deltas.get(tokenId);
    return d !== undefined && d.collateral === onChain.collateral && d.ondelta === onChain.ondelta
      ? []
      : [`${property} token ${tokenId}: Account believes collateral ${d?.collateral} ondelta ${d?.ondelta}, chain holds ${onChain.collateral} ${onChain.ondelta}`];
  });
};

/** What the chain holds for each token an Account has a delta for. */
export const chainHolds = async (vm: CollateralView, r: AccountReplica): Promise<ReadonlyMap<number, Held>> => {
  const { left, right } = r.state.account.id;
  const rows = await Promise.all([...r.state.account.deltas.values()].map(async (d) => {
    const held = await vm.getCollateral(left, right, Number(d.tokenId));
    return [Number(d.tokenId), { collateral: held.collateral, ondelta: held.ondelta }] as const;
  }));
  return new Map(rows);
};

/**
 * What the chain has held for each Account and token since the run began, and how far the Account's belief has caught up with it. The
 * Runtime learns the chain's state from J events that arrive after the chain moved, so a belief may lag; it may not hold a value the
 * chain never held, nor go back to an older one (an event applied twice, out of order, or with the wrong number).
 */
export type Trail = ReadonlyMap<string, { readonly seen: readonly Held[]; readonly at: number }>;
export const NOTHING_SEEN: Trail = new Map();
const EMPTY: Held = { collateral: 0n, ondelta: 0n };
const same = (a: Held, b: Held): boolean => a.collateral === b.collateral && a.ondelta === b.ondelta;
const show = (h: Held): string => `${h.collateral}/${h.ondelta}`;

export type Believed = { readonly trail: Trail; readonly violations: readonly string[] };

/** P3 over a whole Runtime after one frame: every Account (one side per pair), every token. */
export const checkBelief = async (vm: CollateralView, rt: Runtime, before: Trail): Promise<Believed> => {
  const replicas = [...rt.entities.values()].flatMap((e) =>
    [...e.accountReplicas].filter(([peer]) => e.state.id < peer).map(([peer, r]) => ({ at: `${e.state.id}→${peer}`, r })));
  const rows = (await Promise.all(replicas.map(async ({ at, r }) => {
    const chain = await chainHolds(vm, r);
    const view = committedView(r.state);
    return [...chain].map(([tokenId, onChain]) => {
      const d = view.ok ? view.value.deltas.get(tokenId) : undefined;
      return { key: `${at} token ${tokenId}`, onChain, belief: d === undefined ? undefined : { collateral: d.collateral, ondelta: d.ondelta } };
    });
  }))).flat();
  return rows.reduce<Believed>((acc, { key, onChain, belief }) => {
    const had = acc.trail.get(key) ?? { seen: [EMPTY], at: 0 };
    const last = had.seen[had.seen.length - 1]!;
    const seen = same(last, onChain) ? had.seen : [...had.seen, onChain];
    const at = belief === undefined ? -1 : seen.findIndex((h, i) => i >= had.at && same(h, belief));
    const lines = belief !== undefined && at >= 0
      ? []
      : [`P3 ${key}: Account believes ${belief === undefined ? "nothing" : show(belief)}; since the Account last agreed with the chain (${show(seen[had.at]!)}) the chain held ${seen.slice(had.at).map(show).join(", ")} (collateral/ondelta)`];
    return { trail: new Map([...acc.trail, [key, { seen, at: at >= 0 ? at : had.at }]]), violations: [...acc.violations, ...lines] };
  }, { trail: before, violations: [] });
};

/**
 * Every open Account whose belief differs from the chain right now: what a run that has gone quiet must not leave behind. An Account that
 * dispute froze or finalized takes no more J events (the chain still takes deposits into its pair: R2C during a dispute, decision H4), so
 * only the dispute's payout (P1) speaks for it.
 */
export const lagging = async (vm: CollateralView, rt: Runtime): Promise<readonly string[]> => {
  const replicas = [...rt.entities.values()].flatMap((e) =>
    [...e.accountReplicas]
      .filter(([peer, r]) => e.state.id < peer && r._tag === "open")
      .map(([peer, r]) => ({ at: `${e.state.id}→${peer}`, r })));
  return (await Promise.all(replicas.map(async ({ at, r }) => beliefLines(`P3 ${at}`, r, await chainHolds(vm, r))))).flat();
};
