// Framework-neutral view model for the workspace Runtime I/O panel. Owns the
// Map-or-Record normalization, tolerant bigint display math, frame selection
// from Time Machine history, log filtering, and the reserves/collateral
// conservation projections. The canonical Svelte panel and the future React
// workspace panel both consume this; it renders compact projections only and
// never full RuntimeReplica documents.

import type { EnvSnapshot } from '@xln/core/api/public/runtime-module';
import type { FrameLogEntry, LogCategory, LogLevel } from '@xln/core/types/logging';

export type { FrameLogEntry, LogCategory, LogLevel };

export type RuntimeIoDeltaLike = { collateral?: unknown };
export type RuntimeIoAccountLike = {
  state: { deltas?: ReadonlyMap<unknown, RuntimeIoDeltaLike> | Record<string, RuntimeIoDeltaLike> };
};
export type RuntimeIoEntityStateLike = {
  height?: number;
  lastFinalizedJHeight?: number;
  reserves?: ReadonlyMap<unknown, unknown> | Record<string, unknown>;
  accounts?: ReadonlyMap<string, RuntimeIoAccountLike> | Record<string, RuntimeIoAccountLike>;
  debts?: unknown[];
};
export type RuntimeIoReplicaLike = {
  signerId?: string;
  isProposer?: boolean;
  mempool?: unknown[];
  state?: RuntimeIoEntityStateLike;
};
export type RuntimeIoXlnomyLike = { name: string; jMachine?: { blockNumber?: number; entities?: unknown[] } };

export const RUNTIME_IO_ALL_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];
export const RUNTIME_IO_ALL_CATEGORIES: readonly LogCategory[] = ['consensus', 'account', 'jurisdiction', 'evm', 'network', 'ui', 'system'];

export const RUNTIME_IO_DEFAULT_LEVELS = (): Set<LogLevel> => new Set(['info', 'warn', 'error']);
export const RUNTIME_IO_DEFAULT_CATEGORIES = (): Set<LogCategory> => new Set(RUNTIME_IO_ALL_CATEGORIES);

export const runtimeIoLevelColors: Record<LogLevel, string> = {
  trace: '#6e7681',
  debug: '#8b949e',
  info: '#58a6ff',
  warn: '#d29922',
  error: '#f85149',
};

export const runtimeIoCategoryIcons: Record<LogCategory, string> = {
  consensus: '🔗',
  account: '🤝',
  jurisdiction: '⚖️',
  evm: '⛓️',
  network: '📡',
  ui: '🖥️',
  system: '⚙️',
};

export const isReadonlyMap = <K, V>(
  value: ReadonlyMap<K, V> | Record<string, V>,
): value is ReadonlyMap<K, V> =>
  typeof Reflect.get(value, 'entries') === 'function'
  && typeof Reflect.get(value, 'values') === 'function'
  && typeof Reflect.get(value, 'get') === 'function';

export const mapToArray = <T>(map: ReadonlyMap<unknown, T> | Record<string, T> | undefined): Array<[string, T]> => {
  if (!map) return [];
  if (isReadonlyMap(map)) return Array.from(map.entries()).map(([key, value]) => [String(key), value]);
  if (typeof map === 'object') return Object.entries(map) as Array<[string, T]>;
  return [];
};

export const valuesOf = <T>(source: ReadonlyMap<unknown, T> | Record<string, T> | undefined): T[] => {
  if (!source) return [];
  if (isReadonlyMap(source)) return Array.from(source.values());
  return Object.values(source);
};

export const toBigIntValue = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return 0n;
};

export const getGossipProfiles = (frame: EnvSnapshot): unknown[] => frame.gossip?.profiles ?? [];

export const countEntries = (source: unknown): number => {
  if (!source) return 0;
  if (source instanceof Map) return source.size;
  if (Array.isArray(source)) return source.length;
  if (typeof source === 'object') return Object.keys(source as Record<string, unknown>).length;
  return 0;
};

export const formatBigInt = (val: unknown): string => {
  if (typeof val === 'bigint') return `${val.toString()}n`;
  if (typeof val === 'number') return val.toString();
  return String(val);
};

/** The selected external frame for the Time Machine index: live view has no
 *  resident timeline, and a negative or absent index selects nothing. */
export const selectRuntimeIoFrame = (
  history: readonly EnvSnapshot[] | null | undefined,
  timeIndex: number | null | undefined,
): EnvSnapshot | null => {
  if (timeIndex == null || timeIndex < 0 || !history || history.length === 0) return null;
  return history[Math.min(timeIndex, history.length - 1)] ?? null;
};

export const filterRuntimeIoLogs = (
  logs: readonly FrameLogEntry[],
  activeLevels: ReadonlySet<LogLevel>,
  activeCategories: ReadonlySet<LogCategory>,
  search: string,
): FrameLogEntry[] => {
  const needle = search.trim().toLowerCase();
  return logs.filter(log => {
    if (!activeLevels.has(log.level)) return false;
    if (!activeCategories.has(log.category)) return false;
    if (needle && !log.message.toLowerCase().includes(needle)) return false;
    return true;
  });
};

export const runtimeIoReplicasArray = (
  frame: EnvSnapshot | null,
): Array<[string, RuntimeIoReplicaLike]> =>
  frame?.state.eReplicas ? mapToArray(frame.state.eReplicas) : [];

export const runtimeIoXlnomiesArray = (frame: EnvSnapshot | null): RuntimeIoXlnomyLike[] =>
  (frame?.state.jReplicas ? Array.from(frame.state.jReplicas.values()) : []) as RuntimeIoXlnomyLike[];

/** Conservation-law display projection: sum of every entity reserve. */
export const sumRuntimeIoReserves = (frame: EnvSnapshot | null): bigint =>
  valuesOf<RuntimeIoReplicaLike>(frame?.state.eReplicas).reduce((sum: bigint, replica: RuntimeIoReplicaLike) =>
    sum + valuesOf<unknown>(replica.state?.reserves).reduce((inner: bigint, amount: unknown) => inner + toBigIntValue(amount), 0n), 0n);

/** Conservation-law display projection: sum of every account collateral. */
export const sumRuntimeIoCollateral = (frame: EnvSnapshot | null): bigint =>
  valuesOf<RuntimeIoReplicaLike>(frame?.state.eReplicas).reduce((sum: bigint, replica: RuntimeIoReplicaLike) =>
    sum + valuesOf<RuntimeIoAccountLike>(replica.state?.accounts).reduce((accountSum: bigint, account: RuntimeIoAccountLike) =>
      accountSum + valuesOf<RuntimeIoDeltaLike>(account.state.deltas).reduce(
        (deltaSum: bigint, delta: RuntimeIoDeltaLike) => deltaSum + toBigIntValue(delta.collateral), 0n), 0n), 0n);
