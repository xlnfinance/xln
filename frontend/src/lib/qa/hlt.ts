/** Exact HTTP boundary for GET /api/qa/hlt. */
import type {
  HltHubPerfCard,
  HltLedgerRun,
  HltPaymentCard,
  HltReplayCard,
  HltReplayTrialCard,
  HltSwapCard,
} from '@xln/core/qa/hlt/hlt-dashboard-preview';
import { rejectExtraKeys, requireUnknownRecord } from '$lib/utils/boundary';

export type HltPerfRowView = {
  runtime: string;
  metric: string;
  count: number;
  avgMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  totalMs: number;
};

export type HltRunView = {
  active: boolean;
  status: 'idle' | 'running' | 'green' | 'red' | 'aborted';
  pid: number | null;
  phase: 'build' | 'replay' | null;
  workDir: string | null;
  logPath: string | null;
  recordingPath: string | null;
  reportPath: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  error: string | null;
  logTail: string;
};

export type HltDashboardPayload = {
  snapshotError: string | null;
  ledger: HltLedgerRun[];
  payment: HltPaymentCard | null;
  swap: HltSwapCard | null;
  perf: { parsedProfiles: number; rows: HltPerfRowView[] };
  hubPerf: HltHubPerfCard[];
  replay: HltReplayCard | null;
  run: HltRunView;
};

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const requireNumber = (record: Record<string, unknown>, key: string, code: string): number => {
  const value = record[key];
  if (!isFiniteNumber(value) || value < 0) throw new Error(code);
  return value;
};

const requireString = (record: Record<string, unknown>, key: string, code: string): string => {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(code);
  return value;
};

const decodeLedgerRun = (value: unknown, index: number): HltLedgerRun => {
  const record = requireUnknownRecord(value, `HLT_LEDGER_RUN_INVALID:${index}`);
  const status = record['status'];
  if (status !== 'green' && status !== 'red') throw new Error(`HLT_LEDGER_STATUS_INVALID:${index}`);
  const engine = record['engine'] ?? 'ts';
  if (engine !== 'ts' && engine !== 'rust') throw new Error(`HLT_LEDGER_ENGINE_INVALID:${index}`);
  return {
    at: requireString(record, 'at', `HLT_LEDGER_AT_INVALID:${index}`),
    commit: requireString(record, 'commit', `HLT_LEDGER_COMMIT_INVALID:${index}`),
    headline: requireString(record, 'headline', `HLT_LEDGER_HEADLINE_INVALID:${index}`),
    detail: requireString(record, 'detail', `HLT_LEDGER_DETAIL_INVALID:${index}`),
    users: requireNumber(record, 'users', `HLT_LEDGER_USERS_INVALID:${index}`),
    paymentsTps: requireNumber(record, 'paymentsTps', `HLT_LEDGER_PAY_TPS_INVALID:${index}`),
    swapsTps: requireNumber(record, 'swapsTps', `HLT_LEDGER_SWAP_TPS_INVALID:${index}`),
    status,
    engine,
  };
};

const decodePayment = (value: unknown): HltPaymentCard => {
  const record = requireUnknownRecord(value, 'HLT_PAYMENT_INVALID');
  return {
    deliveredTps: requireNumber(record, 'deliveredTps', 'HLT_PAYMENT_TPS_INVALID'),
    offeredRate: requireNumber(record, 'offeredRate', 'HLT_PAYMENT_OFFERED_INVALID'),
    submittedPayments: requireNumber(record, 'submittedPayments', 'HLT_PAYMENT_SUBMITTED_INVALID'),
    acceptedPayments: requireNumber(record, 'acceptedPayments', 'HLT_PAYMENT_ACCEPTED_INVALID'),
    completedPayments: requireNumber(record, 'completedPayments', 'HLT_PAYMENT_COMPLETED_INVALID'),
    drainedPayments: requireNumber(record, 'drainedPayments', 'HLT_PAYMENT_DRAINED_INVALID'),
    sourceDispatchP95Ms: requireNumber(record, 'sourceDispatchP95Ms', 'HLT_PAYMENT_SOURCE_P95_INVALID'),
    sourceDispatchMaxMs: requireNumber(record, 'sourceDispatchMaxMs', 'HLT_PAYMENT_SOURCE_MAX_INVALID'),
    sourceAckMaxMs: requireNumber(record, 'sourceAckMaxMs', 'HLT_PAYMENT_ACK_MAX_INVALID'),
    deliveredPayments: requireNumber(record, 'deliveredPayments', 'HLT_PAYMENT_DELIVERED_INVALID'),
    elapsedMs: requireNumber(record, 'elapsedMs', 'HLT_PAYMENT_ELAPSED_INVALID'),
    users: requireNumber(record, 'users', 'HLT_PAYMENT_USERS_INVALID'),
    senders: requireNumber(record, 'senders', 'HLT_PAYMENT_SENDERS_INVALID'),
    hubFrames: requireNumber(record, 'hubFrames', 'HLT_PAYMENT_FRAMES_INVALID'),
    paymentsPerFrame: requireNumber(record, 'paymentsPerFrame', 'HLT_PAYMENT_PER_FRAME_INVALID'),
    walDeltaBytes: (() => {
      const wal = record['walDeltaBytes'];
      if (!isFiniteNumber(wal)) throw new Error('HLT_PAYMENT_WAL_INVALID');
      return wal;
    })(),
    heightBefore: requireNumber(record, 'heightBefore', 'HLT_PAYMENT_HEIGHT_BEFORE_INVALID'),
    heightAfter: requireNumber(record, 'heightAfter', 'HLT_PAYMENT_HEIGHT_AFTER_INVALID'),
  };
};

const decodeSwap = (value: unknown): HltSwapCard => {
  const record = requireUnknownRecord(value, 'HLT_SWAP_INVALID');
  return {
    matchedTps: requireNumber(record, 'matchedTps', 'HLT_SWAP_MATCHED_TPS_INVALID'),
    fullySettledTps: requireNumber(record, 'fullySettledTps', 'HLT_SWAP_SETTLED_TPS_INVALID'),
    offeredSwapRate: requireNumber(record, 'offeredSwapRate', 'HLT_SWAP_OFFERED_INVALID'),
    submitted: requireNumber(record, 'submitted', 'HLT_SWAP_SUBMITTED_INVALID'),
    matched: requireNumber(record, 'matched', 'HLT_SWAP_MATCHED_INVALID'),
    sourceDispatchP95Ms: requireNumber(record, 'sourceDispatchP95Ms', 'HLT_SWAP_SOURCE_P95_INVALID'),
    sourceDispatchMaxMs: requireNumber(record, 'sourceDispatchMaxMs', 'HLT_SWAP_SOURCE_MAX_INVALID'),
    sourceAckMaxMs: requireNumber(record, 'sourceAckMaxMs', 'HLT_SWAP_ACK_MAX_INVALID'),
    matchedElapsedMs: requireNumber(record, 'matchedElapsedMs', 'HLT_SWAP_MATCHED_MS_INVALID'),
    fullySettledElapsedMs: requireNumber(record, 'fullySettledElapsedMs', 'HLT_SWAP_SETTLED_MS_INVALID'),
    users: requireNumber(record, 'users', 'HLT_SWAP_USERS_INVALID'),
    hubFrames: requireNumber(record, 'hubFrames', 'HLT_SWAP_FRAMES_INVALID'),
  };
};

const decodePerfRow = (value: unknown, index: number): HltPerfRowView => {
  const record = requireUnknownRecord(value, `HLT_PERF_ROW_INVALID:${index}`);
  return {
    runtime: requireString(record, 'runtime', `HLT_PERF_RUNTIME_INVALID:${index}`),
    metric: requireString(record, 'metric', `HLT_PERF_METRIC_INVALID:${index}`),
    count: requireNumber(record, 'count', `HLT_PERF_COUNT_INVALID:${index}`),
    avgMs: requireNumber(record, 'avgMs', `HLT_PERF_AVG_INVALID:${index}`),
    minMs: requireNumber(record, 'minMs', `HLT_PERF_MIN_INVALID:${index}`),
    p50Ms: requireNumber(record, 'p50Ms', `HLT_PERF_P50_INVALID:${index}`),
    p95Ms: requireNumber(record, 'p95Ms', `HLT_PERF_P95_INVALID:${index}`),
    p99Ms: requireNumber(record, 'p99Ms', `HLT_PERF_P99_INVALID:${index}`),
    maxMs: requireNumber(record, 'maxMs', `HLT_PERF_MAX_INVALID:${index}`),
    totalMs: requireNumber(record, 'totalMs', `HLT_PERF_TOTAL_INVALID:${index}`),
  };
};

const decodeHubPerf = (value: unknown, index: number): HltHubPerfCard => {
  const record = requireUnknownRecord(value, `HLT_HUB_PERF_INVALID:${index}`);
  const cpuTps = record['cpuTps'];
  if (cpuTps !== null && (!isFiniteNumber(cpuTps) || cpuTps < 0)) throw new Error(`HLT_HUB_CPU_TPS_INVALID:${index}`);
  return {
    hubLabel: requireString(record, 'hubLabel', `HLT_HUB_LABEL_INVALID:${index}`),
    processCount: requireNumber(record, 'processCount', `HLT_HUB_PROCESS_COUNT_INVALID:${index}`),
    processAvgMs: requireNumber(record, 'processAvgMs', `HLT_HUB_PROCESS_AVG_INVALID:${index}`),
    processTotalMs: requireNumber(record, 'processTotalMs', `HLT_HUB_PROCESS_TOTAL_INVALID:${index}`),
    cpuTps,
  };
};

const decodeReplayTrial = (value: unknown, index: number): HltReplayTrialCard => {
  const record = requireUnknownRecord(value, `HLT_REPLAY_TRIAL_INVALID:${index}`);
  const offeredTps = record['offeredTps'];
  if (offeredTps !== null && (!isFiniteNumber(offeredTps) || offeredTps < 1)) {
    throw new Error(`HLT_REPLAY_OFFERED_INVALID:${index}`);
  }
  if (record['equivalent'] !== true) throw new Error(`HLT_REPLAY_EQUIVALENCE_INVALID:${index}`);
  return {
    offeredTps,
    frames: requireNumber(record, 'frames', `HLT_REPLAY_FRAMES_INVALID:${index}`),
    accountInputs: requireNumber(record, 'accountInputs', `HLT_REPLAY_INPUTS_INVALID:${index}`),
    accountTxs: requireNumber(record, 'accountTxs', `HLT_REPLAY_TXS_INVALID:${index}`),
    outboxEnvelopes: requireNumber(record, 'outboxEnvelopes', `HLT_REPLAY_OUTBOX_INVALID:${index}`),
    elapsedMs: requireNumber(record, 'elapsedMs', `HLT_REPLAY_ELAPSED_INVALID:${index}`),
    cpuMs: requireNumber(record, 'cpuMs', `HLT_REPLAY_CPU_INVALID:${index}`),
    accountInputTps: requireNumber(record, 'accountInputTps', `HLT_REPLAY_INPUT_TPS_INVALID:${index}`),
    accountTxTps: requireNumber(record, 'accountTxTps', `HLT_REPLAY_TX_TPS_INVALID:${index}`),
    cpuAccountTxTps: requireNumber(record, 'cpuAccountTxTps', `HLT_REPLAY_CPU_TPS_INVALID:${index}`),
    finalHeight: requireNumber(record, 'finalHeight', `HLT_REPLAY_HEIGHT_INVALID:${index}`),
    finalPendingOutbox: requireNumber(record, 'finalPendingOutbox', `HLT_REPLAY_PENDING_INVALID:${index}`),
    equivalent: true,
  };
};

const decodeReplay = (value: unknown): HltReplayCard => {
  const record = requireUnknownRecord(value, 'HLT_REPLAY_INVALID');
  const mode = record['mode'];
  const trials = record['trials'];
  if (mode !== 'max' && mode !== 'fixed' && mode !== 'sweep') throw new Error('HLT_REPLAY_MODE_INVALID');
  if (!Array.isArray(trials) || trials.length < 1) throw new Error('HLT_REPLAY_TRIALS_INVALID');
  return {
    createdAt: requireNumber(record, 'createdAt', 'HLT_REPLAY_CREATED_INVALID'),
    recordingManifestHash: requireString(record, 'recordingManifestHash', 'HLT_REPLAY_MANIFEST_INVALID'),
    mode,
    trials: trials.map(decodeReplayTrial),
  };
};

const requireNullableNumber = (record: Record<string, unknown>, key: string, code: string): number | null => {
  const value = record[key];
  if (value === null) return null;
  if (!isFiniteNumber(value)) throw new Error(code);
  return value;
};

const requireNullableString = (record: Record<string, unknown>, key: string, code: string): string | null => {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(code);
  return value;
};

const decodeRun = (value: unknown): HltRunView => {
  const record = requireUnknownRecord(value, 'HLT_RUN_INVALID');
  rejectExtraKeys(record, [
    'active', 'status', 'pid', 'phase', 'workDir', 'logPath', 'recordingPath', 'reportPath',
    'startedAt', 'finishedAt', 'exitCode', 'error', 'logTail',
  ], 'HLT_RUN_EXTRA_FIELD');
  const status = record['status'];
  if (status !== 'idle' && status !== 'running' && status !== 'green' && status !== 'red' && status !== 'aborted') {
    throw new Error('HLT_RUN_STATUS_INVALID');
  }
  if (typeof record['active'] !== 'boolean') throw new Error('HLT_RUN_ACTIVE_INVALID');
  const phase = record['phase'];
  if (phase !== null && phase !== 'build' && phase !== 'replay') throw new Error('HLT_RUN_PHASE_INVALID');
  return {
    active: record['active'],
    status,
    pid: requireNullableNumber(record, 'pid', 'HLT_RUN_PID_INVALID'),
    phase,
    workDir: requireNullableString(record, 'workDir', 'HLT_RUN_WORKDIR_INVALID'),
    logPath: requireNullableString(record, 'logPath', 'HLT_RUN_LOG_INVALID'),
    recordingPath: requireNullableString(record, 'recordingPath', 'HLT_RUN_RECORDING_INVALID'),
    reportPath: requireNullableString(record, 'reportPath', 'HLT_RUN_REPORT_INVALID'),
    startedAt: requireNullableNumber(record, 'startedAt', 'HLT_RUN_STARTED_INVALID'),
    finishedAt: requireNullableNumber(record, 'finishedAt', 'HLT_RUN_FINISHED_INVALID'),
    exitCode: requireNullableNumber(record, 'exitCode', 'HLT_RUN_EXIT_INVALID'),
    error: requireNullableString(record, 'error', 'HLT_RUN_ERROR_INVALID'),
    logTail: requireString(record, 'logTail', 'HLT_RUN_TAIL_INVALID'),
  };
};

export const decodeHltDashboardPayload = (value: unknown): HltDashboardPayload => {
  const record = requireUnknownRecord(value, 'HLT_DASHBOARD_RESPONSE_INVALID');
  rejectExtraKeys(record, ['ok', 'qaAuth', 'preview', 'snapshotError', 'ledger', 'payment', 'swap', 'perf', 'hubPerf', 'replay', 'run', 'error'], 'HLT_DASHBOARD_RESPONSE_EXTRA_FIELD');
  if (record['ok'] !== true) throw new Error(typeof record['error'] === 'string' ? record['error'] : 'HLT_DASHBOARD_NOT_OK');
  const ledger = record['ledger'];
  const perf = requireUnknownRecord(record['perf'], 'HLT_PERF_INVALID');
  const rows = perf['rows'];
  const hubPerf = record['hubPerf'];
  if (!Array.isArray(ledger)) throw new Error('HLT_LEDGER_INVALID');
  if (!Array.isArray(rows)) throw new Error('HLT_PERF_ROWS_INVALID');
  if (!Array.isArray(hubPerf)) throw new Error('HLT_HUB_PERF_INVALID');
  const payment = record['payment'];
  const swap = record['swap'];
  const snapshotError = record['snapshotError'];
  if (snapshotError !== null && typeof snapshotError !== 'string') {
    throw new Error('HLT_DASHBOARD_SNAPSHOT_ERROR_INVALID');
  }
  return {
    snapshotError,
    ledger: ledger.map(decodeLedgerRun),
    payment: payment === null ? null : decodePayment(payment),
    swap: swap === null ? null : decodeSwap(swap),
    perf: {
      parsedProfiles: requireNumber(perf, 'parsedProfiles', 'HLT_PERF_PARSED_INVALID'),
      rows: rows.map(decodePerfRow),
    },
    hubPerf: hubPerf.map(decodeHubPerf),
    replay: record['replay'] === null ? null : decodeReplay(record['replay']),
    run: record['run'] === undefined ? {
      active: false,
      status: 'idle',
      pid: null,
      phase: null,
      workDir: null,
      logPath: null,
      recordingPath: null,
      reportPath: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
      logTail: '',
    } : decodeRun(record['run']),
  };
};

export const formatTps = (value: number): string => {
  if (value <= 0) return '—';
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)}/s`;
};

export const formatMs = (value: number): string =>
  value >= 1_000 ? `${(value / 1_000).toFixed(1)} s` : `${Math.round(value)} ms`;
