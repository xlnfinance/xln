#!/usr/bin/env bun
/**
 * Renders the HLT throughput ledger as one self-contained page.
 *
 * A load run is only useful next to the runs before it: the question is never
 * "what is the TPS" but "what did this commit buy". The chart therefore plots
 * every recorded run against wall-clock time and hangs the commit, the
 * population and the reason for the change off each point.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const LEDGER_PATH = join(REPO_ROOT, 'hlt-runs.json');
const OUTPUT_PATH = join(REPO_ROOT, 'hlt-progress.html');
const COMMIT_URL = 'https://github.com/xlnfinance/xln/commit/';

export type HltRun = Readonly<{
  /** ISO 8601, when the run finished. */
  at: string;
  commit: string;
  /** What this run was meant to prove or change, one line. */
  headline: string;
  /** Why the number moved; shown on hover. */
  detail: string;
  users: number;
  /** Delivered payments per second, or 0 when the run carried no payments. */
  paymentsTps: number;
  /** Settled swaps per second, or 0 when the run carried no swaps. */
  swapsTps: number;
  status: 'green' | 'red';
}>;

type Ledger = Readonly<{ schema: string; note: string; runs: readonly HltRun[] }>;

const TARGET_TPS = 1_000;

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] ?? character));

export const readLedger = (path = LEDGER_PATH): Ledger => {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
  if (parsed.schema !== 'xln-hlt-progress-v1') throw new Error(`HLT_PROGRESS_SCHEMA_INVALID:${parsed.schema}`);
  return parsed;
};

/**
 * Runs are placed on the x axis by their order, not by their timestamp: two
 * runs minutes apart and two runs a day apart are equally interesting, and an
 * even spacing keeps early runs readable once a long tail accumulates.
 */
const layout = (runs: readonly HltRun[]) => {
  const width = 1_040;
  const height = 460;
  const padding = { top: 32, right: 32, bottom: 76, left: 72 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const peak = Math.max(TARGET_TPS, ...runs.map(run => Math.max(run.paymentsTps, run.swapsTps)));
  const ceiling = Math.max(10, Math.ceil(peak / 100) * 100);
  const x = (index: number): number =>
    runs.length <= 1 ? padding.left + plotWidth / 2
      : padding.left + (index / (runs.length - 1)) * plotWidth;
  const y = (value: number): number => padding.top + plotHeight - (value / ceiling) * plotHeight;
  return { width, height, padding, plotWidth, plotHeight, ceiling, x, y };
};

const seriesPath = (
  runs: readonly HltRun[],
  pick: (run: HltRun) => number,
  frame: ReturnType<typeof layout>,
): string => runs
  .map((run, index) => `${index === 0 ? 'M' : 'L'}${frame.x(index).toFixed(1)},${frame.y(pick(run)).toFixed(1)}`)
  .join(' ');

export const renderProgressPage = (ledger: Ledger): string => {
  const runs = ledger.runs;
  const frame = layout(runs);
  const gridValues = Array.from({ length: 5 }, (_, index) => Math.round((frame.ceiling / 4) * index));
  const latest = runs[runs.length - 1];

  const grid = gridValues.map(value => `
    <line class="grid" x1="${frame.padding.left}" x2="${frame.width - frame.padding.right}"
          y1="${frame.y(value).toFixed(1)}" y2="${frame.y(value).toFixed(1)}" />
    <text class="axis" x="${frame.padding.left - 12}" y="${(frame.y(value) + 4).toFixed(1)}"
          text-anchor="end">${value}</text>`).join('');

  const targetLine = `
    <line class="target" x1="${frame.padding.left}" x2="${frame.width - frame.padding.right}"
          y1="${frame.y(TARGET_TPS).toFixed(1)}" y2="${frame.y(TARGET_TPS).toFixed(1)}" />
    <text class="target-label" x="${frame.width - frame.padding.right}" y="${(frame.y(TARGET_TPS) - 8).toFixed(1)}"
          text-anchor="end">target ${TARGET_TPS}</text>`;

  const points = runs.flatMap((run, index) => ([
    { run, index, value: run.paymentsTps, kind: 'payments' as const },
    { run, index, value: run.swapsTps, kind: 'swaps' as const },
  ])).filter(point => point.value > 0).map(point => `
    <circle class="dot ${point.kind} ${point.run.status}" data-run="${point.index}"
            cx="${frame.x(point.index).toFixed(1)}" cy="${frame.y(point.value).toFixed(1)}" r="6">
      <title>${escapeHtml(`${point.kind}: ${point.value} /s — ${point.run.headline}\n${point.run.detail}`)}</title>
    </circle>`).join('');

  const ticks = runs.map((run, index) => `
    <text class="tick" x="${frame.x(index).toFixed(1)}" y="${frame.height - frame.padding.bottom + 24}"
          text-anchor="middle" data-run="${index}">${escapeHtml(run.commit.slice(0, 7))}</text>
    <text class="tick faint" x="${frame.x(index).toFixed(1)}" y="${frame.height - frame.padding.bottom + 42}"
          text-anchor="middle">${run.users}u</text>`).join('');

  const rows = [...runs].reverse().map(run => `
    <tr class="${run.status}">
      <td class="mono">${escapeHtml(run.at.replace('T', ' ').replace(/\..*$/, ''))}</td>
      <td class="mono"><a href="${COMMIT_URL}${escapeHtml(run.commit)}">${escapeHtml(run.commit.slice(0, 7))}</a></td>
      <td class="num">${run.users}</td>
      <td class="num">${run.paymentsTps || '—'}</td>
      <td class="num">${run.swapsTps || '—'}</td>
      <td>${escapeHtml(run.headline)}<div class="detail">${escapeHtml(run.detail)}</div></td>
    </tr>`).join('');

  return `<title>HLT Throughput Ledger</title>
<style>
  :root {
    --bg: #f7f7f5; --panel: #ffffff; --ink: #16150f; --muted: #6b6a63; --line: #dedcd4;
    --payments: #2f6f4f; --swaps: #8a4b1f; --target: #b3271e; --red: #b3271e;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #14140f; --panel: #1c1c16; --ink: #f2f1e8; --muted: #9a988d; --line: #33322a;
      --payments: #6fc296; --swaps: #e0a066; --target: #e4695f; --red: #e4695f;
    }
  }
  :root[data-theme="dark"] {
    --bg: #14140f; --panel: #1c1c16; --ink: #f2f1e8; --muted: #9a988d; --line: #33322a;
    --payments: #6fc296; --swaps: #e0a066; --target: #e4695f; --red: #e4695f;
  }
  body { background: var(--bg); color: var(--ink); margin: 0; padding: 40px 24px 72px;
         font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); margin: 0 0 28px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
  .chart-wrap { overflow-x: auto; }
  svg { display: block; min-width: 720px; }
  .grid { stroke: var(--line); stroke-width: 1; }
  .axis, .tick { fill: var(--muted); font-size: 11px; font-family: ui-monospace, monospace; }
  .tick.faint { opacity: 0.6; }
  .target { stroke: var(--target); stroke-width: 1.5; stroke-dasharray: 5 5; opacity: 0.75; }
  .target-label { fill: var(--target); font-size: 11px; font-family: ui-monospace, monospace; }
  path.line { fill: none; stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
  path.payments { stroke: var(--payments); }
  path.swaps { stroke: var(--swaps); }
  circle.dot { stroke: var(--panel); stroke-width: 2; cursor: help; }
  circle.payments { fill: var(--payments); }
  circle.swaps { fill: var(--swaps); }
  circle.red { fill: var(--red); }
  .legend { display: flex; gap: 20px; margin: 16px 0 0; color: var(--muted); font-size: 13px; }
  .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: -1px; margin-right: 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 28px; font-size: 14px; }
  th { text-align: left; color: var(--muted); font-weight: 600; font-size: 12px;
       text-transform: uppercase; letter-spacing: 0.04em; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  td { padding: 12px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; }
  td.mono, .mono { font-family: ui-monospace, monospace; font-size: 13px; }
  tr.red td:first-child { box-shadow: inset 3px 0 0 var(--red); }
  .detail { color: var(--muted); font-size: 13px; margin-top: 3px; }
  a { color: inherit; }
  .empty { color: var(--muted); padding: 40px 0; text-align: center; }
</style>
<main>
  <h1>HLT throughput ledger</h1>
  <p class="sub">Every recorded high-load run on the way to 1000 payments/s and 1000 same-J swaps/s.
     Hover a point for what that commit changed.${latest ? ` Latest: ${escapeHtml(latest.headline)}.` : ''}</p>
  <div class="card">
    ${runs.length === 0 ? '<p class="empty">No runs recorded yet.</p>' : `
    <div class="chart-wrap">
      <svg viewBox="0 0 ${frame.width} ${frame.height}" role="img" aria-label="Throughput per run">
        ${grid}
        ${targetLine}
        <path class="line payments" d="${seriesPath(runs, run => run.paymentsTps, frame)}" />
        <path class="line swaps" d="${seriesPath(runs, run => run.swapsTps, frame)}" />
        ${points}
        ${ticks}
      </svg>
    </div>
    <div class="legend">
      <span><i class="swatch" style="background: var(--payments)"></i>payments /s</span>
      <span><i class="swatch" style="background: var(--swaps)"></i>same-J swaps /s</span>
      <span><i class="swatch" style="background: var(--target)"></i>target</span>
    </div>`}
  </div>
  ${runs.length === 0 ? '' : `
  <table>
    <thead><tr><th>when</th><th>commit</th><th>users</th><th>pay/s</th><th>swap/s</th><th>what changed</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
</main>
`;
};

if (import.meta.main) {
  writeFileSync(OUTPUT_PATH, renderProgressPage(readLedger()));
  console.log(`[hlt-progress] wrote ${OUTPUT_PATH}`);
}
