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
process.env["XLN_LOG_LEVEL"] = process.env["XLN_LOG_LEVEL"] ?? "error";
import { rmSync } from "fs";
import { join } from "path";
import { closeInfraDb, closeRuntimeDb, createEmptyEnv } from "../../core/runtime.ts";
import { registerSignerKey } from "../../core/account/crypto.ts";
import { dbRootPath } from "../../core/runtime/replica/platform.ts";
import { withDeterministicHtlcTestSecret } from "../../core/protocol/htlc/test-secret-capability.ts";
import { getTokenCapacity } from "../../core/pathfinding/capacity.ts";
import { attachLiveJAdapter } from "../../core/runtime/j-submit/live-jadapters.ts";
import { unwrap } from "../xln_run.ts";
import { tracing } from "./scenario-trace.ts";
import {
  bootChain,
  createLane,
  emptyCoverage,
  jurisdictionOf,
  KEYS,
  prng,
  SIGNERS,
  T0,
  treeClone,
  type Coverage,
  type User,
} from "./lane.ts";
import {
  createRuntime,
  htlcPaymentTxHash,
  lazyBoardEntityId,
  stableJson,
  tokenId,
  type EntityId,
  type EntityTx,
  type ImportConfig,
  type RuntimeTx,
} from "../xln.ts";

const DEFAULT_SEED = 0x5ce7a1;
const SEED = Number(process.env["SEEDX"] ?? DEFAULT_SEED);
const SEEDS = [SEED, SEED + 1, SEED + 2];
/** Committed Runtime frames per seed (idle ticks that commit nothing do not count). */
const FRAMES = 20;
const TOKEN = unwrap(tokenId("1"));
const HUB = 1;
const SPOKES = [0, 2, 3];
const NAMES = ["A", "H", "C", "D"];
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
  const rand = prng(seed);
  const ri = (n: number): number => Math.floor(rand() * n);
  const tag = `SEEDX=0x${seed.toString(16)}`;
  const chain = await bootChain();
  const { J, JREPLICA } = jurisdictionOf(chain);
  const ns = `scn-diff-${process.pid}-${plan.name}-${seed.toString(16)}`;
  const env = createEmptyEnv(ns);
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  env.state.timestamp = T0;
  env.runtimeConfig = { ...env.runtimeConfig, storage: { ...env.runtimeConfig?.storage, enabled: true } } as never;
  env.activeJurisdiction = J.name;
  env.state.jReplicas.set(J.name, treeClone(JREPLICA) as never);
  // og submits a sealed batch through its live adapter after the frame commits, and og's own watcher turns every
  // chain emission into its runtime mempool (observeJRange, the cursor, each validator's J-prefix attestation)
  attachLiveJAdapter(env, J.name, chain);
  chain.startWatching(env);
  KEYS.forEach((k, i) => registerSignerKey(env, SIGNERS[i]!, Buffer.from(k.slice(2), "hex")));
  const config = (s: string): ImportConfig =>
    ({ mode: "proposer-based", threshold: 1n, validators: [s], shares: { [s]: 1n }, jurisdiction: J }) as ImportConfig;
  const ids = SIGNERS.map((s) => unwrap(lazyBoardEntityId(config(s))).toLowerCase() as EntityId);
  const secrets = new Map<string, string>();
  const gossip = (env as unknown as { gossip?: { getProfile?: (id: string) => unknown } }).gossip;
  const coverage = emptyCoverage();
  const count = (kind: string): void => {
    coverage.actions[kind] = (coverage.actions[kind] ?? 0) + 1;
  };
  // og's deterministic scenario harness (scenarios/harness/helpers.ts): every simulated peer is hosted here, so an
  // Entity is online exactly when this Runtime holds a replica of it
  const online = (x: string): boolean =>
    [...env.state.eReplicas.values()].some((r) => r.entityId.toLowerCase() === x.toLowerCase());
  const lane = createLane({
    tag,
    env,
    runtime: { ...createRuntime([JREPLICA], env.runtimeId), activeJurisdiction: J.name, timestamp: BigInt(T0) },
    ids,
    names: NAMES,
    coverage,
    keyed: new Set(SIGNERS),
    secrets,
    online,
  });
  const tick = lane.tick;

  // ---- actions ----
  const user = (entity: number, txs: readonly EntityTx[]): User => ({ entity, txs });
  const open = (from: number, to: number, credit: bigint): EntityTx =>
    ({
      type: "openAccount",
      data: {
        targetEntityId: ids[to]!,
        creditAmount: credit,
        tokenId: TOKEN,
        disputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 60 },
        accountDomain: { chainId: J.chainId, depositoryAddress: J.depositoryAddress },
        watchSeed: `0x${(from * 16 + to + 1).toString(16).padStart(2, "0").repeat(32)}`,
      },
    }) as EntityTx;
  const extend = (from: number, to: number, amount: bigint): EntityTx => ({
    type: "extendCredit",
    data: { counterpartyEntityId: ids[to]!, tokenId: TOKEN, amount },
  });
  const direct = (from: number, to: number, amount: bigint): EntityTx => ({
    type: "directPayment",
    data: { targetEntityId: ids[to]!, tokenId: TOKEN, amount, route: [ids[from]!, ids[to]!], deliveryMode: "direct" },
  });
  const htlc = (from: number, to: number, amount: bigint): EntityTx => {
    const secret = `0x${Array.from({ length: 8 }, () =>
      ri(2 ** 32)
        .toString(16)
        .padStart(8, "0"),
    ).join("")}`;
    const raw = {
      type: "htlcPayment" as const,
      data: {
        targetEntityId: ids[to]!,
        tokenId: 1,
        amount,
        maxSenderDebit: amount * 2n + 10n,
        route: [ids[from]!, ids[HUB]!, ids[to]!],
        deliveryMode: "instant" as const,
      },
    };
    const tx = withDeterministicHtlcTestSecret(raw as never, secret) as unknown as Extract<
      EntityTx,
      { type: "htlcPayment" }
    >;
    secrets.set(unwrap(htlcPaymentTxHash(tx)), secret);
    return tx;
  };
  type ProfileRow = { counterpartyId: string; tokenCapacities: unknown };
  const rowsOf = (x: number): ProfileRow[] =>
    (gossip?.getProfile?.(ids[x]!) as { accounts?: ProfileRow[] } | undefined)?.accounts ?? [];
  const row = (x: number, y: number): ProfileRow | undefined =>
    rowsOf(x).find((r) => r.counterpartyId.toLowerCase() === ids[y]);
  /** og hopCapacity: the lane's own row, else its mirror, advertising the token (og throws, halting, otherwise). */
  const advertised = (x: number, y: number): boolean => {
    const lane = row(x, y) ?? row(y, x);
    return lane !== undefined && getTokenCapacity(lane.tokenCapacities as never, 1) !== null;
  };
  const routable = (from: number, to: number): boolean => advertised(from, HUB) && advertised(HUB, to);
  const ogState = (x: number): { reserves?: Map<number, bigint>; accounts?: Map<string, unknown>; jBatchState?: unknown } | undefined =>
    [...env.state.eReplicas.values()].find((r) => r.entityId === ids[x])?.state as never;
  /** The token reserve og's Entity has observed on chain (the same state the rewrite holds: roots agree). */
  const reserveOf = (x: number): bigint => ogState(x)?.reserves?.get(1) ?? 0n;
  const hasAccount = (x: number, y: number): boolean => ogState(x)?.accounts?.has(ids[y]!) ?? false;
  type OgAccount = {
    status?: string;
    counterpartyDisputeProofHanko?: string;
    activeDispute?: { disputeTimeout: number };
  };
  const ogAccount = (x: number, y: number): OgAccount | undefined =>
    ogState(x)?.accounts?.get(ids[y]!) as OgAccount | undefined;
  const batchOf = (x: number): { batch?: { disputeStarts?: unknown[] }; sentBatch?: unknown } | undefined =>
    ogState(x)?.jBatchState as never;
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
        if (timeout === undefined || env.state.timestamp >= Number(timeout) * 1000) return undefined;
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
    const imports = SIGNERS.map(
      (s, i): RuntimeTx =>
        ({
          type: "importReplica",
          entityId: ids[i]!,
          signerId: s,
          data: { config: config(s), isProposer: true, entitySeed: `0x${String(i + 1).repeat(128)}` },
        }) as RuntimeTx,
    );
    const expectClean = (diffs: string[]): void => expect(diffs).toEqual([]);
    expectClean(await tick(imports, []));
    expectClean(
      await tick(
        [],
        SPOKES.map((s) => user(s, [open(s, HUB, amount(20_000))])),
      ),
    );
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
    return coverage;
  } finally {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    await chain.close();
    ["", "-storage-current", "-storage-previous", "-wal", "-history-views", "-events", "-infra"].forEach((suffix) =>
      rmSync(join(dbRootPath, ns) + suffix, { recursive: true, force: true }),
    );
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
