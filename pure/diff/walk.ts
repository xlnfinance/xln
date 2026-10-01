// Model-based runtime-loop differential: the random walk over the draw table (draws/). Each frame the walk picks an
// enabled move, favouring the kinds it has committed least, and the lane compares og's processRuntime with the
// rewrite's commitRuntimeFrame after it. A run draws until every drawn kind in its areas has been an input of a
// committed frame (seed.ts untilCovered), so the floor is the model, not a count tuned to a seed.
//
// Guards come from og's handlers (ast-grep `if ($C) throw $E` over core/entity/tx/handlers): a plain Error there
// halts og's Runtime, so a draw only offers inputs whose guards hold, and refusal branches are drawn on purpose. An og
// halt a walk reaches fails it, even when the rewrite halts too, unless it is a known og bug (departures.ts
// KNOWN_OG_HALTS): otherwise it is a draw whose guard is weaker than og's.
//
// The properties of rig/properties/properties.ts (P2 credit-bounded, P4 agreed) and rig/properties/belief.ts (P-BELIEF, the Account never believes a value
// the chain did not hold, and at rest holds the chain's) run after every committed frame, and P1 (the chain pays what the
// Account says) runs a dispute to finalize when the walk ends. The disputes walk draws settlements too and starts its dispute only on
// an Account whose epoch has moved, so the start has to carry the epoch (C1); rig/shim/sent-checks.ts checks what the fork shim sent.
//
// One area, one walk per process (og worker fatals in one Bun process can crash it):
//   bun diff/walk.ts --area orderbook --seeds 3      the core draws plus one area's, on the first 3 walk seeds
//   bun diff/walk.ts --area orderbook --seed 0x30de1 one walk, as a run prints it
import { seedOf, untilCovered } from "./seed.ts";
import { tracing } from "./og/scenario-trace.ts";
import type { Coverage } from "./rig/lane.ts";
import { SHIM_GAS_BUDGET } from "./rig/fork-shim.ts";
import { gasHeadroomLines, startEpochLines } from "./rig/shim/sent-checks.ts";
import { openWorld } from "./rig/world.ts";
import { AREA, AREAS, type Area } from "./draws/areas.ts";
import { finalizedDisputes } from "./draws/disputes.ts";
import { judge } from "./findings/judge.ts";
import { KNOWN_FINDINGS } from "./findings/known.ts";
import { drawnIn, worldIn, type Drawn, type NamedWorldMove, type Scope } from "./draws/index.ts";
import { knownHalt } from "./rig/departures.ts";
import { judgeFrame, NO_MEMORY, type Memory, type Plant } from "./rig/frame-checks.ts";
import { probeCapacity } from "./rig/probe.ts";
import { unfired } from "./rig/properties/fired.ts";
import { closeOut, drain, enforceOne, settleBelief, type Enforced } from "./rig/properties/enforce.ts";
import { stableJson } from "../xln.ts";

/** The walk seeds, through seedOf like every stream in diff/ (SEEDX=0 walks 0x30de1, 0x30de2, ...). */
export const walkSeeds = (n: number): readonly number[] => Array.from({ length: n }, (_, i) => seedOf(0x30de1 + i));
/** Committed Runtime frames per run before the walk draws only for coverage. */
const FRAMES = 30;

/**
 * The lane's first disagreement, or none. `known` holds the lines a registered finding expected (findings/known.ts): printed, not red.
 * `diffs` holds everything else, including a registered expectation that did not appear.
 */
export type Walked = { readonly coverage: Coverage; readonly diffs: readonly string[]; readonly known: readonly string[] };
/** What the walk's loop ended with: the lines that stopped it (none when it ran its course) and what its frame checks remembered. */
type Looped = { readonly lines: readonly string[]; readonly memory: Memory };

/**
 * One walk over the given drawn rows and world moves; it stops at the first diff, an og halt both sides agree on, or a
 * departure. `plant` is a test's fault in what the properties read (rig/frame-checks.ts): the walk must then say so, and only the properties can.
 */
export const walk = async (
  seed: number,
  moves: readonly Drawn[],
  world: readonly NamedWorldMove[],
  area?: Area,
  plant?: Plant,
): Promise<Walked> => {
  const w = await openWorld(seed, "model", { disputeAfterEpoch: area === "disputes" });
  const { lane, coverage } = w;
  const tried = new Map<string, number>();
  try {
    const [imports, opens] = w.importAll();
    const setup = [...w.evidence, ...(await lane.tick(imports, [])), ...(await lane.tick([], opens))];
    if (setup.length > 0) return { coverage, diffs: setup, known: [] };
    await w.chain.debugFundReservesBatch(w.ids.map((entityId) => ({ entityId, tokenId: 1, amount: 10n ** 9n })));
    const funded = await lane.tick([], []);
    if (funded.length > 0) return { coverage, diffs: funded, known: [] };
    const covered = () => moves.every(([k]) => coverage.entityTxs.has(k));
    // a lifecycle an area's draws opened (a dispute) keeps the walk going past its floor until the lifecycle closes
    const owing = () => world.filter(([, m]) => m.owed?.(w) === true);
    const more = untilCovered(FRAMES, () => covered() && owing().length === 0, FRAMES * 6);
    // a halted og Runtime refuses every later frame, so a halt both sides agree on ends the run; so does a departure
    // (departures.ts), after which the two states differ
    const loop = async (i: number, memory: Memory): Promise<Looped> => {
      if (!more(i) || coverage.halts > 0 || coverage.departures.length > 0) return { lines: [], memory };
      const enabled = moves.filter(([, m]) => m.enabled(w));
      // favour the kinds committed least: weight 1 / (1 + times tried)
      const weights = enabled.map(([k]) => 1 / (1 + (tried.get(k) ?? 0)));
      const total = weights.reduce((a, b) => a + b, 0);
      const r = w.rand() * (total + 0.5);
      const at = weights.findIndex((_, j) => weights.slice(0, j + 1).reduce((a, b) => a + b, 0) > r);
      const chosen = at < 0 ? undefined : enabled[at];
      // no Entity tx drawn: one of the enabled world moves, uniformly
      const open = world.filter(([, m]) => m.enabled(w));
      const around = chosen === undefined ? open[w.ri(open.length)] : undefined;
      // an owed world move that is enabled goes first: it closes what an earlier draw opened
      const due = owing().find(([, m]) => m.enabled(w));
      const step = due !== undefined
        ? await due[1].draw(w)
        : chosen !== undefined ? chosen[1].draw(w) : await (around?.[1].draw(w) ?? { runtimeTxs: [], users: [] });
      const name = due?.[0] ?? chosen?.[0] ?? around?.[0] ?? "world";
      tried.set(name, (tried.get(name) ?? 0) + 1);
      coverage.actions[name] = (coverage.actions[name] ?? 0) + 1;
      if (tracing()) console.log(`frame ${lane.frames() + 1} ${name}`);
      const diffs = await lane.tick(step.runtimeTxs, step.users);
      // P2, P4 and P-BELIEF hold of the rewrite whatever og did (rig/frame-checks.ts)
      const framed = await judgeFrame(w, name, memory, plant);
      return diffs.length > 0 || framed.violations.length > 0 ? { lines: [...diffs, ...framed.violations], memory: framed.memory } : loop(i + 1, framed.memory);
    };
    const looped = await loop(0, NO_MEMORY);
    // the draws are over: clean so far means the lane agreed, nothing halted or departed
    const quiet = looped.lines.length === 0 && coverage.halts === 0 && coverage.departures.length === 0;
    // a walk that ended clean is taken through what its draws cannot reach, each step only while the ones before it said nothing:
    const atRest = async (): Promise<readonly string[]> => {
      coverage.actions["P-BELIEF:atRest"] = 1;
      return (await settleBelief(w)).map((l) => `${w.tag} frame ${lane.frames()} at rest: ${l}`);
    };
    const steps: readonly (() => Promise<readonly string[]>)[] = [
      // open settlements and unsent batches are closed out (rig/properties/enforce.ts closeOut): an Account holding a workspace or an Entity with a batch in flight is not ready, so P1 would skip it
      () => closeOut(w),
      // the capacity edge, which no draw reaches (rig/probe.ts); its frames are judged like the walk's
      async () => (await probeCapacity(w, looped.memory)).lines,
      // the probe's payments set the hub rebalancing on its own clock, and a batch of its landing inside P1's window would move the reserves P1 reads: waited out (no settlement draws: the Entity's own work is what is waited for)
      () => drain(w),
      // P1: one Account's dispute runs to finalize on the Depository, whose payout must match the Account (last of the checks that freeze an Account: the probe needs them free)
      async () => p1Lines(w.tag, coverage, await enforceOne(w)),
      // P-BELIEF at rest: every Account holds what the chain holds
      atRest,
    ];
    const walked = !quiet ? looped.lines : await steps.reduce<Promise<readonly string[]>>(async (said, step) => ((await said).length > 0 ? said : step()), Promise.resolve([]));
    const diffs = walked;
    // an agreed halt ends the walk; one that is not a known og bug is a draw og refuses
    const unguarded = coverage.haltTexts
      .filter((h) => knownHalt(h) === undefined)
      .map((h) => `${w.tag} og halted on a drawn input, not a known og halt: ${h}`);
    // the walk ended (floor, or cap) with a lifecycle still open: a dispute that never finalized
    const unclosed = owing().map(([n]) => `${w.tag} the walk ended with ${n} still owed: its lifecycle never closed`);
    // a walk of an area draws that area's moves: none committed, and the area is unchecked whatever the diffs say
    const own = area === undefined || area === "core" ? undefined : ownMoves(area, coverage);
    const silent = own === 0 ? [`${w.tag} the walk committed none of ${area}'s moves, so it checked nothing of that area`] : [];
    // a disputes walk finalizes its dispute on both sides: a walk that only prepared one never checked the payout
    const unfinalized = area === "disputes" && finalizedDisputes(w) === 0 ? [`${w.tag} no dispute finalized on both sides`] : [];
    coverage.actions["C1:startsAtMovedEpoch"] = w.sent.starts().filter((s) => s.current > 0n).length;
    coverage.actions["J5:peakBatchGas"] = Number(w.sent.peakGas());
    // C1 and J5 over what the shim handed the chain (rig/shim/sent-checks.ts)
    const sentScope = { tag: w.tag, disputes: area === "disputes", budget: SHIM_GAS_BUDGET };
    const sentLines = [...startEpochLines(sentScope, w.sent), ...gasHeadroomLines(sentScope, w.sent)];
    const refused = w.refusals().map((r) => `${w.tag} the chain refused a batch og submitted: ${r}`);
    const lines = [...diffs, ...unguarded, ...unclosed, ...silent, ...unfinalized, ...sentLines, ...refused];
    const judged = judge(KNOWN_FINDINGS, area ?? "model", seed, lines);
    return { coverage, diffs: [...judged.unknown, ...judged.stale], known: judged.known };
  } finally {
    await w.close();
  }
};

/** P1's broken lines, or the lane diffs its dispute ran into; the run's moves say whether it checked or skipped. */
const p1Lines = (tag: string, coverage: Coverage, enforced: Enforced | readonly string[]): readonly string[] => {
  if (!("_tag" in enforced)) return enforced;
  coverage.actions[`P1:${enforced._tag}`] = 1;
  return enforced._tag === "checked" ? enforced.lines.map((l) => `${tag} spoke ${enforced.spoke}: ${l}`) : [];
};

/** How many of an area's own moves a walk committed: its Entity tx kinds (drawn or arising) and its world moves. */
export const ownMoves = (area: Area, c: Coverage): number =>
  [...c.entityTxs].filter((k) => (AREA as Record<string, Area>)[k] === area).length
  + Object.keys(c.actions).filter((n) => n.startsWith(`${area}:`)).length;

/** The drawn kinds a walk over these rows never committed. */
export const uncovered = (moves: readonly Drawn[], seen: ReadonlySet<string>): readonly string[] =>
  moves.map(([k]) => k).filter((k) => !seen.has(k));

export const walkLine = (seed: number, c: Coverage): string =>
  `seed 0x${seed.toString(16)}: ${c.frames} Runtime frames, halts ${stableJson(c.haltTexts)}, departures `
  + `${stableJson(c.departures)}, moves ${stableJson(c.actions)}\n  committed kinds ${[...c.entityTxs].sort().join(",")}; `
  + `Account txs ${[...c.accountTxs].sort().join(",")}`;

// ---- the command ----

type Args = { readonly area: Area | undefined; readonly seeds: number; readonly seed: number | undefined };
const argOf = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
};
const parseArgs = (argv: readonly string[]): Args | string => {
  const area = argOf(argv, "--area");
  const seed = argOf(argv, "--seed");
  const seeds = Number(argOf(argv, "--seeds") ?? "3");
  if (area !== undefined && !(AREAS as readonly string[]).includes(area)) return `unknown area ${area}; one of ${AREAS.join(", ")}`;
  if (!Number.isSafeInteger(seeds) || seeds < 1) return "--seeds takes a positive count";
  if (seed !== undefined && !Number.isSafeInteger(Number(seed))) return `bad --seed ${seed}`;
  return { area: area as Area | undefined, seeds, seed: seed === undefined ? undefined : Number(seed) };
};
/**
 * The areas an area's walk draws from: the core world plus the area's own (every area when none is named). The disputes walk
 * also draws settlements, which move the Account epoch a dispute start has to carry (C1).
 */
const scopeOf = (area: Area | undefined): Scope => {
  switch (area) {
    case undefined: return "all";
    case "core": return ["core"];
    case "disputes": return ["core", "settlement", "disputes"];
    default: return ["core", area];
  }
};
const rowsFor = (area: Area | undefined): readonly Drawn[] => drawnIn(scopeOf(area));

/** One walk in this process: 0 when the lane agreed on every frame. */
const one = async (area: Area | undefined, seed: number): Promise<number> => {
  const { coverage, diffs, known } = await walk(seed, rowsFor(area), worldIn(scopeOf(area)), area);
  console.log(walkLine(seed, coverage));
  known.forEach((k) => console.log(`  KNOWN ${k}`));
  diffs.forEach((d) => console.log(`  DIFF ${d}`));
  console.log(`WALKED ${JSON.stringify({ seed, diffs: diffs.length, kinds: [...coverage.entityTxs], actions: coverage.actions })}`);
  return diffs.length > 0 ? 1 : 0;
};

/** Each seed in its own process; the run fails on any diff, or when the seeds together miss a drawn kind. */
const many = (args: Args): number => {
  const runs = walkSeeds(args.seeds).map((seed) => {
    const flags = [...(args.area === undefined ? [] : ["--area", args.area]), "--seed", `0x${seed.toString(16)}`];
    const child = Bun.spawnSync([process.execPath, import.meta.path, ...flags], { stdout: "pipe", stderr: "inherit" });
    const out = child.stdout.toString();
    process.stdout.write(out.split("\n").filter((l) => !l.startsWith("WALKED ")).join("\n"));
    const walked = out.split("\n").find((l) => l.startsWith("WALKED "));
    const parsed: { readonly kinds?: readonly string[]; readonly actions?: Readonly<Record<string, number>> } = walked === undefined ? {} : JSON.parse(walked.slice(7));
    return { ok: child.exitCode === 0 && walked !== undefined, kinds: parsed.kinds ?? [], actions: parsed.actions ?? {} };
  });
  const missed = uncovered(rowsFor(args.area), new Set(runs.flatMap((r) => r.kinds)));
  if (missed.length > 0) console.log(`UNCOVERED ${missed.join(",")}`);
  // a property that applies to this area but looked at nothing in any of its walks is as red as a diff (rig/properties/fired.ts)
  const silent = unfired(args.area ?? "model", runs.map((r) => r.actions));
  silent.forEach((line) => console.log(line));
  const failed = runs.filter((r) => !r.ok).length;
  const green = failed === 0 && missed.length === 0 && silent.length === 0;
  console.log(`${green ? "OK" : "FAIL"}: ${runs.length} walks, ${failed} failed`);
  return green ? 0 : 1;
};

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(args);
    process.exit(2);
  }
  process.exit(args.seed === undefined ? many(args) : await one(args.area, args.seed));
}
