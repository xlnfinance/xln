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
import { join } from 'node:path';
import { deriveDelta, isLeftEntity } from '../../../account/utils';
import { RuntimeAdapterError } from '../../../api/runtime-adapter/errors';
import { RemoteRuntimeAdapter } from '../../../api/runtime-adapter/remote';
import type { RuntimeAdapterSendResult } from '../../../api/runtime-adapter/types';
import { canonicalPair } from '../../../orderbook';
import { safeParse, safeStringify } from '../../../protocol/serialization';
import {
  buildHltPlan,
  HLT_DEFAULT_BASE_TOKEN_ID,
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
  entry: LoadRuntimeEntry;
  wsUrl: string;
}>;
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
] as const;

/**
 * Build the run plan from population flags, or return null when the caller
 * used the raw lane spelling instead.
 */
const parseHltPlanArgs = (values: ReadonlyMap<string, string>): HltPlan | null => {
  const users = values.get('--users');
  if (users === undefined) {
    const stray = HLT_ECONOMY_FLAGS.filter(flag => flag !== '--users' && values.has(flag));
    if (stray.length > 0) throw new Error(`HLT_ECONOMY_REQUIRES_USERS:${stray.join(',')}`);
    return null;
  }
  return buildHltPlan({
    users: parsePositiveInteger(users, 'HLT_USERS_INVALID'),
    ratePerUserPerSecond: parsePositiveInteger(values.get('--rate-per-user') ?? '1', 'HLT_RATE_PER_USER_INVALID'),
    durationSeconds: parsePositiveInteger(values.get('--duration-s') ?? '60', 'HLT_DURATION_INVALID'),
    mix: parseHltMix(values.get('--mix') ?? '1:0'),
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
  const plan = parseHltPlanArgs(values);
  if (plan) {
    for (const derived of ['--swaps', '--lanes', '--rounds', '--cadence-ms']) {
      if (values.has(derived)) throw new Error(`HLT_ECONOMY_CONFLICTS_WITH_DERIVED_FLAG:${derived}`);
    }
  }
  const swaps = plan
    ? plan.swapLanes
    : parsePositiveInteger(values.get('--swaps') ?? '1', 'PRODUCTION_SWAP_LOAD_SWAPS_INVALID');
  const mode = String(values.get('--mode') ?? 'same').trim();
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
  const isPopulationMode = mode === 'same' || mode === 'payments';
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
  if (!isPopulationMode && (rounds !== 1 || cadenceMs !== 1_000)) {
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

export const directoryBytes = (path: string): number => readdirSync(path, { withFileTypes: true })
  .reduce((total, entry) => {
    const child = join(path, entry.name);
    return total + (entry.isDirectory() ? directoryBytes(child) : statSync(child).size);
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
    adapter.disconnect();
    throw new Error(`PRODUCTION_SWAP_LOAD_RUNTIME_NOT_COMMAND_READY:${entry.label}`);
  }
  return { adapter, entry, wsUrl };
};

const COMMAND_OBSERVATION_TIMEOUT_MS = 120_000;

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
): Promise<ObservedCommand> => {
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
};

export const sendObserved = async (
  runtime: ConnectedRuntime,
  commandId: string,
  input: RuntimeInput,
): Promise<ObservedCommand> => {
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
};

export const findIdentity = async (
  runtime: ConnectedRuntime,
  predicate: (entity: ReturnType<typeof decodeEntitySummaries>[number]) => boolean,
  code: string,
) => {
  const matches = decodeEntitySummaries(await runtime.adapter.read<unknown>('entities')).filter(predicate);
  if (matches.length !== 1 || !matches[0]?.signerId) throw new Error(code);
  return { entityId: matches[0].entityId, signerId: matches[0].signerId };
};

/**
 * A rate-limited read is an observation gap, not a failure: the driver waits
 * out the adapter's own retry hint. Without this a budget cap ends a load run
 * with a driver error instead of measuring the Hub.
 */
const readWithRateLimitRetry = async <T>(
  runtime: ConnectedRuntime,
  path: string,
  query?: Record<string, unknown>,
): Promise<T> => {
  for (;;) {
    try {
      return await runtime.adapter.read<T>(path, query);
    } catch (error) {
      if (!(error instanceof RuntimeAdapterError) || error.code !== 'E_RATE_LIMITED') throw error;
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
    const account = decodeAccountPage(await runtime.adapter.read<unknown>(
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
): Promise<LoadAccountProjection | null> => decodeAccountPage(await runtime.adapter.read<unknown>(
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
