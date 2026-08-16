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
import { deriveDelta, isLeftEntity } from '../../../../account/utils';
import type { AccountReplicaProjection } from '../../../../account/validation/state-validation';
import { RemoteRuntimeAdapter } from '../../../../api/runtime-adapter/remote';
import type { RuntimeAdapterSendResult } from '../../../../api/runtime-adapter/types';
import { canonicalPair } from '../../../../orderbook';
import { safeStringify } from '../../../../protocol/serialization';
import type { RuntimeInput } from '../../../../runtime/types';
import {
  decodeAccountPage,
  decodeEntitySummaries,
  decodeLoadBurstReport,
  decodeLoadFrame,
  type LoadFrame,
  type LoadRuntimeEntry,
} from './worker-boundary';
import { decodeLoadBookPage, type LoadBookSnapshot } from './worker-book-boundary';

export type WorkerArgs = Readonly<{
  workDir: string;
  portBase: number;
  mode: string;
  swaps: number;
  serverPidBeforeRestart?: number;
  serverPidAfterRestart?: number;
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
const PAIR_ID = canonicalPair(2, QUOTE_TOKEN_ID).pairId;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const parsePositiveInteger = (raw: string | undefined, code: string): number => {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${code}:${String(raw)}`);
  return value;
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
    '--work-dir', '--port-base', '--mode', '--swaps',
    '--server-pid-before-restart', '--server-pid-after-restart',
  ]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`PRODUCTION_SWAP_LOAD_ARGUMENT_UNKNOWN:${key}`);
  const workDir = String(values.get('--work-dir') ?? '').trim();
  if (!workDir) throw new Error('PRODUCTION_SWAP_LOAD_WORK_DIR_REQUIRED');
  const swaps = parsePositiveInteger(values.get('--swaps') ?? '1', 'PRODUCTION_SWAP_LOAD_SWAPS_INVALID');
  if (swaps > 1_000) throw new Error('PRODUCTION_SWAP_LOAD_SWAPS_EXCEED_ACCOUNT_FRAME_MAX');
  const beforePid = values.get('--server-pid-before-restart');
  const afterPid = values.get('--server-pid-after-restart');
  if ((beforePid === undefined) !== (afterPid === undefined)) {
    throw new Error('PRODUCTION_SWAP_LOAD_RESTART_PIDS_INCOMPLETE');
  }
  return {
    workDir,
    portBase: parsePositiveInteger(values.get('--port-base'), 'PRODUCTION_SWAP_LOAD_PORT_BASE_INVALID'),
    mode: String(values.get('--mode') ?? 'same').trim(),
    swaps,
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
  decode: (value: unknown) => unknown = decodeLoadBurstReport,
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
  decode(JSON.parse(readFileSync(path, 'utf8')) as unknown);
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

export const sendObserved = async (
  runtime: ConnectedRuntime,
  commandId: string,
  input: RuntimeInput,
): Promise<ObservedCommand> => {
  const commandSequence = runtime.adapter.nextCommandSequence;
  if (commandSequence === null) throw new Error(`PRODUCTION_SWAP_LOAD_COMMAND_FRONTIER_MISSING:${runtime.entry.label}`);
  const deadline = Date.now() + 60_000;
  const startedAt = performance.now();
  let result = await runtime.adapter.send(input, { commandId, commandSequence });
  const enqueueAckElapsedMs = Math.max(0, Math.ceil(performance.now() - startedAt));
  while (result.status !== 'observed' && Date.now() < deadline) {
    await sleep(250);
    result = await runtime.adapter.send(input, { commandId, commandSequence });
  }
  if (result.status !== 'observed') throw new Error(`PRODUCTION_SWAP_LOAD_COMMAND_NOT_OBSERVED:${commandId}`);
  return {
    result,
    enqueueAckElapsedMs,
    commandObservedElapsedMs: Math.max(enqueueAckElapsedMs, Math.ceil(performance.now() - startedAt)),
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

export const readLoadBook = async (
  runtime: ConnectedRuntime,
  hubEntityId: string,
): Promise<LoadBookSnapshot> => decodeLoadBookPage(
  await runtime.adapter.read<unknown>(`entity/${hubEntityId}/books`, { booksLimit: 10 }),
  PAIR_ID,
);

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
): Promise<AccountReplicaProjection | null> => decodeAccountPage(await runtime.adapter.read<unknown>(
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
    await sleep(100);
  }
  throw new Error(`PRODUCTION_SWAP_LOAD_RUNTIME_HEIGHT_NOT_REACHED:${targetHeight}`, { cause: lastError });
};

export const waitForTradeCount = async (
  runtime: ConnectedRuntime,
  hubEntityId: string,
  target: number,
): Promise<LoadBookSnapshot> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const book = await readLoadBook(runtime, hubEntityId);
    if (book.tradeCount === target) return book;
    if (book.tradeCount > target) throw new Error(`PRODUCTION_SWAP_LOAD_UNEXPECTED_CONCURRENT_TRADES:${book.tradeCount}:${target}`);
    await sleep(100);
  }
  throw new Error(`PRODUCTION_SWAP_LOAD_TRADE_NOT_COMMITTED:${target}`);
};
