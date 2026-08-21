#!/usr/bin/env bun
/**
 * Build a self-contained HTML profile report from one HLT run directory.
 *
 * Inputs: server.log (structured profile lines, [H1]-prefixed hub stdout),
 * hlt-payment-load-report.json and/or production-swap-load-report.json,
 * optional Bun .cpuprofile file(s). Output: <runDir>/profile-report.html.
 *
 * Usage: bun core/scripts/operations/benchmark/hlt-profile-report.ts <runDir> [--title LABEL]
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const runDir = args[0];
if (!runDir || !existsSync(runDir)) {
  console.error('usage: hlt-profile-report.ts <runDir> [--title LABEL]');
  process.exit(1);
}
const titleFlag = args.indexOf('--title');
const title = titleFlag >= 0 ? (args[titleFlag + 1] ?? 'HLT run') : 'HLT run';

type PhaseAgg = { count: number; totalMs: number; maxMs: number; avgMs: number };
type EventAgg = { count: number; totalMs: number; maxMs: number; phases: Map<string, PhaseAgg>; extras: Map<string, number> };

const parseProfileLines = (logPath: string): Map<string, EventAgg> => {
  const events = new Map<string, EventAgg>();
  if (!existsSync(logPath)) return events;
  const lines = readFileSync(logPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/\[(INFO|DEBUG)\]\[([^\]]+)\] ([\w.]+) (\{.*\})/);
    if (!m) continue;
    const scope = m[2];
    const message = m[3];
    const jsonRaw = m[4];
    if (!scope || !message || !jsonRaw) continue;
    if (!message.endsWith('.profile')) continue;
    let f: Record<string, unknown>;
    try { f = JSON.parse(jsonRaw); } catch { continue; }
    const elapsed = Number(f['elapsedMs'] ?? 0);
    const key = `${scope}:${message}`;
    let agg = events.get(key);
    if (!agg) { agg = { count: 0, totalMs: 0, maxMs: 0, phases: new Map(), extras: new Map() }; events.set(key, agg); }
    agg.count += 1; agg.totalMs += elapsed; agg.maxMs = Math.max(agg.maxMs, elapsed);
    const phases = f['phases'];
    if (Array.isArray(phases)) {
      for (const p of phases as { name?: string; ms?: number }[]) {
        const name = String(p['name'] ?? '?');
        const ms = Number(p['ms'] ?? 0);
        let e = agg.phases.get(name);
        if (!e) { e = { count: 0, totalMs: 0, maxMs: 0, avgMs: 0 }; agg.phases.set(name, e); }
        e.count += 1; e.totalMs += ms; e.maxMs = Math.max(e.maxMs, ms);
      }
    }
    for (const extra of ['entityInputs', 'outputs', 'txs', 'accountsToPropose']) {
      const v = f[extra];
      if (typeof v === 'number') agg.extras.set(extra, (agg.extras.get(extra) ?? 0) + v);
    }
  }
  for (const agg of events.values()) { agg.totalMs = Math.round(agg.totalMs); for (const p of agg.phases.values()) p.avgMs = p.totalMs / agg.count; }
  return events;
};

const parseProposalTrace = (logPath: string): Array<Record<string, number | boolean | string>> => {
  if (!existsSync(logPath)) return [];
  const rows: Array<Record<string, number | boolean | string>> = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const m = line.match(/\[INFO\]\[entity\] proposal\.trace (\{.*\})/);
    if (!m) continue;
    try { rows.push(JSON.parse(m[1]!)); } catch { /* skip */ }
  }
  return rows;
};

type CpuNode = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children: number[]; hitCount: number; parent?: number };
const buildFlamegraph = (profilePath: string, maxDepth = 28, minPct = 0.05): string => {
  if (!existsSync(profilePath)) return '';
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as {
    nodes: CpuNode[]; samples: number[]; timeDeltas: number[];
  };
  const byId = new Map<number, CpuNode>();
  for (const node of profile.nodes) byId.set(node.id, node);
  for (const node of profile.nodes) for (const child of node.children ?? []) byId.get(child)!.parent = node.id;
  const selfMicros = new Map<number, number>();
  let sampledMicros = 0;
  profile.samples.forEach((nodeId, index) => {
    const delta = profile.timeDeltas[index] ?? 1000;
    if (delta <= 0 || delta > 1_000_000) return;
    selfMicros.set(nodeId, (selfMicros.get(nodeId) ?? 0) + delta);
    sampledMicros += delta;
  });
  const totalMicros = sampledMicros;
  const inclusiveMicros = new Map<number, number>();
  const stackOf = (id: number): number[] => {
    const out: number[] = [];
    let cur: number | undefined = id;
    while (cur !== undefined && out.length < 64) { out.push(cur); cur = byId.get(cur)!.parent; }
    return out.reverse();
  };
  for (const [id, micros] of selfMicros) for (const frame of stackOf(id)) inclusiveMicros.set(frame, (inclusiveMicros.get(frame) ?? 0) + micros);
  const label = (id: number): string => {
    const node = byId.get(id)!;
    const fn = node.callFrame.functionName || '(anon)';
    const url = (node.callFrame.url || '').replace(/^.*\/core\//, '').replace(/^.*\/node_modules\//, '');
    const loc = url ? `${url}:${node.callFrame.lineNumber + 1}` : '';
    return loc ? `${fn} — ${loc}` : fn;
  };
  const rows: Array<{ depth: number; id: number; micros: number }> = [];
  const walk = (id: number, depth: number): void => {
    if (depth > maxDepth) return;
    const micros = inclusiveMicros.get(id) ?? 0;
    if (micros / totalMicros < minPct / 100) return;
    rows.push({ depth, id, micros });
    const children = [...(byId.get(id)!.children ?? [])]
      .filter(child => (inclusiveMicros.get(child) ?? 0) / totalMicros >= minPct / 100)
      .sort((a, b) => (inclusiveMicros.get(b) ?? 0) - (inclusiveMicros.get(a) ?? 0));
    for (const child of children) walk(child, depth + 1);
  };
  const root = profile.nodes[0];
  if (!root) return '';
  walk(root.id, 0);
  const rowHeight = 18;
  const width = 1180;
  const maxDepthUsed = Math.max(...rows.map(r => r.depth), 0);
  const height = (maxDepthUsed + 1) * rowHeight + 8;
  const palette = (pct: number): string => {
    const hue = 210 - Math.min(1, pct / 25) * 190;
    return `hsl(${hue}, 72%, 52%)`;
  };
  const rects: string[] = [];
  const widthById = new Map<number, number>();
  for (const row of rows) widthById.set(row.id, (row.micros / totalMicros) * width);
  for (const row of rows) {
    const w = widthById.get(row.id)!;
    const parent = byId.get(row.id)!.parent;
    let x = 0;
    if (parent !== undefined) {
      // Place left-to-right among rendered siblings; offset via parent's used width.
      const used = usedWidth.get(parent) ?? 0;
      x = used;
      usedWidth.set(parent, used + w);
    }
    usedWidth.set(row.id, 0);
    const pct = (row.micros / totalMicros) * 100;
    const text = `${label(row.id)}  ${pct.toFixed(1)}% (${(row.micros / 1000).toFixed(0)}ms)`;
    rects.push(
      `<g><rect x="${x.toFixed(1)}" y="${row.depth * rowHeight}" width="${Math.max(1, w - 1).toFixed(1)}" height="${rowHeight - 1}" rx="2" fill="${palette(pct)}"><title>${escapeHtml(text)}</title></rect>` +
      (w > 90 ? `<text x="${(x + 4).toFixed(1)}" y="${row.depth * rowHeight + 12}" font-size="10" fill="#0b0e14" clip-path="none">${escapeHtml(text.slice(0, Math.floor(w / 6)))}</text>` : '') +
      `</g>`,
    );
  }
  return `<div class="card"><h2>CPU flamegraph — ${escapeHtml(profilePath.split('/').pop() ?? '')} (total ${(totalMicros / 1000).toFixed(0)}ms, ≥${minPct}%)</h2><svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="max-width:${width}px">${rects.join('')}</svg></div>`;
};
const usedWidth = new Map<number, number>();

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

const histogram = (values: number[], bins: number[], labelFn: (from: number, to: number) => string): { rows: string[]; max: number } => {
  const counts = bins.slice(0, -1).map((from, i) => values.filter(v => v >= from && v < bins[i + 1]!).length);
  const max = Math.max(1, ...counts);
  const rows = counts.map((count, i) => {
    const pct = (count / Math.max(1, values.length)) * 100;
    return `<div class="hrow"><span class="hlabel">${escapeHtml(labelFn(bins[i]!, bins[i + 1]!))}</span><div class="hbar"><div class="hfill" style="width:${(count / max) * 100}%"></div></div><span class="hval">${count} · ${pct.toFixed(1)}%</span></div>`;
  });
  return { rows, max };
};

const serverLog = join(runDir, 'server.log');
const events = parseProfileLines(serverLog);
const traceRows = parseProposalTrace(serverLog);

const loadReports: Array<{ name: string; report: Record<string, unknown> }> = [];
for (const name of ['hlt-payment-load-report.json', 'production-swap-load-report.json']) {
  const p = join(runDir, name);
  if (existsSync(p)) { try { loadReports.push({ name, report: JSON.parse(readFileSync(p, 'utf8')) }); } catch { /* skip */ } }
}

const cards: string[] = [];
for (const { name, report } of loadReports) {
  cards.push(card(name.replace('.json', ''), [
    `TPS: <b>${Number(report['deliveredTps'] ?? report['tps'] ?? 0).toFixed(1)}</b>`,
    `items: ${String(report['deliveredPayments'] ?? report['swaps'] ?? report['trades'] ?? '?')}`,
    `drain: ${String(report['deliveredElapsedMs'] ?? '?')}ms`,
    `hub height: ${String((report['hubDurableBefore'] as Record<string, unknown>)?.['height'] ?? '?')} → ${String((report['hubDurableAfter'] as Record<string, unknown>)?.['height'] ?? '?')}`,
  ]));
}
if (traceRows.length > 0) {
  const mempool = traceRows.map(r => Number(r['mempoolTxs'] ?? 0));
  const selected = traceRows.map(r => Number(r['selectedTxs'] ?? 0));
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const singlePct = (100 * selected.filter(v => v === 1).length) / selected.length;
  cards.push(card('proposal batching', [
    `proposals: <b>${traceRows.length}</b>`,
    `avg selected: <b>${avg(selected).toFixed(1)}</b> tx/frame`,
    `1-tx proposals: <b>${singlePct.toFixed(0)}%</b>`,
    `avg mempool at entry: ${avg(mempool).toFixed(1)}`,
  ]));
}

function card(name: string, lines: string[]): string {
  return `<div class="card"><h2>${escapeHtml(name)}</h2>${lines.map(l => `<div class="metric">${l}</div>`).join('')}</div>`;
}

const phaseSection = (): string => {
  const out: string[] = [];
  for (const [key, agg] of [...events.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)) {
    const phases = [...agg.phases.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
    const barCells = phases.map(([name, p]) => {
      const pct = (p.totalMs / Math.max(1, agg.totalMs)) * 100;
      const hue = 200 + (pct % 1) * 0;
      return `<div class="seg" style="flex:${p.totalMs};background:hsl(${hue},65%,${45 + pct / 4}%)" title="${escapeHtml(name)}: ${p.totalMs}ms total, avg ${p.avgMs.toFixed(2)}ms, max ${p.maxMs}ms">${pct > 9 ? `${escapeHtml(name)} ${pct.toFixed(0)}%` : ''}</div>`;
    }).join('');
    out.push(`<div class="prof"><div class="profhead"><b>${escapeHtml(key)}</b> · n=${agg.count} · total ${agg.totalMs}ms · avg ${(agg.totalMs / agg.count).toFixed(1)}ms · max ${agg.maxMs}ms</div><div class="stackbar">${barCells}</div></div>`);
  }
  return out.join('');
};

const traceSection = (): string => {
  if (traceRows.length === 0) return '';
  const selected = traceRows.map(r => Number(r['selectedTxs'] ?? 0));
  const bins = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 101, 100000];
  const labels: string[] = [];
  for (let i = 0; i < bins.length - 1; i += 1) {
    const from = bins[i]!;
    const to = bins[i + 1]!;
    labels.push(to === 1 ? '0' : to === 100000 ? `${from}+` : to - from === 1 ? `${to}` : `${from}-${to - 1}`);
  }
  const hist = histogram(selected, bins, (from) => labels[bins.indexOf(from)] ?? `${from}`);
  return `<div class="card"><h2>txs per entity proposal (histogram)</h2>${hist.rows.join('')}</div>`;
};

const flamegraphs = readdirSync(runDir)
  .filter(f => f.endsWith('.cpuprofile'))
  .map(f => buildFlamegraph(join(runDir, f)))
  .join('\n');

const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} — XLN HLT profile</title>
<style>
 body{background:#0b0e14;color:#c9d1d9;font:14px/1.5 -apple-system,system-ui,sans-serif;margin:24px}
 h1{font-size:20px} h2{font-size:14px;margin:0 0 10px;color:#8ab4ff;text-transform:uppercase;letter-spacing:.04em}
 .cards{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px}
 .card{background:#11151d;border:1px solid #21262d;border-radius:10px;padding:14px 18px;min-width:240px}
 .metric{font-size:14px;padding:2px 0} .metric b{color:#7ee787;font-size:16px}
 .prof{margin:10px 0} .profhead{font-size:12px;color:#8b949e;margin-bottom:4px}
 .stackbar{display:flex;height:26px;border-radius:5px;overflow:hidden}
 .seg{color:#0b0e14;font-size:11px;display:flex;align-items:center;padding:0 4px;white-space:nowrap;overflow:hidden}
 .hrow{display:flex;align-items:center;gap:8px;margin:3px 0}
 .hlabel{width:70px;text-align:right;font-size:12px;color:#8b949e}
 .hbar{flex:1;height:16px;background:#161b22;border-radius:3px;overflow:hidden}
 .hfill{height:100%;background:linear-gradient(90deg,#1f6feb,#7ee787)}
 .hval{font-size:12px;color:#8b949e;width:110px}
 svg text{font-family:ui-monospace,monospace}
</style></head><body>
<h1>${escapeHtml(title)} — XLN HLT profile report</h1>
<div class="cards">${cards.join('')}</div>
${traceSection()}
<div class="card"><h2>phase breakdown per profile kind</h2>${phaseSection()}</div>
${flamegraphs}
</body></html>`;

const outPath = join(runDir, 'profile-report.html');
writeFileSync(outPath, html);
console.log(`wrote ${outPath} (${(html.length / 1024).toFixed(0)}KB, ${traceRows.length} trace rows, ${events.size} profile kinds)`);
