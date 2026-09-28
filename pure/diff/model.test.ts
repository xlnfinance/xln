import { describe, expect, test } from "bun:test";
// Model-based runtime-loop differential. Every Entity tx kind the rewrite knows has one row in MOVES:
//   drawn   - the walk can author it: `enabled` reads og's committed state (the lane keeps both sides' roots equal, so
//             it holds for the rewrite too) and `draw` builds a valid input from it;
//   arises  - only og's own machinery emits it (routing, the J watcher, hooks); the walk reaches it through others;
//   pending - not drawn yet, with what drawing it needs.
// The table is typed by the rewrite's EntityTx union, so a new kind without a row is a tsc error.
// Each frame the walk picks an enabled move, favouring the kinds it has committed least, and the lane compares og's
// processRuntime with the rewrite's commitRuntimeFrame after it. The run draws until every drawn kind has been an
// input of a committed frame (seed.ts untilCovered), so the floor is the model, not a count tuned to a seed.
//
// Guards come from og's handlers (ast-grep `if ($C) throw $E` over core/entity/tx/handlers): a plain Error there
// halts og's Runtime, so a draw only offers inputs whose guards hold, and refusal branches are drawn on purpose.
import { isBatchEmpty } from "../../core/jurisdiction/machine/batch/index.ts";
import { untilCovered } from "./seed.ts";
import { tracing } from "./scenario-trace.ts";
import { SIGNERS, type Coverage, type User } from "./lane.ts";
import { HUB, openWorld, SPOKES, TOKEN, type World } from "./world.ts";
import { stableJson, type EntityTx, type RuntimeTx, type SettlementOp } from "../xln.ts";

type Kind = EntityTx["type"];
type Step = { readonly runtimeTxs: readonly RuntimeTx[]; readonly users: readonly User[] };
type Move =
  | {
      readonly _tag: "drawn";
      readonly enabled: (w: World) => boolean;
      readonly draw: (w: World) => Step;
    }
  | { readonly _tag: "arises"; readonly via: string }
  | { readonly _tag: "pending"; readonly needs: string };

const DEFAULT_SEED = 0x30de1;
const SEED = Number(process.env["SEEDX"] ?? DEFAULT_SEED);
const SEEDS = [SEED, SEED + 1, SEED + 2];
/** Committed Runtime frames per run before the walk draws only for coverage. */
const FRAMES = 30;

// ---- the world as moves see it ----

const PARTIES = [0, 1, 2, 3] as const;
const pairs = (w: World): readonly (readonly [number, number])[] =>
  PARTIES.flatMap((x) => PARTIES.filter((y) => y !== x && w.hasAccount(x, y)).map((y) => [x, y] as const));
/** An Account both sides still trade on: not frozen by a dispute. */
const active = (w: World, x: number, y: number): boolean =>
  w.hasAccount(x, y) && (w.ogAccount(x, y)?.status ?? "active") === "active";
const activePairs = (w: World) => pairs(w).filter(([x, y]) => active(w, x, y) && active(w, y, x));
const pick = <T>(w: World, xs: readonly T[]): T => xs[w.ri(xs.length)]!;
const amount = (w: World, max: number): bigint => BigInt(1 + w.ri(max));
const one = (w: World, entity: number, txs: readonly EntityTx[]): Step => ({ runtimeTxs: [], users: [w.user(entity, txs)] });
const tx = (type: string, data: unknown): EntityTx => ({ type, data }) as unknown as EntityTx;
/** og isLeftEntity: the lexicographically smaller Entity id is left. */
const isLeft = (w: World, x: number, y: number): boolean => w.ids[x]! < w.ids[y]!;
const sealed = (w: World, x: number): boolean => w.batchOf(x)?.sentBatch !== undefined;
const queued = (w: World, x: number): boolean => {
  const batch = w.batchOf(x)?.batch;
  return batch !== undefined && !isBatchEmpty(batch as never);
};

// ---- settlement workspace (og entity/tx/handlers/payments/settle.ts) ----

type OgWorkspace = {
  workspaceHash: string;
  status: string;
  lastModifiedByLeft: boolean;
  executorIsLeft: boolean;
  postSettlementDisputeProof?: { leftHanko?: string; rightHanko?: string };
};
type OgAccountReplica = {
  mempool?: { type: string }[];
  pendingFrame?: { accountTxs: { type: string }[] };
  state?: { settlementWorkspace?: OgWorkspace & { leftHanko?: string; rightHanko?: string; settlementHash?: string } };
};
const replica = (w: World, x: number, y: number): OgAccountReplica | undefined => w.ogAccount(x, y) as never;
const workspace = (w: World, x: number, y: number) => replica(w, x, y)?.state?.settlementWorkspace;
/**
 * Neither side has Account work in flight: a draw reads committed state, and a frame applies routed Account inputs
 * before user txs, so an in-flight frame could sign or replace the workspace under the tx (og then throws, a halt).
 */
const quiet = (w: World, x: number, y: number): boolean =>
  [replica(w, x, y), replica(w, y, x)].every((r) => r?.pendingFrame == null && (r?.mempool ?? []).length === 0);
const unsigned = (w: World, x: number, y: number): boolean => {
  const ws = workspace(w, x, y);
  return ws !== undefined && ws.leftHanko === undefined && ws.rightHanko === undefined && ws.settlementHash === undefined;
};
/** The Account's token-1 collateral as og holds it. */
const collateral = (w: World, x: number, y: number): bigint =>
  (w.ogAccount(x, y) as { state?: { deltas?: Map<number, { collateral: bigint }> } } | undefined)
    ?.state?.deltas?.get(1)?.collateral ?? 0n;
/**
 * Ops og's compileOps accepts: an r2c within the proposer's reserve, a c2r within the collateral (beyond it the
 * receiver throws SETTLEMENT_PROJECTED_COLLATERAL_RANGE, a halt), a forgive.
 */
const settleOps = (w: World, x: number, y: number): readonly SettlementOp[] => {
  const reserve = w.reserveOf(x);
  const held = collateral(w, x, y);
  const r2c: readonly SettlementOp[] = reserve > 0n ? [{ type: "r2c", tokenId: 1, amount: 1n + (reserve * BigInt(w.ri(50))) / 100n }] : [];
  const c2r: readonly SettlementOp[] = held > 0n ? [{ type: "c2r", tokenId: 1, amount: 1n + (held * BigInt(w.ri(90))) / 100n }] : [];
  const choices: readonly (readonly SettlementOp[])[] = [
    r2c,
    c2r,
    [{ type: "forgive", tokenId: 1 }],
    [...r2c, { type: "forgive", tokenId: 1 }],
  ];
  const drawn = pick(w, choices);
  return drawn.length > 0 ? drawn : [{ type: "forgive", tokenId: 1 }];
};
const withWorkspace = (w: World, pred: (x: number, y: number, ws: OgWorkspace) => boolean) =>
  activePairs(w).filter(([x, y]) => {
    const ws = workspace(w, x, y);
    return ws !== undefined && quiet(w, x, y) && pred(x, y, ws);
  });

/**
 * og buildSettlementHankoDraft: the side that did not last modify an unsubmitted workspace signs it, once (a second
 * approval throws SETTLEMENT_SIDE_HANKO_ALREADY_ATTACHED, a halt).
 */
const approvable = (w: World) => (x: number, y: number, ws: OgWorkspace): boolean => {
  const own = isLeft(w, x, y) ? ws.postSettlementDisputeProof?.leftHanko : ws.postSettlementDisputeProof?.rightHanko;
  return ws.status !== "submitted" && ws.lastModifiedByLeft !== isLeft(w, x, y) && own === undefined;
};

// ---- the model ----

const drawn = (enabled: (w: World) => boolean, draw: (w: World) => Step): Move => ({ _tag: "drawn", enabled, draw });
const arises = (via: string): Move => ({ _tag: "arises", via });
const pending = (needs: string): Move => ({ _tag: "pending", needs });

export const MOVES: { readonly [K in Kind]: Move } = {
  openAccount: drawn(
    (w) => SPOKES.some((s) => SPOKES.some((t) => s !== t && !w.hasAccount(s, t))),
    (w) => {
      const [s, t] = pick(w, SPOKES.flatMap((s) => SPOKES.filter((t) => s !== t && !w.hasAccount(s, t)).map((t) => [s, t] as const)));
      return one(w, s, [w.open(s, t, amount(w, 5_000))]);
    },
  ),
  extendCredit: drawn(
    (w) => activePairs(w).length > 0,
    (w) => {
      const [x, y] = pick(w, activePairs(w));
      return one(w, x, [w.extend(x, y, amount(w, 20_000))]);
    },
  ),
  directPayment: drawn(
    (w) => activePairs(w).length > 0,
    (w) => {
      const [x, y] = pick(w, activePairs(w));
      return one(w, x, [w.direct(x, y, amount(w, 600))]);
    },
  ),
  htlcPayment: drawn(
    (w) => SPOKES.some((s) => SPOKES.some((t) => s !== t && w.routable(s, t))),
    (w) => {
      const [s, t] = pick(w, SPOKES.flatMap((s) => SPOKES.filter((t) => s !== t && w.routable(s, t)).map((t) => [s, t] as const)));
      return one(w, s, [w.htlc(s, t, amount(w, 300))]);
    },
  ),
  r2c: drawn(
    (w) => activePairs(w).some(([x]) => w.reserveOf(x) > 0n && !sealed(w, x)),
    (w) => {
      const [x, y] = pick(w, activePairs(w).filter(([x]) => w.reserveOf(x) > 0n && !sealed(w, x)));
      return one(w, x, [tx("r2c", { counterpartyId: w.ids[y], tokenId: 1, amount: 1n + (w.reserveOf(x) * BigInt(w.ri(30))) / 100n })]);
    },
  ),
  r2r: drawn(
    (w) => PARTIES.some((x) => w.reserveOf(x) > 0n && !sealed(w, x)),
    (w) => {
      const x = pick(w, PARTIES.filter((x) => w.reserveOf(x) > 0n && !sealed(w, x)));
      const y = pick(w, PARTIES.filter((y) => y !== x));
      return one(w, x, [tx("r2r", { toEntityId: w.ids[y], tokenId: 1, amount: 1n + (w.reserveOf(x) * BigInt(w.ri(20))) / 100n })]);
    },
  ),
  j_broadcast: drawn(
    (w) => PARTIES.some((x) => queued(w, x) && !sealed(w, x)),
    (w) => one(w, pick(w, PARTIES.filter((x) => queued(w, x) && !sealed(w, x))), [tx("j_broadcast", {})]),
  ),
  settle_propose: drawn(
    (w) => activePairs(w).some(([x, y]) => workspace(w, x, y) === undefined && quiet(w, x, y)),
    (w) => {
      const [x, y] = pick(w, activePairs(w).filter(([x, y]) => workspace(w, x, y) === undefined && quiet(w, x, y)));
      return one(w, x, [tx("settle_propose", { counterpartyEntityId: w.ids[y], ops: settleOps(w, x, y), memo: `m${w.ri(100)}` })]);
    },
  ),
  settle_update: drawn(
    (w) => withWorkspace(w, (x, y) => unsigned(w, x, y)).length > 0,
    (w) => {
      const [x, y] = pick(w, withWorkspace(w, (x, y) => unsigned(w, x, y)));
      return one(w, x, [tx("settle_update", { counterpartyEntityId: w.ids[y], ops: settleOps(w, x, y) })]);
    },
  ),
  settle_approve: drawn(
    (w) => withWorkspace(w, approvable(w)).length > 0,
    (w) => {
      const [x, y] = pick(w, withWorkspace(w, approvable(w)));
      return one(w, x, [tx("settle_approve", { counterpartyEntityId: w.ids[y], workspaceHash: workspace(w, x, y)!.workspaceHash })]);
    },
  ),
  settle_execute: drawn(
    (w) => withWorkspace(w, (x, y, ws) => ws.status === "ready_to_submit" && ws.executorIsLeft === isLeft(w, x, y)
      && !sealed(w, x)).length > 0,
    (w) => {
      const [x, y] = pick(w, withWorkspace(w, (x, y, ws) => ws.status === "ready_to_submit"
        && ws.executorIsLeft === isLeft(w, x, y) && !sealed(w, x)));
      return one(w, x, [tx("settle_execute", { counterpartyEntityId: w.ids[y] })]);
    },
  ),
  settle_reject: drawn(
    (w) => withWorkspace(w, (x, y) => unsigned(w, x, y)).length > 0,
    (w) => {
      const [x, y] = pick(w, withWorkspace(w, (x, y) => unsigned(w, x, y)));
      return one(w, x, [tx("settle_reject", { counterpartyEntityId: w.ids[y], reason: "walk" })]);
    },
  ),
  chat: drawn(
    () => true,
    (w) => {
      const x = pick(w, PARTIES);
      return one(w, x, [tx("chat", { from: SIGNERS[x]!.toLowerCase(), message: `hi ${w.ri(1000)}` })]);
    },
  ),
  chatMessage: drawn(
    () => true,
    (w) => one(w, pick(w, PARTIES), [tx("chatMessage", { message: `note ${w.ri(1000)}`, timestamp: Number(w.lane.runtime().timestamp) })]),
  ),
  "profile-update": drawn(
    () => true,
    (w) => {
      const x = pick(w, PARTIES);
      return one(w, x, [tx("profile-update", { profile: { entityId: w.ids[x], name: `E${w.ri(100)}`, bio: "walk" } })]);
    },
  ),
  setHubConfig: drawn(
    () => true,
    (w) => one(w, HUB, [tx("setHubConfig", { matchingStrategy: "amount", policyVersion: 1, routingFeePPM: w.ri(100), baseFee: 0n })]),
  ),
  setRebalancePolicy: drawn(
    (w) => activePairs(w).length > 0,
    (w) => {
      const [x, y] = pick(w, activePairs(w));
      const soft = amount(w, 10_000);
      return one(w, x, [tx("setRebalancePolicy", {
        counterpartyEntityId: w.ids[y], tokenId: TOKEN, r2cRequestSoftLimit: soft, hardLimit: soft * 2n, maxAcceptableFee: amount(w, 100),
      })]);
    },
  ),
  prepareDispute: pending("a dispute freezes its Account for the rest of the run; scenario.test.ts drives the lifecycle"),
  disputeStart: pending("follows prepareDispute (og auto-drafts it)"),
  disputeFinalize: arises("the dispute deadline hook"),
  requestCollateral: pending("the hub's rebalance fee policy and a quote"),
  accountInput: arises("bilateral Account consensus between Entities"),
  entityCommand: arises("admission of locally authored txs"),
  propose: pending("a multi-signer board"),
  vote: pending("a multi-signer board"),
  boardHandover: arises("an on-chain BoardActivated in a j_event"),
  j_event: arises("og's J watcher and the Entity's J-prefix round"),
  j_rebroadcast: pending("a sealed batch the chain has not confirmed"),
  j_abort_sent_batch: pending("a sealed batch the chain has not confirmed"),
  j_clear_batch: pending("an unsealed batch the Entity abandons"),
  r2e: pending("an Entity-provider receiver"),
  e2r: pending("an external ERC token contract"),
  mintReserves: pending("og's admin mint authority"),
  runtimeOutput: arises("cross-j Runtime outputs (scenario-cross-j.test.ts)"),
  scheduledWake: arises("the Runtime's scheduled wakes"),
  proposeAccountsNow: arises("the Account proposal hook"),
  processHtlcTimeouts: arises("the HTLC timeout hook"),
  resolveHtlcLock: arises("an HTLC secret reveal"),
  initOrderbookExt: pending("a second token on the hub Accounts (same-j swaps)"),
  placeSwapOffer: pending("a hub order book over two tokens"),
  proposeCancelSwap: pending("a resting swap offer"),
  lendingOffer: pending("a hub lending book"),
  lendingBorrow: pending("a lending offer"),
  lendingRepay: pending("an active loan"),
  lendingClosePosition: pending("an idle lending position"),
  entityProviderTransfer: pending("an Entity provider board"),
  entityProviderProposeControlBoard: pending("an Entity provider board"),
  entityProviderActivateBoard: pending("a proposed control board"),
  entityProviderCancelAction: pending("a queued provider action"),
  entityProviderReleaseControlShares: pending("provider control shares"),
  prepareCrossJurisdictionSwap: arises("scenario-cross-j.test.ts (two Runtimes)"),
  requestCrossJurisdictionClear: arises("scenario-cross-j.test.ts (two Runtimes)"),
  registerCrossJurisdictionSwap: arises("cross-j swap routing"),
  materializeCrossJurisdictionSwap: arises("cross-j swap routing"),
  materializeCrossJurisdictionClear: arises("cross-j clear routing"),
  admitCrossJurisdictionBookOrder: arises("cross-j book routing"),
  removeCrossJurisdictionBookOrder: arises("cross-j book routing"),
  crossJurisdictionBookOrderRemoved: arises("cross-j book routing"),
  crossJurisdictionFillNotice: arises("cross-j fills"),
  crossJurisdictionForceSiblingDispute: arises("cross-j dispute salvage"),
  crossJurisdictionSalvage: arises("cross-j dispute salvage"),
  crossPullClose: arises("cross-j pull settlement"),
  orderbookSweepCrossJurisdiction: arises("the hub's cross-j book sweep"),
};

const DRAWN = (Object.entries(MOVES) as [Kind, Move][]).flatMap(([k, m]) => (m._tag === "drawn" ? [[k, m] as const] : []));

// ---- the walk ----

/** Chain-side moves that are not Entity txs: new reserves the watcher reports. */
const fund = async (w: World): Promise<Step> => {
  await w.chain.debugFundReserves(w.ids[w.ri(4)]!, 1, BigInt(1 + w.ri(1_000_000)));
  return { runtimeTxs: [], users: [] };
};

const walk = async (seed: number): Promise<Coverage> => {
  const w = await openWorld(seed, "model");
  const { lane, coverage } = w;
  const expectClean = (diffs: string[]): void => expect(diffs).toEqual([]);
  const tried = new Map<string, number>();
  try {
    const [imports, opens] = w.importAll();
    expectClean(await lane.tick(imports, []));
    expectClean(await lane.tick([], opens));
    await w.chain.debugFundReservesBatch(w.ids.map((entityId) => ({ entityId, tokenId: 1, amount: 10n ** 9n })));
    expectClean(await lane.tick([], []));
    const covered = () => DRAWN.every(([k]) => coverage.entityTxs.has(k));
    const more = untilCovered(FRAMES, covered, FRAMES * 6);
    // a halted og Runtime refuses every later frame, so a halt both sides agree on ends the run
    const loop = async (i: number): Promise<void> => {
      if (!more(i) || coverage.halts > 0) return;
      const enabled = DRAWN.filter(([, m]) => m._tag === "drawn" && m.enabled(w));
      // favour the kinds committed least: weight 1 / (1 + times tried)
      const weights = enabled.map(([k]) => 1 / (1 + (tried.get(k) ?? 0)));
      const total = weights.reduce((a, b) => a + b, 0);
      const r = w.rand() * (total + 0.5);
      const at = weights.findIndex((_, j) => weights.slice(0, j + 1).reduce((a, b) => a + b, 0) > r);
      const chosen = at < 0 ? undefined : enabled[at];
      const step = chosen === undefined ? (w.rand() < 0.5 ? await fund(w) : { runtimeTxs: [], users: [] }) : chosen[1]._tag === "drawn" ? chosen[1].draw(w) : undefined;
      const name = chosen?.[0] ?? "world";
      tried.set(name, (tried.get(name) ?? 0) + 1);
      coverage.actions[name] = (coverage.actions[name] ?? 0) + 1;
      if (tracing()) console.log(`frame ${lane.frames() + 1} ${name}`);
      expectClean(await lane.tick(step?.runtimeTxs ?? [], step?.users ?? []));
      return loop(i + 1);
    };
    await loop(0);
    return coverage;
  } finally {
    await w.close();
  }
};

describe("model: every drawn Entity tx kind, og processRuntime vs the rewrite, frame by frame", () => {
  const seen = new Set<string>();
  SEEDS.forEach((seed) => {
    test(`MATCH: model walk, seed 0x${seed.toString(16)}`, async () => {
      const c = await walk(seed);
      c.entityTxs.forEach((k) => seen.add(k));
      console.log(`seed 0x${seed.toString(16)}: ${c.frames} Runtime frames, halts ${stableJson(c.haltTexts)}, moves ${stableJson(c.actions)}`);
      console.log(`  committed kinds ${[...c.entityTxs].sort().join(",")}; Account txs ${[...c.accountTxs].sort().join(",")}`);
    }, 900_000);
  });
  test("the walks commit every drawn kind", () => {
    expect(DRAWN.map(([k]) => k).filter((k) => !seen.has(k))).toEqual([]);
  });
});
