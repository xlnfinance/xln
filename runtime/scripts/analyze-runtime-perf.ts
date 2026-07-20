#!/usr/bin/env bun

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  BoundedPerfMetric,
  cumulativeMarksToDurations,
  type PerfMarks,
} from '../infra/perf-profile';

type ProfilePayload = Record<string, unknown>;
export type ParsedProfile = { runtime: string; scope: string; event: string; payload: ProfilePayload };

const metrics = new Map<string, BoundedPerfMetric>();
const MAX_METRIC_KEYS = 1_024;
const METRIC_LABEL = /^[a-zA-Z0-9_.:-]{1,96}$/;
const observe = (runtime: string, metric: string, durationMs: number): void => {
  if (!METRIC_LABEL.test(runtime) || !METRIC_LABEL.test(metric)) return;
  const key = `${runtime}\t${metric}`;
  if (!metrics.has(key) && metrics.size >= MAX_METRIC_KEYS) return;
  const accumulator = metrics.get(key) ?? new BoundedPerfMetric();
  accumulator.observe(durationMs);
  metrics.set(key, accumulator);
};

export const asDurationMs = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const asRecord = (value: unknown): ProfilePayload | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as ProfilePayload : undefined;

export const parseProfileLine = (line: string): ParsedProfile | undefined => {
  const match = line.match(/^(?:(?:\[([^\]]+)\]\s+)*)\[(?:DEBUG|INFO|WARN|ERROR)\]\[([^\]]+)\]\s+(\S+)\s+(\{.*\})$/);
  if (!match) return undefined;
  try {
    return {
      runtime: String(match[1] || 'local').replace(/:(?:err|out)$/, ''),
      scope: match[2]!,
      event: match[3]!,
      payload: JSON.parse(match[4]!) as ProfilePayload,
    };
  } catch {
    return undefined;
  }
};

const validatedDurations = (
  values: unknown,
  totalMs: number,
): Array<[string, number]> | undefined => {
  const durations: Array<[string, number]> = [];
  if (Array.isArray(values)) {
    for (const rawPhase of values) {
      const phase = asRecord(rawPhase);
      const label = typeof phase?.['name'] === 'string' ? phase['name'] : '';
      const durationMs = asDurationMs(phase?.['ms']);
      if (!METRIC_LABEL.test(label) || durationMs === undefined) return undefined;
      durations.push([label, durationMs]);
    }
  } else {
    const record = asRecord(values);
    if (!record) return undefined;
    for (const [label, rawValue] of Object.entries(record)) {
      const durationMs = asDurationMs(rawValue);
      if (!METRIC_LABEL.test(label) || durationMs === undefined) return undefined;
      durations.push([label, durationMs]);
    }
  }
  const phaseTotal = durations.reduce((sum, [, durationMs]) => sum + durationMs, 0);
  return phaseTotal <= totalMs + Math.max(1, totalMs * 0.01) ? durations : undefined;
};

const observePhases = (profile: ParsedProfile, prefix: string, totalMs: number): void => {
  const explicitPhases = profile.payload['phases'];
  const marks = asRecord(profile.payload['marks']);
  const phases = explicitPhases ?? (marks ? cumulativeMarksToDurations(marks as PerfMarks, totalMs) : undefined);
  if (!phases) return;
  for (const [phase, durationMs] of validatedDurations(phases, totalMs) ?? []) {
    observe(profile.runtime, `${prefix}.phase.${phase}`, durationMs);
  }
};

const consumeProfile = (profile: ParsedProfile): void => {
  const totalMs = asDurationMs(profile.payload['elapsedMs'] ?? profile.payload['totalMs']);
  if (profile.scope === 'runtime' && profile.event === 'process.profile' && totalMs !== undefined) {
    observe(profile.runtime, 'runtime.process.total', totalMs);
    observePhases(profile, 'runtime.process', totalMs);
    const storage = asRecord(profile.payload['storageMs']);
    const cpu = asRecord(profile.payload['cpuMs']);
    for (const [stage, rawDurationMs] of Object.entries(cpu ?? {})) {
      const durationMs = asDurationMs(rawDurationMs);
      if (durationMs !== undefined) observe(profile.runtime, `runtime.cpu.${stage}`, durationMs);
    }
    for (const [stage, rawDurationMs] of Object.entries(storage ?? {})) {
      const durationMs = asDurationMs(rawDurationMs);
      if (durationMs !== undefined) observe(profile.runtime, `runtime.storage.${stage}`, durationMs);
    }
    const prepareMs = asDurationMs(storage?.['prepare']);
    const prepareStages = asRecord(storage?.['prepareStages']);
    if (prepareMs !== undefined && prepareStages) {
      for (const [stage, durationMs] of validatedDurations(prepareStages, prepareMs) ?? []) {
        observe(profile.runtime, `runtime.storage.prepare.phase.${stage}`, durationMs);
      }
    }
    const planningMs = asDurationMs(storage?.['planning']);
    const planningStages = asRecord(storage?.['planningStages']);
    if (planningMs !== undefined && planningStages) {
      for (const [stage, durationMs] of validatedDurations(planningStages, planningMs) ?? []) {
        observe(profile.runtime, `runtime.storage.planning.phase.${stage}`, durationMs);
      }
    }
    return;
  }
  if (profile.scope === 'runtime' && profile.event === 'apply.profile' && totalMs !== undefined) {
    observe(profile.runtime, 'runtime.apply.total', totalMs);
    observePhases(profile, 'runtime.apply', totalMs);
    return;
  }
  if (profile.scope === 'runtime.entity_inputs' && profile.event === 'inputs.profile' && totalMs !== undefined) {
    observe(profile.runtime, 'runtime.entity_inputs.total', totalMs);
    const phaseTotals = asRecord(profile.payload['phaseTotals']);
    for (const [phase, rawDurationMs] of Object.entries(phaseTotals ?? {})) {
      const durationMs = asDurationMs(rawDurationMs);
      if (durationMs !== undefined) observe(profile.runtime, `runtime.entity_inputs.phase.${phase}`, durationMs);
    }
    for (const rawInput of Array.isArray(profile.payload['slowInputs']) ? profile.payload['slowInputs'] : []) {
      const input = asRecord(rawInput);
      const durationMs = asDurationMs(input?.['elapsedMs']);
      if (durationMs === undefined) continue;
      const lane = input?.['immediateCrossJ'] === true ? 'immediate_cross_j' : 'external';
      observe(profile.runtime, `runtime.entity_input.${lane}`, durationMs);
    }
    return;
  }
  if (profile.scope === 'entity' && profile.event === 'frame.profile' && totalMs !== undefined) {
    observe(profile.runtime, 'entity.frame.total', totalMs);
    observePhases(profile, 'entity.frame', totalMs);
    for (const rawTotal of Array.isArray(profile.payload['txTypeTotals']) ? profile.payload['txTypeTotals'] : []) {
      const txTotal = asRecord(rawTotal);
      const type = typeof txTotal?.['type'] === 'string' ? txTotal['type'] : 'unknown';
      const durationMs = asDurationMs(txTotal?.['elapsedMs']);
      const count = asDurationMs(txTotal?.['count']);
      if (durationMs === undefined) continue;
      observe(profile.runtime, `entity.tx.${type}.batch`, durationMs);
      if (count && count > 0) observe(profile.runtime, `entity.tx.${type}.per_tx`, durationMs / count);
    }
    return;
  }
  if (profile.scope === 'entity' && profile.event === 'single_signer.profile' && totalMs !== undefined) {
    observe(profile.runtime, 'entity.single_signer.total', totalMs);
    observePhases(profile, 'entity.single_signer', totalMs);
    return;
  }
  if (profile.scope === 'account' && profile.event === 'proposal.profile' && totalMs !== undefined) {
    observe(profile.runtime, 'account.proposal.total', totalMs);
    observePhases(profile, 'account.proposal', totalMs);
    return;
  }
  if (profile.scope === 'account.handler' && profile.event === 'input.profile' && totalMs !== undefined) {
    observe(profile.runtime, 'account.input.total', totalMs);
    observePhases(profile, 'account.input', totalMs);
  }
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const logPath = args.find(arg => !arg.startsWith('--'));
  const jsonOutput = args.includes('--json');
  if (!logPath) throw new Error('USAGE: bun runtime/scripts/analyze-runtime-perf.ts <log-file> [--json]');
  metrics.clear();
  const lines = createInterface({ input: createReadStream(logPath), crlfDelay: Number.POSITIVE_INFINITY });
  let parsedProfiles = 0;
  for await (const line of lines) {
    const profile = parseProfileLine(line);
    if (!profile) continue;
    parsedProfiles += 1;
    consumeProfile(profile);
  }

  const rows = Array.from(metrics, ([key, metric]) => {
    const [runtime = 'unknown', name = 'unknown'] = key.split('\t');
    return { runtime, metric: name, ...metric.summary() };
  }).sort((left, right) => right.totalMs - left.totalMs || left.metric.localeCompare(right.metric));

  if (jsonOutput) {
    console.log(JSON.stringify({ logPath, parsedProfiles, rows }, null, 2));
    return;
  }
  console.log(`runtime perf: profiles=${parsedProfiles} metrics=${rows.length} log=${logPath}`);
  console.log('runtime  metric                                             count     min     avg     p50     p95     max     total');
  for (const row of rows) {
    console.log(
      `${String(row.runtime).padEnd(8)} ${String(row.metric).padEnd(50)} ` +
      `${String(row.count).padStart(5)} ${row.minMs.toFixed(1).padStart(7)} ${row.avgMs.toFixed(1).padStart(7)} ` +
      `${row.p50Ms.toFixed(1).padStart(7)} ${row.p95Ms.toFixed(1).padStart(7)} ` +
      `${row.maxMs.toFixed(1).padStart(7)} ${row.totalMs.toFixed(1).padStart(9)}`,
    );
  }
};

if (import.meta.main) await main();
