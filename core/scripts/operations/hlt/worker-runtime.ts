/** Exact disk, network and command-observation boundary for a load worker. */

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { deriveDelta, isLeftEntity } from '../../../account/utils';
import { RuntimeAdapterError } from '../../../api/runtime-adapter/errors';
import { RemoteRuntimeAdapter } from '../../../api/runtime-adapter/remote';
import type { RuntimeAdapterSendResult } from '../../../api/runtime-adapter/types';
import { DaemonControlClient } from '../../../orchestrator/daemon-control';
import { canonicalPair } from '../../../orderbook';
import { safeParse, safeStringify } from '../../../protocol/serialization';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../protocol/boundary-validation';
import {
  buildHltPlan,
  HLT_DEFAULT_BASE_TOKEN_ID,
  HLT_DEFAULT_PAYMENT_AMOUNT_RANGE,
  HLT_DEFAULT_QUOTE_TOKEN_ID,
  parseHltLabels,
  parseHltMix,
  type HltPlan,
} from './economy';
import type { RuntimeInput } from '../../../runtime/types';
import {
  decodeAccountPage,
  decodeEntitySummaries,
  decodeLoadSustainedReport,
  decodeLoadFrame,
  type LoadAccountProjection,
  type LoadFrame,
  type LoadRuntimeEntry,
} from './boundary/worker-boundary';
import { decodeLoadBookPage, type LoadBookSnapshot } from './boundary/worker-book-boundary';

export type WorkerArgs = Readonly<{
  workDir: string;
  portBase: number;
  mode: string;
  swaps: number;
  lanes: number;
  rounds: number;
  cadenceMs: number;
  laneOffset: number;
  serverPidBeforeRestart?: number;
  serverPidAfterRestart?: number;
  /** Present when the run was configured as a population rather than raw lanes. */
  plan?: HltPlan;
}>;
export type ConnectedRuntime = Readonly<{
  adapter: RemoteRuntimeAdapter;
  control: DaemonControlClient;
  entry: LoadRuntimeEntry;
  wsUrl: string;
}>;

const opCounterResetUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/api/control/performance/op-counters/reset';
  url.search = '';
  url.hash = '';
  return url.toString();
};

const opCounterSnapshotUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/api/control/performance/op-counters';
  url.search = '';
  url.hash = '';
  return url.toString();
};

const hltBackgroundStopUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  url.pathname = '/api/control/performance/background-io/stop';
  return url.toString();
};

const resetProcessOpCounters = async (rawUrl: string, label: string): Promise<void> => {
  const response = await fetch(opCounterResetUrl(rawUrl), { method: 'POST' });
  const payload = await response.json() as unknown;
  const record = requireBoundaryRecord(payload, `HLT_OP_COUNTER_RESET_RESPONSE_INVALID:${label}`);
  requireExactBoundaryKeys(record, ['ok'], [], `HLT_OP_COUNTER_RESET_RESPONSE_FIELDS_INVALID:${label}`);
  if (!response.ok || record['ok'] !== true) {
    throw new Error(`HLT_OP_COUNTER_RESET_FAILED:${label}:status=${response.status}`);
  }
};

export const hltProcessOpCounterResetTargets = (
  portBase: number,
  runtimes: readonly Readonly<{ wsUrl: string; label: string }>[],
): ReadonlyArray<readonly [url: string, label: string]> => {
  const processes = new Map<string, string>([
    [opCounterResetUrl(`http://127.0.0.1:${portBase + 10}`), 'H1'],
    [opCounterResetUrl(`http://127.0.0.1:${portBase + 11}`), 'H2'],
    [opCounterResetUrl(`http://127.0.0.1:${portBase + 12}`), 'H3'],
  ]);
  for (const runtime of runtimes) processes.set(opCounterResetUrl(runtime.wsUrl), runtime.label);
  return [...processes];
};

export const resetHltProcessOpCounters = async (
  args: Pick<WorkerArgs, 'portBase'>,
  runtimes: readonly ConnectedRuntime[],
): Promise<void> => {
  const processes = hltProcessOpCounterResetTargets(
    args.portBase,
    runtimes.map(runtime => ({ wsUrl: runtime.wsUrl, label: runtime.entry.label })),
  );
  await Promise.all([
    ...processes.map(([url, label]) => resetProcessOpCounters(url, label)),
    resetProcessOpCounters(`http://127.0.0.1:${args.portBase + 4}`, 'orchestrator'),
  ]);
};

export const stopHltHubBackgroundIo = async (
  args: Pick<WorkerArgs, 'portBase'>,
): Promise<void> => {
  await Promise.all([10, 11, 12].map(async offset => {
    const label = `H${offset - 9}`;
    const response = await fetch(hltBackgroundStopUrl(`http://127.0.0.1:${args.portBase + offset}`), {
      method: 'POST',
    });
    const payload = requireBoundaryRecord(
      await response.json() as unknown,
      `HLT_BACKGROUND_STOP_RESPONSE_INVALID:${label}`,
    );
    requireExactBoundaryKeys(payload, ['ok'], [], `HLT_BACKGROUND_STOP_RESPONSE_FIELDS_INVALID:${label}`);
    if (!response.ok || payload['ok'] !== true) {
      throw new Error(`HLT_BACKGROUND_STOP_FAILED:${label}:status=${response.status}`);
    }
  }));
};

export type HltOpCounter = Readonly<{ calls: number; bytes: number; durationUs: number }>;

export const decodeHltOpCounterSnapshot = (payload: unknown, label: string): Map<string, HltOpCounter> => {
  const record = requireBoundaryRecord(payload, `HLT_OP_COUNTER_SNAPSHOT_INVALID:${label}`);
  requireExactBoundaryKeys(record, ['counters'], [], `HLT_OP_COUNTER_SNAPSHOT_FIELDS_INVALID:${label}`);
  const counters = requireBoundaryRecord(record['counters'], `HLT_OP_COUNTERS_INVALID:${label}`);
  const decoded = new Map<string, HltOpCounter>();
  for (const [name, rawCounter] of Object.entries(counters)) {
    const counter = requireBoundaryRecord(rawCounter, `HLT_OP_COUNTER_INVALID:${label}:${name}`);
    requireExactBoundaryKeys(counter, ['calls', 'bytes', 'durationUs'], [], `HLT_OP_COUNTER_FIELDS_INVALID:${label}:${name}`);
    const values = ['calls', 'bytes', 'durationUs'].map(key => Number(counter[key]));
    if (values.some(value => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`HLT_OP_COUNTER_VALUE_INVALID:${label}:${name}:${safeStringify(counter)}`);
    }
    decoded.set(name, { calls: values[0]!, bytes: values[1]!, durationUs: values[2]! });
  }
  return decoded;
};

export const decodeHltOpCounterReport = (payload: unknown): unknown => {
  const report = requireBoundaryRecord(payload, 'HLT_OP_COUNTER_REPORT_INVALID');
  requireExactBoundaryKeys(report, ['schema', 'runId', 'hubs'], [], 'HLT_OP_COUNTER_REPORT_FIELDS_INVALID');
  if (report['schema'] !== 'xln-hlt-op-counters-v1') throw new Error('HLT_OP_COUNTER_REPORT_SCHEMA_INVALID');
  if (typeof report['runId'] !== 'string' || report['runId'].length === 0) {
    throw new Error('HLT_OP_COUNTER_REPORT_RUN_ID_INVALID');
  }
  const hubs = requireBoundaryRecord(report['hubs'], 'HLT_OP_COUNTER_REPORT_HUBS_INVALID');
  requireExactBoundaryKeys(hubs, ['H1', 'H2', 'H3'], [], 'HLT_OP_COUNTER_REPORT_HUB_FIELDS_INVALID');
  for (const label of ['H1', 'H2', 'H3']) {
    decodeHltOpCounterSnapshot({ counters: hubs[label] }, label);
  }
  return report;
};

const readProcessOpCounters = async (rawUrl: string, label: string): Promise<Map<string, HltOpCounter>> => {
  const response = await fetch(opCounterSnapshotUrl(rawUrl));
  const payload = await response.json() as unknown;
  if (!response.ok) throw new Error(`HLT_OP_COUNTER_SNAPSHOT_FAILED:${label}:status=${response.status}`);
  return decodeHltOpCounterSnapshot(payload, label);
};

export const assertSocketCounterCoverage = (
  counters: ReadonlyMap<string, HltOpCounter>,
  label: string,
): void => {
  const raw = counters.get('boundary.socket.send');
  if (!raw) return;
  const explicit = [...counters]
    .filter(([name, counter]) => /^socket\..+\.out\./.test(name) && counter.bytes > 0)
    .reduce((sum, [, counter]) => ({ calls: sum.calls + counter.calls, bytes: sum.bytes + counter.bytes }), {
      calls: 0,
      bytes: 0,
    });
  if (raw.calls !== explicit.calls || raw.bytes !== explicit.bytes) {
    throw new Error(`HLT_SOCKET_COUNTER_COVERAGE:${label}:raw=${safeStringify(raw)}:explicit=${safeStringify(explicit)}`);
  }
};

export const summarizeHltIoCounters = (
  counters: ReadonlyMap<string, HltOpCounter>,
): Readonly<Record<string, HltOpCounter>> => Object.fromEntries(
  [...counters]
    .filter(([name, counter]) => counter.calls > 0 && [
      'socket.',
      'boundary.socket.',
      'boundary.http.',
      'boundary.level.',
    ].some(prefix => name.startsWith(prefix)))
    .sort(([left], [right]) => left.localeCompare(right)),
);

/** Payments isolate H1. Any H2/H3 network, HTTP or LevelDB work after the
 * synchronized reset is unexplained background load and invalidates TPS. */
export const findForbiddenHltHubIo = (
  calls: ReadonlyMap<string, number>,
): ReadonlyArray<readonly [name: string, calls: number]> => {
  const forbiddenPrefixes = ['socket.', 'boundary.socket.', 'boundary.http.', 'boundary.level.'];
  return [...calls]
    .filter(([name, count]) => count > 0 && forbiddenPrefixes.some(prefix => name.startsWith(prefix)))
    .sort(([left], [right]) => left.localeCompare(right));
};

/**
 * @param loadHubLabels hubs the workload actually drives. A hub carrying load
 * is held only to "no boundary HTTP"; every other hub must be fully idle, which
 * is what proves the measured work happened where the report says it did.
 */
export const assertHltHubProcessIsolation = async (
  args: Pick<WorkerArgs, 'portBase' | 'workDir'>,
  loadHubLabels: readonly string[] = ['H1'],
): Promise<Readonly<Record<string, Readonly<Record<string, HltOpCounter>>>>> => {
  const carriesLoad = new Set(loadHubLabels.map(label => label.toUpperCase()));
  const ioByHub: Record<string, Readonly<Record<string, HltOpCounter>>> = {};
  const countersByHub: Record<string, Readonly<Record<string, HltOpCounter>>> = {};
  for (const [offset, label] of [[10, 'H1'], [11, 'H2'], [12, 'H3']] as const) {
    const counters = await readProcessOpCounters(`http://127.0.0.1:${args.portBase + offset}`, label);
    assertSocketCounterCoverage(counters, label);
    ioByHub[label] = summarizeHltIoCounters(counters);
    countersByHub[label] = Object.fromEntries(counters);
    const calls = new Map([...counters].map(([name, counter]) => [name, counter.calls]));
    if (carriesLoad.has(label)) {
      const http = [...calls].filter(([name, count]) => count > 0 && name.startsWith('boundary.http.'));
      if (http.length > 0) {
        throw new Error(`HLT_PAYMENT_BACKGROUND_IO:${label}:${safeStringify(Object.fromEntries(http))}`);
      }
      continue;
    }
    const active = findForbiddenHltHubIo(calls);
    if (active.length > 0) {
      throw new Error(`HLT_PAYMENT_BACKGROUND_IO:${label}:${safeStringify(Object.fromEntries(active))}`);
    }
  }
  persistReport(join(args.workDir, 'hlt-op-counters-report.json'), {
    schema: 'xln-hlt-op-counters-v1',
    runId: basename(args.workDir),
    hubs: countersByHub,
  }, decodeHltOpCounterReport);
  return ioByHub;
};
export type ObservedCommand = Readonly<{
  result: RuntimeAdapterSendResult;
  enqueueAckElapsedMs: number;
  commandObservedElapsedMs: number;
}>;

const QUOTE_TOKEN_ID = 1;
export const PRODUCTION_SWAP_LOAD_PAIR_ID = canonicalPair(2, QUOTE_TOKEN_ID).pairId;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const parsePositiveInteger = (raw: string | undefined, code: string): number => {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${code}:${String(raw)}`);
  return value;
};

export const HLT_ECONOMY_FLAGS = [
  '--users', '--rate-per-user', '--duration-s', '--mix',
  '--base-token', '--quote-token', '--hubs', '--market-makers',
  '--payment-amount-min', '--payment-amount-max',
] as const;

const parsePositiveBigint = (raw: string | undefined, defaultValue: bigint, code: string): bigint => {
  if (raw === undefined) return defaultValue;
  try {
    const value = BigInt(raw);
    if (value <= 0n) throw new Error('non-positive');
    return value;
  } catch {
    throw new Error(`${code}:${raw}`);
  }
};

/**
 * Build the run plan from population flags, or return null when the caller
 * used the raw lane spelling instead.
 */
const defaultMixForMode = (mode: string): string =>
  mode === 'payments' ? '0:1' : mode === 'mixed' ? '1:1' : '1:0';

const parseHltPlanArgs = (values: ReadonlyMap<string, string>, mode: string): HltPlan | null => {
  const users = values.get('--users');
  if (users === undefined) {
    const stray = HLT_ECONOMY_FLAGS.filter(flag => flag !== '--users' && values.has(flag));
    if (stray.length > 0) throw new Error(`HLT_ECONOMY_REQUIRES_USERS:${stray.join(',')}`);
    return null;
  }
  const paymentAmountMin = parsePositiveBigint(
    values.get('--payment-amount-min'),
    HLT_DEFAULT_PAYMENT_AMOUNT_RANGE.min,
    'HLT_PAYMENT_AMOUNT_MIN_INVALID',
  );
  const paymentAmountMax = parsePositiveBigint(
    values.get('--payment-amount-max'),
    HLT_DEFAULT_PAYMENT_AMOUNT_RANGE.max,
    'HLT_PAYMENT_AMOUNT_MAX_INVALID',
  );
  return buildHltPlan({
    users: parsePositiveInteger(users, 'HLT_USERS_INVALID'),
    ratePerUserPerSecond: parsePositiveInteger(values.get('--rate-per-user') ?? '1', 'HLT_RATE_PER_USER_INVALID'),
    // Ten seconds is the primary sustained HLT gate. The 60-second soak is an
    // explicit follow-up, so profiling iterations never inherit soak duration.
    durationSeconds: parsePositiveInteger(values.get('--duration-s') ?? '10', 'HLT_DURATION_INVALID'),
    mix: parseHltMix(values.get('--mix') ?? defaultMixForMode(mode)),
    baseTokenId: parsePositiveInteger(
      values.get('--base-token') ?? String(HLT_DEFAULT_BASE_TOKEN_ID),
      'HLT_BASE_TOKEN_INVALID',
    ),
    quoteTokenId: parsePositiveInteger(
      values.get('--quote-token') ?? String(HLT_DEFAULT_QUOTE_TOKEN_ID),
      'HLT_QUOTE_TOKEN_INVALID',
    ),
    hubLabels: parseHltLabels(values.get('--hubs') ?? 'H1', 'HLT_HUB_LABELS_INVALID'),
    marketMakerLabels: parseHltLabels(values.get('--market-makers') ?? 'MM', 'HLT_MM_LABELS_INVALID'),
    paymentAmountRange: { min: paymentAmountMin, max: paymentAmountMax },
  });
};

export const parseWorkerArgs = (argv: readonly string[]): WorkerArgs => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('PRODUCTION_SWAP_LOAD_ARGUMENTS_INVALID');
    if (values.has(key)) throw new Error(`PRODUCTION_SWAP_LOAD_ARGUMENT_DUPLICATE:${key}`);
    values.set(key, value);
  }
  const allowed = new Set([
    '--work-dir', '--port-base', '--mode', '--swaps', '--lanes', '--rounds', '--cadence-ms', '--lane-offset',
    '--server-pid-before-restart', '--server-pid-after-restart',
    ...HLT_ECONOMY_FLAGS,
  ]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`PRODUCTION_SWAP_LOAD_ARGUMENT_UNKNOWN:${key}`);
  const workDir = String(values.get('--work-dir') ?? '').trim();
  if (!workDir) throw new Error('PRODUCTION_SWAP_LOAD_WORK_DIR_REQUIRED');
  // An economy describes the population; lanes, rounds and cadence follow from
  // it. Mixing the two spellings would let a run report a population it never
  // spawned, so the derived flags are rejected rather than overridden.
  const mode = String(values.get('--mode') ?? 'same').trim();
  const plan = parseHltPlanArgs(values, mode);
  if (plan) {
    for (const derived of ['--swaps', '--lanes', '--rounds', '--cadence-ms']) {
      if (values.has(derived)) throw new Error(`HLT_ECONOMY_CONFLICTS_WITH_DERIVED_FLAG:${derived}`);
    }
  }
  const swaps = plan
    ? plan.swapLanes
    : parsePositiveInteger(values.get('--swaps') ?? '1', 'PRODUCTION_SWAP_LOAD_SWAPS_INVALID');
  const lanes = plan
    ? (mode === 'payments' ? plan.paymentLanes : plan.swapLanes)
    : parsePositiveInteger(values.get('--lanes') ?? '1', 'PRODUCTION_SWAP_LOAD_LANES_INVALID');
  const rounds = plan
    ? plan.rounds
    : parsePositiveInteger(values.get('--rounds') ?? '1', 'PRODUCTION_SWAP_LOAD_ROUNDS_INVALID');
  const cadenceMs = plan
    ? plan.cadenceMs
    : parsePositiveInteger(values.get('--cadence-ms') ?? '1000', 'PRODUCTION_SWAP_LOAD_CADENCE_INVALID');
  const laneOffsetRaw = values.get('--lane-offset') ?? '0';
  const laneOffset = Number(laneOffsetRaw);
  if (!Number.isSafeInteger(laneOffset) || laneOffset < 0) {
    throw new Error(`PRODUCTION_SWAP_LOAD_LANE_OFFSET_INVALID:${laneOffsetRaw}`);
  }
  // `same` and `payments` describe a population that acts every round; the
  // cross-j workloads prove one atomic swap and have no population at all.
  const isPopulationMode = mode === 'same' || mode === 'payments' || mode === 'mixed';
  if (mode === 'mixed') {
    if (!plan || plan.economy.mix.swap === 0 || plan.economy.mix.payment === 0) {
      throw new Error('HLT_MIXED_REQUIRES_BOTH_WORKLOADS');
    }
  }
  if (mode === 'same' && swaps < lanes) {
    throw new Error('PRODUCTION_SWAP_LOAD_LANES_WITHOUT_ORDERS');
  }
  if (mode === 'same' && swaps > lanes * 5) {
    throw new Error('PRODUCTION_SWAP_LOAD_SWAPS_EXCEED_FIVE_PER_ACCOUNT_FRAME');
  }
  if (mode === 'same' && swaps !== lanes) {
    throw new Error('PRODUCTION_SWAP_LOAD_SUSTAINED_REQUIRES_ONE_SWAP_PER_LANE');
  }
  // A `--mix` that gives this mode no users would otherwise spawn a run with
  // an empty population and report a rate over zero participants.
  if (isPopulationMode && lanes < 1) throw new Error(`HLT_MODE_POPULATION_EMPTY:${mode}`);
  if (!isPopulationMode && lanes !== 1) throw new Error('PRODUCTION_SWAP_LOAD_NON_SAME_LANES_UNSUPPORTED');
  // Cross volleys repeat the burst against fresh MM quotes; other non-population
  // modes still prove exactly one settlement, so extra rounds stay rejected.
  if (!isPopulationMode && mode !== 'cross' && rounds !== 1) {
    throw new Error('PRODUCTION_SWAP_LOAD_NON_SAME_CADENCE_UNSUPPORTED');
  }
  if (!isPopulationMode && cadenceMs !== 1_000) {
    throw new Error('PRODUCTION_SWAP_LOAD_NON_SAME_CADENCE_UNSUPPORTED');
  }
  const beforePid = values.get('--server-pid-before-restart');
  const afterPid = values.get('--server-pid-after-restart');
  if ((beforePid === undefined) !== (afterPid === undefined)) {
    throw new Error('PRODUCTION_SWAP_LOAD_RESTART_PIDS_INCOMPLETE');
  }
  return {
    workDir,
    portBase: parsePositiveInteger(values.get('--port-base'), 'PRODUCTION_SWAP_LOAD_PORT_BASE_INVALID'),
    mode,
    swaps,
    lanes,
    rounds,
    cadenceMs,
    laneOffset,
    ...(plan ? { plan } : {}),
    ...(beforePid === undefined ? {} : {
      serverPidBeforeRestart: parsePositiveInteger(beforePid, 'PRODUCTION_SWAP_LOAD_RESTART_PID_BEFORE_INVALID'),
      serverPidAfterRestart: parsePositiveInteger(afterPid, 'PRODUCTION_SWAP_LOAD_RESTART_PID_AFTER_INVALID'),
    }),
  };
};

// LevelDB compacts while we measure: a file listed by readdir can be gone by
// stat. Missing entries count as zero instead of failing the whole load run.
const fileBytesOrZero = (path: string): number => {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
};

export const directoryBytes = (path: string): number => readdirSync(path, { withFileTypes: true })
  .reduce((total, entry) => {
    const child = join(path, entry.name);
    return total + (entry.isDirectory() ? directoryBytes(child) : fileBytesOrZero(child));
  }, 0);

export const resolveWalPath = (runtimeDir: string): string => {
  const matches = readdirSync(runtimeDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.endsWith('-wal'));
  if (matches.length !== 1) throw new Error('PRODUCTION_SWAP_LOAD_WAL_PATH_NOT_UNIQUE');
  return join(runtimeDir, matches[0]!.name);
};

export const persistReport = (
  path: string,
  value: unknown,
  decode: (value: unknown) => unknown = decodeLoadSustainedReport,
): void => {
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
  decode(safeParse(readFileSync(path, 'utf8')));
};

export const entryByLabel = (entries: readonly LoadRuntimeEntry[], label: string): LoadRuntimeEntry => {
  const matches = entries.filter(entry => entry.label === label);
  if (matches.length !== 1) throw new Error(`PRODUCTION_SWAP_LOAD_RUNTIME_ENTRY_NOT_UNIQUE:${label}`);
  return matches[0]!;
};

export const connectRuntime = async (
  entry: LoadRuntimeEntry,
  wsUrl = entry.wsUrl,
): Promise<ConnectedRuntime> => {
  const adapter = new RemoteRuntimeAdapter();
  await adapter.connect({ mode: 'remote', wsUrl, authKey: entry.token, requestTimeoutMs: 30_000 });
  if (!adapter.commandReady || adapter.nextCommandSequence === null) {
    const reason = adapter.commandReadyReason ?? (
      adapter.nextCommandSequence === null ? 'command-frontier-missing' : 'unknown'
    );
    adapter.disconnect();
    throw new Error(
      `PRODUCTION_SWAP_LOAD_RUNTIME_NOT_COMMAND_READY:${entry.label}:reason=${reason}`,
    );
  }
  const url = new URL(wsUrl);
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.username || url.password || url.search || url.hash) {
    adapter.disconnect();
    throw new Error('PRODUCTION_SWAP_LOAD_CONTROL_URL_INVALID');
  }
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '';
  const baseUrl = url.toString().replace(/\/$/, '');
  return {
    adapter,
    control: new DaemonControlClient({ baseUrl, authKey: entry.token, timeoutMs: 30_000 }),
    entry,
    wsUrl,
  };
};

export const disconnectRuntimeControl = (runtime: ConnectedRuntime): void => {
  runtime.adapter.disconnect();
};

export const reconnectRuntimeControl = async (runtime: ConnectedRuntime): Promise<void> => {
  if (runtime.adapter.status === 'connected') return;
  await runtime.adapter.connect({
    mode: 'remote',
    wsUrl: runtime.wsUrl,
    authKey: runtime.entry.token,
    requestTimeoutMs: 30_000,
  });
  if (!runtime.adapter.commandReady || runtime.adapter.nextCommandSequence === null) {
    const reason = runtime.adapter.commandReadyReason ?? (
      runtime.adapter.nextCommandSequence === null ? 'command-frontier-missing' : 'unknown'
    );
    runtime.adapter.disconnect();
    throw new Error(
      `PRODUCTION_SWAP_LOAD_RUNTIME_NOT_COMMAND_READY:${runtime.entry.label}:reason=${reason}`,
    );
  }
};

export const exportReplayBaseSnapshotIfConfigured = async (
  runtime: ConnectedRuntime,
): Promise<void> => {
  if (!String(process.env['XLN_RUNTIME_SNAPSHOT_EXPORT_PATH'] || '').trim()) return;
  const snapshot = await runtime.control.exportRuntimeSnapshot();
  if (snapshot.runtimeId !== runtime.adapter.runtimeId.toLowerCase()) {
    throw new Error(
      `HLT_REPLAY_SNAPSHOT_RUNTIME_MISMATCH:adapter=${runtime.adapter.runtimeId}:snapshot=${snapshot.runtimeId}`,
    );
  }
  console.log(
    `HLT_REPLAY_BASE_SNAPSHOT runtime=${snapshot.runtimeId} ` +
    `height=${snapshot.height} checkpoint=${snapshot.checkpointHash}`,
  );
};

const COMMAND_OBSERVATION_TIMEOUT_MS = 120_000;

// RuntimeAdapter's owner command frontier is strictly contiguous. Concurrent
// callers may share one authenticated adapter, but two commands must never
// read the same next sequence before either becomes durable. HLT workload
// traffic bypasses this control lane through the per-host batch ingress; this
// lock only serializes setup/operator commands for one Runtime.
const adapterCommandTails = new Map<RemoteRuntimeAdapter, Promise<void>>();

const withExclusiveAdapterCommand = async <T>(
  runtime: ConnectedRuntime,
  effect: () => Promise<T>,
): Promise<T> => {
  const previous = adapterCommandTails.get(runtime.adapter) ?? Promise.resolve();
  let release = (): void => {};
  const turn = new Promise<void>(resolve => { release = resolve; });
  adapterCommandTails.set(runtime.adapter, turn);
  await previous;
  try {
    return await effect();
  } finally {
    release();
    if (adapterCommandTails.get(runtime.adapter) === turn) {
      adapterCommandTails.delete(runtime.adapter);
    }
  }
};

const awaitObservedRuntimeCommand = async (
  runtime: ConnectedRuntime,
  commandId: string,
  commandSequence: number,
  input: RuntimeInput,
  startedAt: number,
): Promise<Readonly<{ result: RuntimeAdapterSendResult; enqueueAckElapsedMs: number }>> => {
  const deadline = Date.now() + COMMAND_OBSERVATION_TIMEOUT_MS;
  let enqueueAckElapsedMs: number | null = null;
  while (Date.now() < deadline) {
    try {
      const result = await runtime.adapter.send(input, { commandId, commandSequence });
      enqueueAckElapsedMs ??= Math.max(0, Math.ceil(performance.now() - startedAt));
      if (result.status === 'observed') return { result, enqueueAckElapsedMs };
    } catch (error) {
      if (!(error instanceof RuntimeAdapterError) || !error.retryable) throw error;
    }
    // The durable command marker makes this exact retry idempotent even when
    // the original response arrived after the client's 30-second timeout.
    await sleep(10);
  }
  throw new Error(`PRODUCTION_SWAP_LOAD_COMMAND_NOT_OBSERVED:${commandId}`);
};

export const sendEnqueued = async (
  runtime: ConnectedRuntime,
  commandId: string,
  input: RuntimeInput,
): Promise<ObservedCommand> => withExclusiveAdapterCommand(runtime, async () => {
  const commandSequence = runtime.adapter.nextCommandSequence;
  if (commandSequence === null) throw new Error(`PRODUCTION_SWAP_LOAD_COMMAND_FRONTIER_MISSING:${runtime.entry.label}`);
  const startedAt = performance.now();
  const deadline = Date.now() + COMMAND_OBSERVATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const result = await runtime.adapter.send(input, { commandId, commandSequence });
      const enqueueAckElapsedMs = Math.max(0, Math.ceil(performance.now() - startedAt));
      if (result.status === 'pending' || result.status === 'observed') {
        return { result, enqueueAckElapsedMs, commandObservedElapsedMs: enqueueAckElapsedMs };
      }
    } catch (error) {
      if (!(error instanceof RuntimeAdapterError) || !error.retryable) throw error;
    }
    await sleep(10);
  }
  throw new Error(`PRODUCTION_SWAP_LOAD_COMMAND_NOT_ENQUEUED:${commandId}`);
});

export const sendObserved = async (
  runtime: ConnectedRuntime,
  commandId: string,
  input: RuntimeInput,
): Promise<ObservedCommand> => withExclusiveAdapterCommand(runtime, async () => {
  const commandSequence = runtime.adapter.nextCommandSequence;
  if (commandSequence === null) throw new Error(`PRODUCTION_SWAP_LOAD_COMMAND_FRONTIER_MISSING:${runtime.entry.label}`);
  const startedAt = performance.now();
  const observed = await awaitObservedRuntimeCommand(
    runtime, commandId, commandSequence, input, startedAt,
  );
  return {
    result: observed.result,
    enqueueAckElapsedMs: observed.enqueueAckElapsedMs,
    commandObservedElapsedMs: Math.max(
      observed.enqueueAckElapsedMs,
      Math.ceil(performance.now() - startedAt),
    ),
  };
});

export const findIdentity = async (
  runtime: ConnectedRuntime,
  predicate: (entity: ReturnType<typeof decodeEntitySummaries>[number]) => boolean,
  code: string,
) => {
  const matches = decodeEntitySummaries(await readWithRateLimitRetry<unknown>(runtime, 'entities')).filter(predicate);
  if (matches.length !== 1 || !matches[0]?.signerId) throw new Error(code);
  return { entityId: matches[0].entityId, signerId: matches[0].signerId };
};

export type ReadableRuntime = Readonly<{
  adapter: { read: <T>(path: string, query?: Record<string, unknown>) => Promise<T> };
}>;

const READ_RETRY_DEADLINE_MS = 120_000;

/**
 * RemoteRuntimeAdapter.request() only checks the socket's readyState, not
 * whether authenticateIfNeeded() (called after every openSocket(), including
 * from scheduleReconnect()) has actually finished its own round-trip — so a
 * read racing a fresh reconnect can reach the server before its auth level is
 * re-established there and come back `E_UNAUTHORIZED: <level> auth required`
 * (server.ts:454) with retryable:false, even though the credentials are
 * fine and the very next attempt succeeds once auth catches up. A REAL
 * credential failure never reaches here: authenticateIfNeeded() throwing
 * inside connect()/scheduleReconnect() sets terminalAuthFailure and tears the
 * socket down first, so a live open socket rejecting a read with this exact
 * message is always the reconnect race, not a permission error — safe to
 * retry the same as the transient disconnect case below.
 */
const isTransientAuthRace = (error: RuntimeAdapterError): boolean =>
  error.code === 'E_UNAUTHORIZED' && error.message.endsWith('auth required');

/**
 * A rate-limited read is an observation gap, not a failure: the driver waits
 * out the adapter's own retry hint. A retryable adapter error (socket closed
 * or replaced mid-request — RemoteRuntimeAdapter.handleClose/openSocket fail
 * every in-flight call on disconnect) is the same kind of gap: the adapter
 * reconnects on its own schedule, so the caller only needs to wait it out
 * instead of crashing the whole worker on the first transient hiccup. Without
 * this a budget cap ends a load run with a driver error instead of measuring
 * the Hub.
 */
export const readWithRateLimitRetry = async <T>(
  runtime: ReadableRuntime,
  path: string,
  query?: Record<string, unknown>,
): Promise<T> => {
  const deadline = Date.now() + READ_RETRY_DEADLINE_MS;
  for (;;) {
    try {
      return await runtime.adapter.read<T>(path, query);
    } catch (error) {
      if (!(error instanceof RuntimeAdapterError) || !(error.retryable || isTransientAuthRace(error))) throw error;
      if (Date.now() >= deadline) throw error;
      await sleep(Math.max(20, error.retryAfterMs ?? 100));
    }
  }
};

export const readLoadBook = async (
  runtime: ConnectedRuntime,
  hubEntityId: string,
): Promise<LoadBookSnapshot> => decodeLoadBookPage(
  await readWithRateLimitRetry<unknown>(runtime, `entity/${hubEntityId}/books`, { booksLimit: 10 }),
  PRODUCTION_SWAP_LOAD_PAIR_ID,
);

/**
 * Wait until `counterpartyEntityId` can pay `minimum` into this Account, read
 * from `ownerEntityId`'s own replica. Both replicas of a bilateral Account
 * commit the same frame, so the owner's copy is exact evidence about its
 * counterparty — and reading it there keeps a four-figure population from
 * spending the Hub's client budget on the harness's own provisioning polls.
 */
export const waitForCounterpartyCredit = async (
  runtime: ConnectedRuntime,
  ownerEntityId: string,
  counterpartyEntityId: string,
  tokenId: number,
  minimum: bigint,
): Promise<void> => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const account = decodeAccountPage(await readWithRateLimitRetry<unknown>(
      runtime,
      `entity/${ownerEntityId}/accounts`,
      { accountId: counterpartyEntityId, accountsLimit: 1 },
    ));
    const delta = account?.state.deltas.get(tokenId);
    if (delta && deriveDelta(delta, isLeftEntity(counterpartyEntityId, ownerEntityId)).outCapacity >= minimum) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`PRODUCTION_SWAP_LOAD_COUNTERPARTY_CREDIT_NOT_ACKNOWLEDGED:${counterpartyEntityId}`);
};

export const waitForCredit = async (
  runtime: ConnectedRuntime,
  entityId: string,
  hubEntityId: string,
  tokenId: number,
  minimum: bigint,
): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const account = decodeAccountPage(await readWithRateLimitRetry<unknown>(
      runtime,
      `entity/${entityId}/accounts`,
      { accountId: hubEntityId, accountsLimit: 1 },
    ));
    const delta = account?.state.deltas.get(tokenId);
    if (account && delta && deriveDelta(delta, isLeftEntity(entityId, hubEntityId)).outCapacity >= minimum) return;
    await sleep(250);
  }
  throw new Error('PRODUCTION_SWAP_LOAD_CREDIT_NOT_ACKNOWLEDGED');
};

export const readLoadAccount = async (
  runtime: ConnectedRuntime,
  entityId: string,
  hubEntityId: string,
): Promise<LoadAccountProjection | null> => decodeAccountPage(await readWithRateLimitRetry<unknown>(
  runtime,
  `entity/${entityId}/accounts`,
  { accountId: hubEntityId, accountsLimit: 1 },
));

export const waitForRuntimeHeight = async (
  runtime: ConnectedRuntime,
  targetHeight: number,
): Promise<LoadFrame> => {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const frame = decodeLoadFrame(await runtime.adapter.read<unknown>('frame/latest'));
      if (frame.height >= targetHeight) return frame;
    } catch (error) {
      lastError = error;
    }
    // Completion authority is committed book state; a coarse poll would turn
    // observation delay into a fake TPS ceiling.
    await sleep(10);
  }
  throw new Error(`PRODUCTION_SWAP_LOAD_RUNTIME_HEIGHT_NOT_REACHED:${targetHeight}`, { cause: lastError });
};

export const waitForTradeCount = async (
  runtime: ConnectedRuntime,
  hubEntityId: string,
  target: number,
): Promise<LoadBookSnapshot> => {
  // Saturation runs offer orders faster than the Hub settles them; the drain
  // after submission is the measurement, so give it a generous bound.
  const deadline = Date.now() + Number(process.env['XLN_LOAD_TRADE_DRAIN_TIMEOUT_MS'] || 60_000);
  let lastTradeCount = -1;
  while (Date.now() < deadline) {
    const book = await readLoadBook(runtime, hubEntityId);
    if (book.tradeCount !== lastTradeCount) {
      lastTradeCount = book.tradeCount;
      console.log(
        `[load] trades ${book.tradeCount}/${target} ` +
        `visibleBids=${book.visibleBidOrders} visibleAsks=${book.visibleAskOrders} ` +
        `bids=${book.bestBidPriceTicks ?? 'none'} asks=${book.executableAskPriceTicks.length}`,
      );
    }
    if (book.tradeCount === target) return book;
    if (book.tradeCount > target) throw new Error(`PRODUCTION_SWAP_LOAD_UNEXPECTED_CONCURRENT_TRADES:${book.tradeCount}:${target}`);
    // 100 ms bounds driver latency to <1% of a multi-second measurement while
    // keeping the poll itself from loading the Hub under test.
    await sleep(100);
  }
  throw new Error(`PRODUCTION_SWAP_LOAD_TRADE_NOT_COMMITTED:${target}:reached=${lastTradeCount}`);
};
