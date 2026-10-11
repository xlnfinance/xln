/** Shared result shapes and the scoring arithmetic every XLN-1000 axis uses. */

export type AxisId = 'R' | 'J' | 'X' | 'H' | 'K' | 'S' | 'F' | 'P' | 'D' | 'M';

/** One sub-item that is not yet at full credit; `points` is the score it would add at full credit. */
export type Gap = Readonly<{ axis: AxisId; item: string; points: number; deferred: boolean }>;

export type Axis = Readonly<{
  id: AxisId;
  name: string;
  weight: number;
  score: number;
  /** Score if stale or unknown evidence reproduced at this SHA; never part of the total. */
  ceiling: number;
  sub: Readonly<Record<string, number>>;
  gaps: readonly Gap[];
  vetoes: readonly string[];
  raw: Readonly<Record<string, unknown>>;
}>;

export const DAY_MS = 86_400_000;

export const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

/** 1 at `best`, 0 at `worst`, logarithmic in between (lower raw values are better when best < worst). */
export const logScore = (value: number, best: number, worst: number): number =>
  clamp01((Math.log10(worst) - Math.log10(value)) / (Math.log10(worst) - Math.log10(best)));

export const linScore = (value: number, best: number, worst: number): number =>
  clamp01((worst - value) / (worst - best));

export const round = (value: number, digits = 1): number => Math.round(value * 10 ** digits) / 10 ** digits;

export const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length > 0 ? (sorted[Math.floor(sorted.length / 2)] ?? Number.NaN) : Number.NaN;
};

/** Laplace-smoothed success probability: an unobserved stage counts as a coin flip, never as green. */
export const laplace = (ok: number, total: number): number => (ok + 1) / (total + 2);

export const gap = (axis: AxisId, item: string, points: number, deferred = false): Gap => ({
  axis,
  item,
  points: round(points),
  deferred,
});

export const weightedSum = (
  parts: Readonly<Record<string, number>>,
  weights: Readonly<Record<string, number>>,
): number => Object.entries(weights).reduce((sum, [key, weight]) => sum + weight * (parts[key] ?? 0), 0);

export const sortedEntries = (counts: ReadonlyMap<string, number>): Record<string, number> =>
  Object.fromEntries([...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
