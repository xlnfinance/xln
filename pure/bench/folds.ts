// Microbenchmark for the vocabulary folds (review B1): each helper should grow linearly with n.
// Run from pure/: `bun bench/folds.ts`. A 4x jump in n should cost about 4x the time, not 16x.
import * as xln from "../xln.ts";

const SIZES = [1_000, 10_000, 40_000] as const;
// Small sizes finish in microseconds, so each case runs several times and reports the best run.
const RUNS = 5;
// reduce+mapSet copies the whole map per insert, so it stays quadratic by design: it is the
// call-site pattern mapSetAll replaces. It is capped so the benchmark finishes.
const QUADRATIC_CAP = 10_000;

type Case = { readonly name: string; readonly cap?: number; readonly run: (xs: readonly number[]) => unknown };
type BulkInsert = <K, V>(m: ReadonlyMap<K, V>, entries: Iterable<readonly [K, V]>) => ReadonlyMap<K, V>;

const bestOf = (run: () => unknown): number => {
  const times = Array.from({ length: RUNS }, () => {
    const start = Bun.nanoseconds();
    run();
    return (Bun.nanoseconds() - start) / 1e6;
  });
  return Math.min(...times);
};

// The reference: what a hand-written loop costs for the same work.
const plainLoop = (xs: readonly number[]): readonly number[] => {
  const out: number[] = [];
  for (const x of xs) out.push(x * 2);
  return out;
};

const doubled = (x: number): number => x * 2;
const keyed = (x: number): readonly [string, number] => [`k${x}`, x];
const sumAndDouble = (sum: number, x: number) => [sum + x, doubled(x)] as const;
const stepSum = (s: number, x: number) => xln.ok(xln.step(s + x, [x]));

// mapSetAll is the bulk insert the B1 fix adds; on the code before the fix that case is skipped.
const mapSetAll = (xln as Record<string, unknown>)["mapSetAll"] as BulkInsert | undefined;
const bulkCase: readonly Case[] =
  mapSetAll === undefined ? [] : [{ name: "mapSetAll", run: (xs) => mapSetAll(new Map(), xs.map(keyed)) }];

const cases: readonly Case[] = [
  { name: "plain loop", run: plainLoop },
  { name: "mapAccum", run: (xs) => xln.mapAccum(xs, 0, sumAndDouble) },
  { name: "mapAccumResult", run: (xs) => xln.mapAccumResult(xs, 0, (s, x) => xln.ok(sumAndDouble(s, x))) },
  { name: "traverse", run: (xs) => xln.traverse(xs, (x) => xln.ok(doubled(x))) },
  { name: "strictFold", run: (xs) => xln.strictFold(stepSum)(0, xs, undefined) },
  { name: "all (record)", run: (xs) => xln.all(Object.fromEntries(xs.map((x) => [`k${x}`, xln.ok(x)]))) },
  {
    name: "reduce+mapSet",
    cap: QUADRATIC_CAP,
    run: (xs) => xs.reduce<ReadonlyMap<string, number>>((m, x) => xln.mapSet(m, ...keyed(x)), new Map()),
  },
  ...bulkCase,
];

const cell = ({ run, cap }: Case, n: number): string => {
  const xs = Array.from({ length: n }, (_, i) => i);
  const text = cap !== undefined && n > cap ? "skipped" : `${bestOf(() => run(xs)).toFixed(2)} ms`;
  return text.padStart(12);
};

console.log(["helper".padEnd(16), ...SIZES.map((n) => `n=${n}`.padStart(12))].join(""));
cases.forEach((c) => console.log([c.name.padEnd(16), ...SIZES.map((n) => cell(c, n))].join("")));
