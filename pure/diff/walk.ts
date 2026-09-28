// Model-based runtime-loop differential: the random walk over the draw table (draws/). Each frame the walk picks an
// enabled move, favouring the kinds it has committed least, and the lane compares og's processRuntime with the
// rewrite's commitRuntimeFrame after it. A run draws until every drawn kind in its areas has been an input of a
// committed frame (seed.ts untilCovered), so the floor is the model, not a count tuned to a seed.
//
// Guards come from og's handlers (ast-grep `if ($C) throw $E` over core/entity/tx/handlers): a plain Error there
// halts og's Runtime, so a draw only offers inputs whose guards hold, and refusal branches are drawn on purpose.
//
// One area, one walk per process (og worker fatals in one Bun process can crash it):
//   bun diff/walk.ts --area orderbook --seeds 3      the core draws plus one area's, on the first 3 walk seeds
//   bun diff/walk.ts --area orderbook --seed 0x30de1 one walk, as a run prints it
import { seedOf, untilCovered } from "./seed.ts";
import { tracing } from "./scenario-trace.ts";
import type { Coverage } from "./lane.ts";
import { openWorld, type World } from "./world.ts";
import { AREAS, type Area } from "./draws/areas.ts";
import type { Step } from "./draws/areas.ts";
import { drawnIn, type Drawn } from "./draws/index.ts";
import { stableJson } from "../xln.ts";

/** The walk seeds, through seedOf like every stream in diff/ (SEEDX=0 walks 0x30de1, 0x30de2, ...). */
export const walkSeeds = (n: number): readonly number[] => Array.from({ length: n }, (_, i) => seedOf(0x30de1 + i));
/** Committed Runtime frames per run before the walk draws only for coverage. */
const FRAMES = 30;

/** The lane's first disagreement, or none. */
export type Walked = { readonly coverage: Coverage; readonly diffs: readonly string[] };

/** Chain-side moves that are not Entity txs: new reserves the watcher reports. */
const fund = async (w: World): Promise<Step> => {
  await w.chain.debugFundReserves(w.ids[w.ri(4)]!, 1, BigInt(1 + w.ri(1_000_000)));
  return { runtimeTxs: [], users: [] };
};

/** One walk over the given drawn rows; it stops at the first diff, an og halt both sides agree on, or a departure. */
export const walk = async (seed: number, moves: readonly Drawn[]): Promise<Walked> => {
  const w = await openWorld(seed, "model");
  const { lane, coverage } = w;
  const tried = new Map<string, number>();
  try {
    const [imports, opens] = w.importAll();
    const setup = [...(await lane.tick(imports, [])), ...(await lane.tick([], opens))];
    if (setup.length > 0) return { coverage, diffs: setup };
    await w.chain.debugFundReservesBatch(w.ids.map((entityId) => ({ entityId, tokenId: 1, amount: 10n ** 9n })));
    const funded = await lane.tick([], []);
    if (funded.length > 0) return { coverage, diffs: funded };
    const covered = () => moves.every(([k]) => coverage.entityTxs.has(k));
    const more = untilCovered(FRAMES, covered, FRAMES * 6);
    // a halted og Runtime refuses every later frame, so a halt both sides agree on ends the run; so does a departure
    // (departures.ts), after which the two states differ
    const loop = async (i: number): Promise<readonly string[]> => {
      if (!more(i) || coverage.halts > 0 || coverage.departures.length > 0) return [];
      const enabled = moves.filter(([, m]) => m.enabled(w));
      // favour the kinds committed least: weight 1 / (1 + times tried)
      const weights = enabled.map(([k]) => 1 / (1 + (tried.get(k) ?? 0)));
      const total = weights.reduce((a, b) => a + b, 0);
      const r = w.rand() * (total + 0.5);
      const at = weights.findIndex((_, j) => weights.slice(0, j + 1).reduce((a, b) => a + b, 0) > r);
      const chosen = at < 0 ? undefined : enabled[at];
      const step = chosen === undefined ? (w.rand() < 0.5 ? await fund(w) : { runtimeTxs: [], users: [] }) : chosen[1].draw(w);
      const name = chosen?.[0] ?? "world";
      tried.set(name, (tried.get(name) ?? 0) + 1);
      coverage.actions[name] = (coverage.actions[name] ?? 0) + 1;
      if (tracing()) console.log(`frame ${lane.frames() + 1} ${name}`);
      const diffs = await lane.tick(step.runtimeTxs, step.users);
      return diffs.length > 0 ? diffs : loop(i + 1);
    };
    return { coverage, diffs: await loop(0) };
  } finally {
    await w.close();
  }
};

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
/** The rows an area's walk draws: the core world plus the area's own (every area when none is named). */
const rowsFor = (area: Area | undefined): readonly Drawn[] =>
  drawnIn(area === undefined ? [] : area === "core" ? ["core"] : ["core", area]);

/** One walk in this process: 0 when the lane agreed on every frame. */
const one = async (area: Area | undefined, seed: number): Promise<number> => {
  const { coverage, diffs } = await walk(seed, rowsFor(area));
  console.log(walkLine(seed, coverage));
  diffs.forEach((d) => console.log(`  DIFF ${d}`));
  console.log(`WALKED ${JSON.stringify({ seed, diffs: diffs.length, kinds: [...coverage.entityTxs] })}`);
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
    const kinds: readonly string[] = walked === undefined ? [] : JSON.parse(walked.slice(7)).kinds;
    return { ok: child.exitCode === 0 && walked !== undefined, kinds };
  });
  const missed = uncovered(rowsFor(args.area), new Set(runs.flatMap((r) => r.kinds)));
  if (missed.length > 0) console.log(`UNCOVERED ${missed.join(",")}`);
  const failed = runs.filter((r) => !r.ok).length;
  console.log(`${failed === 0 && missed.length === 0 ? "OK" : "FAIL"}: ${runs.length} walks, ${failed} failed`);
  return failed === 0 && missed.length === 0 ? 0 : 1;
};

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(args);
    process.exit(2);
  }
  process.exit(args.seed === undefined ? many(args) : await one(args.area, args.seed));
}
