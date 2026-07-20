#!/usr/bin/env bun

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { BoundedPerfMetric } from '../infra/perf-profile';
import { parseProfileLine } from './analyze-runtime-perf';

type RawRecord = Record<string, unknown>;

const asRecord = (value: unknown): RawRecord | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as RawRecord : undefined;

const asNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const phaseMs = (payload: RawRecord, name: string): number => {
  const phase = asArray(payload['phases'])
    .map(asRecord)
    .find(candidate => candidate?.['name'] === name);
  return asNumber(phase?.['ms']);
};

const renderTxs = (envelope: RawRecord): string => asArray(envelope['proposalTxs'])
  .map(asRecord)
  .map(tx => {
    const type = String(tx?.['type'] || '?');
    const offerId = String(tx?.['offerId'] || '');
    return `${type}${offerId ? `:${offerId}` : ''}`;
  })
  .join('+') || '-';

const main = async (): Promise<void> => {
  const logPath = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  if (!logPath) {
    throw new Error('USAGE: bun runtime/scripts/analyze-account-causality.ts <log-file>');
  }

  const wall = new BoundedPerfMetric();
  const cpu = new BoundedPerfMetric();
  const lines = createInterface({ input: createReadStream(logPath), crlfDelay: Number.POSITIVE_INFINITY });
  let sequence = 0;
  let causalFrames = 0;
  console.log('seq runtime R      RT       dir E      entity   A          ack    proposal txs');

  for await (const line of lines) {
    const profile = parseProfileLine(line);
    if (profile?.scope !== 'runtime' || profile.event !== 'process.profile') continue;
    const causality = asRecord(profile.payload['accountCausality']);
    if (!causality) continue;
    causalFrames += 1;
    const elapsedMs = asNumber(profile.payload['elapsedMs']);
    const cpuMs = asNumber(asRecord(profile.payload['cpuMs'])?.['total']);
    wall.observe(elapsedMs);
    cpu.observe(cpuMs);
    const common = {
      runtimeHeight: asNumber(profile.payload['heightAfter']),
      runtimeTimestamp: asNumber(profile.payload['timestampAfter']),
      elapsedMs,
      cpuMs,
      applyMs: phaseMs(profile.payload, 'apply'),
      saveMs: phaseMs(profile.payload, 'save'),
      dispatchMs: phaseMs(profile.payload, 'dispatchOutputs'),
    };

    for (const direction of ['ingress', 'egress'] as const) {
      for (const rawInput of asArray(causality[direction])) {
        const input = asRecord(rawInput);
        if (!input) continue;
        const envelopes = asArray(input['accountEnvelopes']).map(asRecord).filter(Boolean) as RawRecord[];
        const rows = envelopes.length > 0 ? envelopes : [undefined];
        for (const envelope of rows) {
          sequence += 1;
          const command = asArray(input['entityTxTypes']).map(String).join('+') || '-';
          console.log(
            `${String(sequence).padStart(3)} ${profile.runtime.padEnd(7)} ` +
            `${String(common.runtimeHeight).padStart(6)} ${String(common.runtimeTimestamp).padStart(8)} ` +
            `${direction.padEnd(7)} ${String(input['entityFrameHeight'] ?? '-').padStart(6)} ` +
            `${String(input['entity'] || '-').padEnd(8)} ` +
            `${String(envelope?.['kind'] || command).padEnd(10)} ` +
            `${String(envelope?.['ackHeight'] ?? '-').padStart(6)} ` +
            `${String(envelope?.['proposalHeight'] ?? '-').padStart(8)} ` +
            `${envelope ? renderTxs(envelope) : asArray(input['entityOfferIds']).map(String).join(',') || '-'}` +
            `  wall=${common.elapsedMs.toFixed(1)} cpu=${common.cpuMs.toFixed(1)}` +
            ` apply=${common.applyMs.toFixed(1)} save=${common.saveMs.toFixed(1)}` +
            ` dispatch=${common.dispatchMs.toFixed(1)}`,
          );
        }
      }
    }
  }

  const wallSummary = wall.summary();
  const cpuSummary = cpu.summary();
  const cpuShare = wallSummary.totalMs > 0 ? cpuSummary.totalMs / wallSummary.totalMs * 100 : 0;
  console.log(
    `account causality: frames=${causalFrames} rows=${sequence} ` +
    `wall_avg=${wallSummary.avgMs.toFixed(1)}ms wall_p95=${wallSummary.p95Ms.toFixed(1)}ms ` +
    `cpu_avg=${cpuSummary.avgMs.toFixed(1)}ms cpu_share=${cpuShare.toFixed(1)}% log=${logPath}`,
  );
};

if (import.meta.main) await main();
