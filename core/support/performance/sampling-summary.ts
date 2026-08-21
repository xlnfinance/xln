/**
 * Exclusive CPU from bun:jsc sampling dumps.
 * Inclusive any-frame counts overlap and must never be quoted as "% of CPU".
 */

type SamplingFrame = Readonly<{
  name?: string;
  sourceURL?: string;
  sourceID?: number;
  line?: number;
}>;

type SamplingTrace = Readonly<{ frames?: readonly SamplingFrame[] }>;

type SamplingSource = Readonly<{ sourceID?: number; url?: string }>;

export type SamplingDump = Readonly<{
  traces?: readonly SamplingTrace[];
  stackTraces?: readonly SamplingTrace[];
  samples?: readonly SamplingTrace[];
  sources?: readonly SamplingSource[];
}>;

type ExclusiveBucket = Readonly<{ label: string; count: number; percent: number }>;

export type ExclusiveSamplingSummary = Readonly<{
  samples: number;
  buckets: readonly ExclusiveBucket[];
  counted: number;
}>;

const DUMP_FRAMES = new Set(['samplingProfilerStackTraces', 'dumpSamplingProfile']);

const sourceUrl = (frame: SamplingFrame, sources: ReadonlyMap<number, string>): string => {
  const direct = String(frame.sourceURL || '').trim();
  if (direct) return direct;
  const id = frame.sourceID;
  return typeof id === 'number' ? (sources.get(id) ?? '') : '';
};

const shortenUrl = (url: string): string => {
  const core = url.match(/\/(core|runtime)\/(.+)$/);
  if (core) return `${core[1]}/${core[2]}`;
  const named = url.split('/').pop();
  return named && named.length > 0 ? named : url;
};

const executingFrame = (
  frames: readonly SamplingFrame[],
  sources: ReadonlyMap<number, string>,
): SamplingFrame | undefined => {
  for (const frame of frames) {
    const name = String(frame.name || '');
    if (DUMP_FRAMES.has(name)) continue;
    if (name || sourceUrl(frame, sources)) return frame;
  }
  return frames.find(frame => !DUMP_FRAMES.has(String(frame.name || ''))) ?? frames[0];
};

const labelFrame = (frame: SamplingFrame | undefined, sources: ReadonlyMap<number, string>): string => {
  if (!frame) return '(empty)';
  const name = String(frame.name || '(anon)');
  const url = sourceUrl(frame, sources);
  if (!url) return name;
  const line = Number(frame.line);
  const loc = Number.isSafeInteger(line) && line > 0 && line < 10_000_000 ? `:${line}` : '';
  return `${name}  ${shortenUrl(url)}${loc}`;
};

export const summarizeExclusiveSampling = (
  dump: SamplingDump,
  top = 25,
): ExclusiveSamplingSummary => {
  const traces = dump.traces ?? dump.stackTraces ?? dump.samples ?? [];
  const sources = new Map<number, string>();
  for (const source of dump.sources ?? []) {
    if (typeof source.sourceID === 'number' && source.url) sources.set(source.sourceID, source.url);
  }
  const counts = new Map<string, number>();
  for (const trace of traces) {
    const label = labelFrame(executingFrame(trace.frames ?? [], sources), sources);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const samples = traces.length;
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const head = ranked.slice(0, Math.max(0, top));
  const restCount = ranked.slice(Math.max(0, top)).reduce((sum, [, count]) => sum + count, 0);
  const buckets: ExclusiveBucket[] = head.map(([label, count]) => ({
    label,
    count,
    percent: samples === 0 ? 0 : (100 * count) / samples,
  }));
  if (restCount > 0) {
    buckets.push({
      label: `(other exclusive) ${ranked.length - head.length} leaves`,
      count: restCount,
      percent: samples === 0 ? 0 : (100 * restCount) / samples,
    });
  }
  const counted = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  if (counted !== samples) {
    throw new Error(`SAMPLING_EXCLUSIVE_SUM_MISMATCH:${counted}:${samples}`);
  }
  return { samples, buckets, counted };
};

export const formatExclusiveSampling = (summary: ExclusiveSamplingSummary): string[] => {
  const lines = [
    `samples=${summary.samples}  exclusive-sum=${summary.counted}  (${summary.samples === 0 ? '100.0' : (100 * summary.counted / summary.samples).toFixed(1)}%)`,
    '',
    'EXCLUSIVE (currently executing frame; percents sum to 100)',
  ];
  for (const [index, bucket] of summary.buckets.entries()) {
    lines.push(
      `${String(index + 1).padStart(2)}  ${bucket.percent.toFixed(1).padStart(5)}%  ${String(bucket.count).padStart(6)}  ${bucket.label}`,
    );
  }
  return lines;
};
