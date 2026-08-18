/**
 * HLT dashboard disk snapshot: progress ledger, latest workload reports,
 * and parsed hub perf rows. Writes never touch the live 8082 mesh.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { requireBoundaryInteger, requireBoundaryRecord } from '../../protocol/boundary-validation';
import { safeParse, safeStringify } from '../../protocol/serialization';
import { decodeLoadSustainedReport } from '../../scripts/operations/hlt/boundary/worker-boundary';
import { decodeLoadPaymentReport } from '../../scripts/operations/hlt/boundary/worker-payment-boundary';
import {
  summarizeRuntimePerfLines,
  type RuntimePerfRow,
  type RuntimePerfSummary,
} from '../../scripts/operations/benchmark/analyze-runtime-perf';
import type {
  HltHubPerfCard,
  HltLedgerRun,
  HltPaymentCard,
  HltSwapCard,
} from './hlt-dashboard-preview';

const MAX_PERF_LOG_BYTES = 8_000_000;
const MAX_PERF_ROWS = 24;

const hltDashboardDir = (root = process.cwd()): string =>
  resolve(root, '.logs', 'qa', 'hlt');

const ledgerPath = (root: string): string => resolve(root, 'hlt-runs.json');

const writeJsonAtomic = (path: string, value: unknown): void => {
  const encoded = `${safeStringify(value, 2)}\n`;
  const temporary = `${path}.tmp-${process.pid}`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(descriptor, encoded);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
};

const readJsonFile = (path: string): unknown => {
  if (!existsSync(path)) return null;
  return safeParse(readFileSync(path, 'utf8'));
};

const decodeLedgerRun = (value: unknown, index: number): HltLedgerRun => {
  const record = requireBoundaryRecord(value, `HLT_LEDGER_RUN_INVALID:${index}`);
  const status = record['status'];
  if (status !== 'green' && status !== 'red') throw new Error(`HLT_LEDGER_STATUS_INVALID:${index}`);
  const headline = record['headline'];
  const detail = record['detail'];
  const commit = record['commit'];
  const at = record['at'];
  if (typeof headline !== 'string' || typeof detail !== 'string') throw new Error(`HLT_LEDGER_TEXT_INVALID:${index}`);
  if (typeof commit !== 'string' || typeof at !== 'string') throw new Error(`HLT_LEDGER_META_INVALID:${index}`);
  const paymentsTps = record['paymentsTps'];
  const swapsTps = record['swapsTps'];
  if (typeof paymentsTps !== 'number' || !Number.isFinite(paymentsTps) || paymentsTps < 0) {
    throw new Error(`HLT_LEDGER_PAY_TPS_INVALID:${index}`);
  }
  if (typeof swapsTps !== 'number' || !Number.isFinite(swapsTps) || swapsTps < 0) {
    throw new Error(`HLT_LEDGER_SWAP_TPS_INVALID:${index}`);
  }
  return {
    at,
    commit,
    headline,
    detail,
    users: requireBoundaryInteger(record['users'], `HLT_LEDGER_USERS_INVALID:${index}`, 0),
    paymentsTps,
    swapsTps,
    status,
  };
};

const readHltProgressLedger = (root = process.cwd()): HltLedgerRun[] => {
  const parsed = readJsonFile(ledgerPath(root));
  if (parsed === null) return [];
  const record = requireBoundaryRecord(parsed, 'HLT_LEDGER_INVALID');
  if (record['schema'] !== 'xln-hlt-progress-v1') throw new Error(`HLT_LEDGER_SCHEMA_INVALID:${String(record['schema'])}`);
  const runs = record['runs'];
  if (!Array.isArray(runs)) throw new Error('HLT_LEDGER_RUNS_INVALID');
  return runs.map(decodeLedgerRun);
};

export const paymentCardFromReport = (value: unknown): HltPaymentCard => {
  const report = decodeLoadPaymentReport(value);
  const hubFrames = report.hubDurableAfter.height - report.hubDurableBefore.height;
  if (hubFrames < 0) throw new Error('HLT_PAYMENT_HUB_HEIGHT_REGRESSED');
  return {
    deliveredTps: report.deliveredTps,
    offeredRate: report.offeredPaymentRate,
    deliveredPayments: report.deliveredPayments,
    elapsedMs: report.deliveredElapsedMs,
    users: report.configuredUsers,
    senders: report.senders,
    hubFrames,
    paymentsPerFrame: hubFrames === 0 ? report.deliveredPayments : report.deliveredPayments / hubFrames,
    walDeltaBytes: report.walBytesAfter - report.walBytesBefore,
    heightBefore: report.hubDurableBefore.height,
    heightAfter: report.hubDurableAfter.height,
  };
};

const swapCardFromReport = (value: unknown): HltSwapCard => {
  const report = decodeLoadSustainedReport(value);
  const hubFrames = report.durableAfter.height - report.durableBefore.height;
  if (hubFrames < 0) throw new Error('HLT_SWAP_HUB_HEIGHT_REGRESSED');
  return {
    matchedTps: report.matchedTps,
    fullySettledTps: report.fullySettledTps,
    offeredSwapRate: report.offeredEconomicSwapRate,
    submitted: report.submittedEconomicSwaps,
    matched: report.matchedEconomicSwaps,
    fullySettled: report.fullySettledEconomicSwaps,
    matchedElapsedMs: report.matchedElapsedMs,
    fullySettledElapsedMs: report.fullySettledElapsedMs,
    users: report.configuredUsers,
    hubFrames,
  };
};

const decodePerfRow = (value: unknown, index: number): RuntimePerfRow => {
  const record = requireBoundaryRecord(value, `HLT_PERF_ROW_INVALID:${index}`);
  const runtime = record['runtime'];
  const metric = record['metric'];
  if (typeof runtime !== 'string' || typeof metric !== 'string') throw new Error(`HLT_PERF_ROW_LABEL_INVALID:${index}`);
  const numberField = (key: string): number => {
    const raw = record[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) throw new Error(`HLT_PERF_ROW_${key.toUpperCase()}_INVALID:${index}`);
    return raw;
  };
  return {
    runtime,
    metric,
    count: requireBoundaryInteger(record['count'], `HLT_PERF_ROW_COUNT_INVALID:${index}`, 0),
    avgMs: numberField('avgMs'),
    minMs: numberField('minMs'),
    p50Ms: numberField('p50Ms'),
    p95Ms: numberField('p95Ms'),
    p99Ms: numberField('p99Ms'),
    maxMs: numberField('maxMs'),
    totalMs: numberField('totalMs'),
  };
};

const decodeHltPerfSummary = (value: unknown): RuntimePerfSummary => {
  const record = requireBoundaryRecord(value, 'HLT_PERF_INVALID');
  const rows = record['rows'];
  if (!Array.isArray(rows)) throw new Error('HLT_PERF_ROWS_INVALID');
  return {
    parsedProfiles: requireBoundaryInteger(record['parsedProfiles'], 'HLT_PERF_PARSED_INVALID', 0),
    rows: rows.map(decodePerfRow),
  };
};

const hubPerfFromRows = (
  rows: readonly RuntimePerfRow[],
  deliveredPayments: number | null,
): HltHubPerfCard[] => {
  const cards: HltHubPerfCard[] = [];
  for (const row of rows) {
    if (!/^H[0-9]+$/.test(row.runtime) || row.metric !== 'runtime.process.total') continue;
    cards.push({
      hubLabel: row.runtime,
      processCount: row.count,
      processAvgMs: row.avgMs,
      processTotalMs: row.totalMs,
      cpuTps: deliveredPayments !== null && row.totalMs > 0
        ? deliveredPayments * 1_000 / row.totalMs
        : null,
    });
  }
  return cards;
};

const readLogTailLines = (path: string): string[] => {
  const size = statSync(path).size;
  if (size === 0) return [];
  const start = Math.max(0, size - MAX_PERF_LOG_BYTES);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(path, 'r');
  try {
    readSync(descriptor, buffer, 0, length, start);
  } finally {
    closeSync(descriptor);
  }
  const lines = buffer.toString('utf8').split('\n');
  if (start > 0) lines.shift();
  return lines;
};

export const publishHltDashboardReport = (
  kind: 'payment' | 'swap' | 'cross',
  value: unknown,
  root = process.cwd(),
): void => {
  const directory = hltDashboardDir(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeJsonAtomic(join(directory, `latest-${kind}.json`), value);
};

export const publishHltDashboardPerfFromWorkDir = (workDir: string, root = process.cwd()): void => {
  const logPath = join(workDir, 'server.log');
  if (!existsSync(logPath)) return;
  const summary = summarizeRuntimePerfLines(readLogTailLines(logPath));
  const directory = hltDashboardDir(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeJsonAtomic(join(directory, 'latest-perf.json'), {
    parsedProfiles: summary.parsedProfiles,
    rows: summary.rows.slice(0, MAX_PERF_ROWS),
  });
};

type HltDashboardSnapshot = Readonly<{
  ledger: readonly HltLedgerRun[];
  payment: HltPaymentCard | null;
  swap: HltSwapCard | null;
  perf: RuntimePerfSummary;
  hubPerf: readonly HltHubPerfCard[];
}>;

export const readHltDashboardSnapshot = (root = process.cwd()): HltDashboardSnapshot => {
  const directory = hltDashboardDir(root);
  const paymentRaw = readJsonFile(join(directory, 'latest-payment.json'));
  const swapRaw = readJsonFile(join(directory, 'latest-swap.json'));
  const perfRaw = readJsonFile(join(directory, 'latest-perf.json'));
  const payment = paymentRaw === null ? null : paymentCardFromReport(paymentRaw);
  const swap = swapRaw === null ? null : swapCardFromReport(swapRaw);
  const perf = perfRaw === null
    ? { parsedProfiles: 0, rows: [] }
    : decodeHltPerfSummary(perfRaw);
  return {
    ledger: readHltProgressLedger(root),
    payment,
    swap,
    perf,
    hubPerf: hubPerfFromRows(perf.rows, payment?.deliveredPayments ?? null),
  };
};
