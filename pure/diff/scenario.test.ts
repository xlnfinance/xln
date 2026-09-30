import { describe, expect, test } from "bun:test";
// Scenario-level differential: one multi-entity world (three spokes around a hub) driven frame by frame through og's
// real Runtime processor (processRuntime = createRuntimeProcessor, core/runtime/composition.ts) and through the
// rewrite's Runtime entry (runtimeWake + commitRuntimeFrame), with identical inputs and timestamps. After every frame
// the state roots, the replica meta rows, the certified Entity heads, the Runtime component digests, the WAL
// postStateHash and the routed local outputs must agree.
//
// Seeds: a fixed default, overridden by SEEDX (decimal or 0x-hex); every failure names the seed and the frame.
//
// Not compared, by design:
// - the WAL row's own frameHash: og's row carries entityContextRefs (its replay-context index), which the rewrite's
//   StorageFrame does not model, so the two row hashes differ by construction;
// - postStateHash on a frame og materializes (a storage checkpoint: og's first frame), where og hashes the
//   materialized snapshot instead.
// Scheduling kept outside the frame function: og's host loop (prioritizeJEventFrame) runs a frame's j_event inputs
// alone and defers every other input; the scenario delivers a J range only on a quiescent frame, where that split
// is a no-op. An HTLC is only sent over lanes the gossip profiles advertise: og's quote throws (a Runtime halt, not a
// refusal) on an unadvertised lane.
// Admission signs local txs into Entity commands (og prepareLocallyAuthoredEntityTxs), so the harness uses real keys.
import { tracing } from "./scenario-trace.ts";
import { stableJson } from "../xln.ts";
import type { EntityTx, RuntimeTx } from "../xln.ts";
import type { Coverage, User } from "./lane.ts";
import { HUB, openWorld, SPOKES } from "./world.ts";

const DEFAULT_SEED = 0x5ce7a1;
const SEED = Number(process.env["SEEDX"] ?? DEFAULT_SEED);
const SEEDS = [SEED, SEED + 1, SEED + 2];
/** Committed Runtime frames per seed (idle ticks that commit nothing do not count). */
const FRAMES = 20;
/** A scenario's steps: the script it works through in order (each step when its preconditions hold), and the mix. */
type Plan = {
  readonly name: string;
  readonly script: readonly string[];
  readonly random: readonly string[];
  readonly frames: number;
};
const HUB_PLAN: Plan = {
  name: "hub",
  script: ["fund", "r2c", "hubCredit", "hubCredit", "payToHub", "payFromHub", "htlc", "overHtlc", "jReserve",
    "spokeOpen", "twoSenders"],
  random: ["idle", "idle", "idle", "hubCredit", "spokeCredit", "payToHub", "payFromHub", "htlc", "jReserve",
    "twoSenders", "r2c"],
  frames: FRAMES,
};
/**
 * og's unilateral dispute (core/scenarios/disputes/lifecycle.ts): a spoke freezes its hub Account and broadcasts the
 * disputeStart, both sides observe DisputeStarted, the clocks jump past the challenge window, and the deadline hook
 * finalizes on chain; the frozen Account then refuses business traffic from either side.
 */
const DISPUTE_PLAN: Plan = {
  name: "dispute",
  script: ["fund", "hubCredit", "payFromHub", "payToHub", "dispute", "disputeBroadcast", "disputeTimeout",
    "payToHub", "payFromHub"],
  random: ["idle", "idle", "idle", "idle", "hubCredit", "spokeCredit", "payToHub", "payFromHub", "r2c"],
  // the challenge window, the deadline hook, the finalize batch and its J range each take frames of their own
  frames: 2 * FRAMES,
};

const runScenario = async (seed: number, plan: Plan): Promise<Coverage> => {
  const w = await openWorld(seed, plan.name);
  const { lane, chain, coverage, ids, rand, ri, user, open, extend, direct, htlc, routable, ogState, ogAccount } = w;
  const { hasAccount, reserveOf, batchOf } = w;
  const tick = lane.tick;
  const count = (kind: string): void => {
    coverage.actions[kind] = (coverage.actions[kind] ?? 0) + 1;
  };
  /** The spoke that froze its hub Account (one dispute per run). */
  let disputing: number | undefined;
  const spoke = (): number => SPOKES[ri(SPOKES.length)]!;
  const amount = (max: number): bigint => BigInt(1 + ri(max));
  /** One scripted or random step: its Runtime txs and user inputs (a J range only on a quiescent frame). */
  const step = async (kind: string): Promise<{ runtimeTxs: RuntimeTx[]; users: User[] } | undefined> => {
    const s = spoke();
    const other = SPOKES.filter((x) => x !== s)[ri(2)]!;
    switch (kind) {
      case "hubCredit":
        return { runtimeTxs: [], users: [user(HUB, [extend(HUB, s, amount(20_000))])] };
      case "spokeCredit":
        return { runtimeTxs: [], users: [user(s, [extend(s, HUB, amount(20_000))])] };
      case "payToHub":
        return { runtimeTxs: [], users: [user(s, [direct(s, HUB, amount(600))])] };
      case "payFromHub":
        return { runtimeTxs: [], users: [user(HUB, [direct(HUB, s, amount(600))])] };
      case "htlc":
        return routable(s, other) ? { runtimeTxs: [], users: [user(s, [htlc(s, other, amount(300))])] } : undefined;
      case "overHtlc":
        // beyond any capacity: og refuses the only frame tx and its deferred flush evicts it from the mempool
        return routable(s, other) ? { runtimeTxs: [], users: [user(s, [htlc(s, other, 10n ** 12n)])] } : undefined;
      case "spokeOpen":
        return { runtimeTxs: [], users: [user(0, [open(0, 2, amount(5_000))])] };
      case "twoSenders":
        return {
          runtimeTxs: [],
          users: [user(s, [direct(s, HUB, amount(200))]), user(other, [extend(other, HUB, amount(3_000))])],
        };
      case "fund": {
        // og's watcher sees the mints and queues each Entity's J range for the next frame
        await chain.debugFundReservesBatch(ids.map((entityId) => ({ entityId, tokenId: 1, amount: 10n ** 9n })));
        return { runtimeTxs: [], users: [] };
      }
      case "r2c": {
        // a party moves reserve it holds into its hub Account's collateral and seals the batch for the chain (an
        // r2c og refuses leaves no batch, and og halts on the j_broadcast: that edge has its own step)
        const from = rand() < 0.5 ? s : HUB;
        const to = from === HUB ? s : HUB;
        const moved = amount(50_000);
        // og throws (a halt) on a j_broadcast while the party's last batch is still unconfirmed
        const sealed = (ogState(from)?.jBatchState as { sentBatch?: unknown } | undefined)?.sentBatch !== undefined;
        if (!hasAccount(from, to) || reserveOf(from) < moved || sealed) return undefined;
        const r2c = { type: "r2c", data: { counterpartyId: ids[to]!, tokenId: 1, amount: moved } };
        return { runtimeTxs: [], users: [user(from, [r2c, { type: "j_broadcast", data: {} }] as EntityTx[])] };
      }
      case "haltingBroadcast": {
        // og throws a plain Error on a j_broadcast with no batch: a local bug, so both Runtimes must halt
        const idle = [...ids.keys()].find((x) => ogState(x)?.jBatchState === undefined);
        return idle === undefined
          ? undefined
          : { runtimeTxs: [], users: [user(idle, [{ type: "j_broadcast", data: {} }] as EntityTx[])] };
      }
      case "dispute": {
        // a spoke whose hub Account holds the hub's dispute-proof Hanko freezes it; og auto-drafts the disputeStart
        const ready = SPOKES.filter((x) => {
          const a = ogAccount(x, HUB);
          const free = batchOf(x)?.sentBatch === undefined;
          return a?.counterpartyDisputeProofHanko !== undefined && (a.status ?? "active") === "active" && free;
        });
        if (disputing !== undefined || ready.length === 0) return undefined;
        disputing = ready[ri(ready.length)]!;
        const prepare = { type: "prepareDispute", data: { counterpartyEntityId: ids[HUB]!, description: "scn" } };
        return { runtimeTxs: [], users: [user(disputing, [prepare] as EntityTx[])] };
      }
      case "disputeBroadcast": {
        // the drafted disputeStart goes to the chain; og's watcher then feeds DisputeStarted to both sides
        const drafted = disputing === undefined ? undefined : batchOf(disputing);
        if (drafted === undefined || drafted.sentBatch !== undefined) return undefined;
        if ((drafted.batch?.disputeStarts?.length ?? 0) === 0) return undefined;
        return { runtimeTxs: [], users: [user(disputing!, [{ type: "j_broadcast", data: {} }] as EntityTx[])] };
      }
      case "disputeTimeout": {
        // both clocks jump to the end of the challenge window (og advanceScenarioPastDisputeTimeout); og's live
        // submit stamps chain blocks with the Runtime clock, so the deadline hook's finalize lands after it
        const timeout = disputing === undefined ? undefined : ogAccount(disputing, HUB)?.activeDispute?.disputeTimeout;
        if (timeout === undefined || lane.env.state.timestamp >= Number(timeout) * 1000) return undefined;
        lane.jumpClock(Number(timeout) * 1000);
        return { runtimeTxs: [], users: [] };
      }
      case "jReserve": {
        await chain.debugFundReserves(ids[ri(4)]!, 1, BigInt(1 + ri(1_000_000)));
        return { runtimeTxs: [], users: [] };
      }
      default:
        return { runtimeTxs: [], users: [] };
    }
  };

  try {
    const expectClean = (diffs: string[]): void => expect(diffs).toEqual([]);
    expectClean([...w.evidence]);
    const [imports, opens] = w.importAll();
    expectClean(await tick(imports, []));
    expectClean(await tick([], opens));
    const { random } = plan;
    const queue = [...plan.script];
    // a halted og Runtime refuses every later frame, so a halt ends the run
    while (coverage.frames < plan.frames && lane.frames() < 3 * plan.frames && coverage.halts === 0) {
      const kind = queue.length > 0 && rand() < 0.6 ? queue[0]! : random[ri(random.length)]!;
      const planned = await step(kind);
      const chosen = planned ?? { runtimeTxs: [], users: [] };
      if (planned !== undefined && queue[0] === kind) queue.shift();
      count(planned === undefined ? "idle" : kind);
      if (tracing()) console.log(`frame ${lane.frames() + 1} ${kind}${planned === undefined ? " (skipped)" : ""}`);
      expectClean(await tick(chosen.runtimeTxs, chosen.users));
    }
    // last, the halt: og refuses the frame and stays halted, so nothing can follow it
    const halting = coverage.halts === 0 ? await step("haltingBroadcast") : undefined;
    count(halting === undefined ? "idle" : "haltingBroadcast");
    if (halting !== undefined) expectClean(await tick(halting.runtimeTxs, halting.users));
    const closed = (x: number, y: number): boolean => {
      const a = ogAccount(x, y);
      return a?.status === "disputed" && a.activeDispute === undefined;
    };
    coverage.disputesFinalized = disputing !== undefined && closed(disputing, HUB) && closed(HUB, disputing) ? 1 : 0;
    // a batch the chain refused is only a log line on og's side; the shim records it, so every run asserts none
    expect(w.refusals()).toEqual([]);
    return coverage;
  } finally {
    await w.close();
  }
};

describe("scenario: og processRuntime vs the rewrite's Runtime, frame by frame", () => {
  const totals = { frames: 0, halts: 0, accountTxs: new Set<string>() };
  SEEDS.forEach((seed) => {
    test(`MATCH: hub world, seed 0x${seed.toString(16)} (${FRAMES} frames)`, async () => {
      const c = await runScenario(seed, HUB_PLAN);
      totals.frames += c.frames;
      totals.halts += c.halts;
      c.accountTxs.forEach((t) => totals.accountTxs.add(t));
      console.log(
        `seed 0x${seed.toString(16)}: ${c.frames} Runtime frames, ${c.entityFrames} Entity frames,`,
        `actions ${stableJson(c.actions)}, Account txs ${[...c.accountTxs].sort().join(",")}`,
      );
      // a run that ends in a halt both sides agree on is complete wherever it stops
      expect(c.halts > 0 || c.frames > FRAMES / 2).toBe(true);
    }, 600_000);
  });
  test("the seeded scenarios cover 50+ committed Runtime frames, a multi-hop HTLC and a halt", () => {
    expect(totals.frames).toBeGreaterThanOrEqual(50);
    expect(totals.halts).toBeGreaterThan(0);
    expect(totals.accountTxs.has("htlc_lock")).toBe(true);
  });
});

describe("scenario: a unilateral dispute, og vs the rewrite, frame by frame", () => {
  const finalized = { count: 0 };
  SEEDS.forEach((seed) => {
    test(`MATCH: dispute lifecycle, seed 0x${seed.toString(16)}`, async () => {
      const c = await runScenario(seed, DISPUTE_PLAN);
      finalized.count += c.disputesFinalized;
      console.log(`seed 0x${seed.toString(16)}: ${c.frames} Runtime frames, finalized ${c.disputesFinalized}, actions ${stableJson(c.actions)}`);
      // a run that ends in a halt both sides agree on is complete wherever it stops
      expect(c.halts > 0 || c.frames > FRAMES / 2).toBe(true);
    }, 600_000);
  });
  test("a dispute reaches DisputeFinalized on chain", () => {
    expect(finalized.count).toBeGreaterThan(0);
  });
});
