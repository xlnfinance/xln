#!/usr/bin/env bun

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  BoundedPerfMetric,
  cumulativeMarksToDurations,
  type PerfMarks,
} from '../infra/perf-profile';

type ProfilePayload = Record<string, unknown>;
type ParsedProfile = { runtime: string; scope: string; event: string; payload: ProfilePayload };

const args = process.argv.slice(2);
const logPath = args.find(arg => !arg.startsWith('--'));
const jsonOutput = args.includes('--json');
if (!logPath) throw new Error('USAGE: bun runtime/scripts/analyze-runtime-perf.ts <log-file> [--json]');

const metrics = new Map<string, BoundedPerfMetric>();
const observe = (runtime: string, metric: string, durationMs: number): void => {
  const key = `${runtime}\t${metric}`;
  const accumulator = metrics.get(key) ?? new BoundedPerfMetric();
  accumulator.observe(durationMs);
  metrics.set(key, accumulator);
};

const asNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const asRecord = (value: unknown): ProfilePayload | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as ProfilePayload : undefined;

const parseProfileLine = (line: string): ParsedProfile | undefined => {
  const match = line.match(/^(?:\[([^\]]+):(?:err|out)\]\s+)?\[(?:DEBUG|INFO|WARN|ERROR)\]\[([^\]]+)\]\s+(\S+)\s+(\{.*\})$/);
  if (!match) return undefined;
  try {
    return {
      runtime: match[1] || 'local',
      scope: match[2]!,
      event: match[3]!,
      payload: JSON.parse(match[4]!) as ProfilePayload,
    };
  } catch {
    return undefined;
  }
};

const observePhases = (profile: ParsedProfile, prefix: string, totalMs: number): void => {
  const explicitPhases = asRecord(profile.payload['phases']);
  const marks = asRecord(profile.payload['marks']);
  const legacyMarkOrders: Record<string, string[]> = {
    'runtime:process.profile': [
      'enqueue', 'frameReady', 'mempoolFrame', 'apply', 'fingerprints', 'planOutputs',
      'snapshot', 'save', 'recoveryBackup', 'runtimeInfra', 'profileAnnounce',
      'dispatchOutputs', 'jOutbox', 'strict', 'notify',
    ],
    'runtime:apply.profile': [
      'validateMerge', 'runtimeTxs', 'lineage', 'atomicCrossJPreflight',
      'entityApply', 'reliableIngress', 'finalize',
    ],
    'entity:frame.profile': [
      'clone', 'entityTxLoop', 'cancels', 'orderbook', 'deterministicClone', 'accountProposals',
    ],
    'entity:single_signer.profile': [
      'ingress', 'admission', 'selection', 'frameApply', 'commitments', 'signatures', 'commit',
    ],
    'account:proposal.profile': [
      'clone', 'validateTxs', 'stateRoot', 'frameHash', 'frameValidation',
      'disputeProof', 'signatures', 'finalize',
    ],
  };
  const orderedLabels = legacyMarkOrders[`${profile.scope}:${profile.event}`] ?? [];
  const orderedMarks = Object.fromEntries(
    orderedLabels
      .filter(label => marks?.[label] !== undefined)
      .map(label => [label, Number(marks?.[label])]),
  );
  const phases = explicitPhases ?? (
    marks ? cumulativeMarksToDurations(orderedLabels.length > 0 ? orderedMarks : marks as PerfMarks, totalMs) : undefined
  );
  if (!phases) return;
  for (const [phase, rawDurationMs] of Object.entries(phases)) {
    const durationMs = asNumber(rawDurationMs);
    if (durationMs !== undefined) observe(profile.runtime, `${prefix}.phase.${phase}`, durationMs);
  }
};

const consumeProfile = (profile: ParsedProfile): void => {
  const totalMs = asNumber(profile.payload['elapsedMs'] ?? profile.payload['totalMs']);
  if (profile.scope === 'runtime' && profile.event === 'process.profile' && totalMs !== undefined) {
    observe(profile.runtime, 'runtime.process.total', totalMs);
    observePhases(profile, 'runtime.process', totalMs);
    const storage = asRecord(profile.payload['storageMs']);
    for (const [stage, rawDurationMs] of Object.entries(storage ?? {})) {
      const durationMs = asNumber(rawDurationMs);
      if (durationMs !== undefined) observe(profile.runtime, `runtime.storage.${stage}`, durationMs);
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
      const durationMs = asNumber(rawDurationMs);
      if (durationMs !== undefined) observe(profile.runtime, `runtime.entity_inputs.phase.${phase}`, durationMs);
    }
    for (const rawInput of Array.isArray(profile.payload['slowInputs']) ? profile.payload['slowInputs'] : []) {
      const input = asRecord(rawInput);
      const durationMs = asNumber(input?.['elapsedMs']);
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
      const durationMs = asNumber(txTotal?.['elapsedMs']);
      const count = asNumber(txTotal?.['count']);
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
  }
};

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
} else {
  console.log(`runtime perf: profiles=${parsedProfiles} metrics=${rows.length} log=${logPath}`);
  console.log('runtime  metric                                             count   avg     p50     p95     max     total');
  for (const row of rows) {
    console.log(
      `${String(row.runtime).padEnd(8)} ${String(row.metric).padEnd(50)} ` +
      `${String(row.count).padStart(5)} ${row.avgMs.toFixed(1).padStart(7)} ` +
      `${row.p50Ms.toFixed(0).padStart(7)} ${row.p95Ms.toFixed(0).padStart(7)} ` +
      `${row.maxMs.toFixed(0).padStart(7)} ${row.totalMs.toFixed(0).padStart(9)}`,
    );
  }
}
