/**
 * Exact operation counters for the runtime hot path.
 *
 * Sampling profilers attribute CPU by stack and lie about nothing, but they
 * cannot say *how many* keccaks, ECDSA recoveries, ABI encodes or clones one
 * economic swap costs, nor how many bytes went through each. These counters
 * turn "~12 900 hashes per swap" from an estimate into a fact, per runtime
 * frame and per process, and catch regressions in CI-grade numbers.
 *
 * Off unless `XLN_RUNTIME_OP_COUNTERS=1`. Every hook is a single branch on a
 * module-level boolean when disabled; consensus state never observes them.
 */
import { nodeProcess } from '../process/runtime-process';

type OpCounter = { calls: number; bytes: number; durationUs: number };
export type OpCounterSnapshot = Record<string, OpCounter>;
type OpEventField = string | number | boolean | null;
type OpEvent = Readonly<{ atUs: number; name: string; fields: Readonly<Record<string, OpEventField>> }>;

export const OP_COUNTERS_ENABLED: boolean = nodeProcess?.env?.['XLN_RUNTIME_OP_COUNTERS'] === '1';
export const BOUNDARY_AUDIT_ENABLED: boolean = nodeProcess?.env?.['XLN_RUNTIME_BOUNDARY_AUDIT'] === '1';
const CALL_SITE_SAMPLING_ENABLED: boolean =
  BOUNDARY_AUDIT_ENABLED || nodeProcess?.env?.['XLN_RUNTIME_OP_CALLSITES'] === '1';

// This module sits on browser-bundled hot paths; Node builtins load only when
// counters are enabled (server), never through a static import.
const builtin = <T>(name: string): T =>
  (nodeProcess as { getBuiltinModule?: (id: string) => unknown } | undefined)?.getBuiltinModule?.(name) as T;
type OpScopes = readonly string[];
type ScopeStorage = { run<T>(scopes: OpScopes, run: () => T): T; getStore(): OpScopes | undefined };

const counters = new Map<string, OpCounter>();
/**
 * Ops attributed to an async task scope. The runtime frame runs inside
 * `runWithOpScope('frame', ...)`, so a phase's op delta can be read for the
 * frame alone even while ingress handlers interleave on the same event loop
 * during the frame's awaits (that interleaving is exactly what makes wall-clock
 * phase timings lie).
 */
const scopeStorage: ScopeStorage | undefined = OP_COUNTERS_ENABLED
  ? new (builtin<{ AsyncLocalStorage: new () => ScopeStorage }>('node:async_hooks').AsyncLocalStorage)()
  : undefined;
const scoped = new Map<string, Map<string, OpCounter>>();

export const runWithOpScopes = <T>(scopes: OpScopes, run: () => T): T => {
  if (!scopeStorage) return run();
  const parent = scopeStorage.getStore() ?? [];
  const merged = [...new Set([...parent, ...scopes])];
  return scopeStorage.run(merged, run);
};

export const runWithOpScope = <T>(scope: string, run: () => T): T =>
  runWithOpScopes([scope], run);
const callSites = new Map<string, Map<string, { samples: number; bytes: number }>>();
const opEvents: OpEvent[] = [];
const OP_EVENT_MAX = 4_096;
const CALL_SITE_SAMPLE_EVERY = 16;
const CALL_SITE_MAX_KEYS = 160;
const callSiteTicks = new Map<string, number>();
type EventLoopUtilization = ReturnType<typeof import('node:perf_hooks').performance.eventLoopUtilization>;
const nodePerformance = OP_COUNTERS_ENABLED
  ? builtin<typeof import('node:perf_hooks')>('node:perf_hooks').performance
  : undefined;
const workerThread = OP_COUNTERS_ENABLED
  ? builtin<typeof import('node:worker_threads')>('node:worker_threads')
  : undefined;
let cpuUsageBaseline: NodeJS.CpuUsage | undefined;
let eventLoopBaseline: EventLoopUtilization | undefined;

const resetProcessBaselines = (): void => {
  cpuUsageBaseline = nodeProcess?.cpuUsage?.();
  eventLoopBaseline = nodePerformance?.eventLoopUtilization();
};

const counterFor = (name: string): OpCounter => {
  let counter = counters.get(name);
  if (!counter) {
    counter = { calls: 0, bytes: 0, durationUs: 0 };
    counters.set(name, counter);
  }
  return counter;
};

/** Increment `name` by one call and `bytes` bytes. No-op when disabled. */
export const countOp = (name: string, bytes = 0, durationUs = 0): void => {
  if (!OP_COUNTERS_ENABLED) return;
  const counter = counterFor(name);
  counter.calls += 1;
  counter.bytes += bytes;
  counter.durationUs += durationUs;
  const activeScopes = scopeStorage?.getStore();
  if (!activeScopes) return;
  for (const scope of activeScopes) {
    let byName = scoped.get(scope);
    if (!byName) {
      byName = new Map();
      scoped.set(scope, byName);
    }
    let scopedCounter = byName.get(name);
    if (!scopedCounter) {
      scopedCounter = { calls: 0, bytes: 0, durationUs: 0 };
      byName.set(name, scopedCounter);
    }
    scopedCounter.calls += 1;
    scopedCounter.bytes += bytes;
    scopedCounter.durationUs += durationUs;
  }
};

/**
 * Like countOp, with caller sampling when `XLN_RUNTIME_OP_CALLSITES=1` or the
 * boundary audit is active. Sampling every 16th call finds the owners of hot
 * operations without imposing stack-capture cost on exact-count-only runs.
 * `skipFrames` drops the wrapper frames above the interesting caller.
 */
export const countOpWithSite = (
  name: string,
  bytes = 0,
  skipFrames = 2,
  durationUs = 0,
): void => {
  if (!OP_COUNTERS_ENABLED) return;
  countOp(name, bytes, durationUs);
  if (!CALL_SITE_SAMPLING_ENABLED) return;
  const tick = (callSiteTicks.get(name) ?? 0) + 1;
  callSiteTicks.set(name, tick);
  // Every operation class must expose at least one caller. Subsequent 1/16
  // sampling keeps hot-path overhead bounded without hiding rare background I/O.
  if (tick !== 1 && tick % CALL_SITE_SAMPLE_EVERY !== 0) return;
  const stack = new Error().stack?.split('\n') ?? [];
  const site = stack
    .slice(1 + skipFrames, 4 + skipFrames)
    .map(line => line.trim().replace(/^at /, '').replace(/^.*\/runtime\//, 'core/'))
    .join(' <- ');
  let sites = callSites.get(name);
  if (!sites) {
    sites = new Map();
    callSites.set(name, sites);
  }
  const existing = sites.get(site);
  if (!existing && sites.size >= CALL_SITE_MAX_KEYS) return;
  if (existing) {
    existing.samples += 1;
    existing.bytes += bytes;
  } else {
    sites.set(site, { samples: 1, bytes });
  }
};

/** Ordered diagnostic events for phase correlation; never observed by Runtime state. */
export const recordOpEvent = (name: string, fields: Readonly<Record<string, OpEventField>>): void => {
  if (!OP_COUNTERS_ENABLED || !BOUNDARY_AUDIT_ENABLED || opEvents.length >= OP_EVENT_MAX) return;
  opEvents.push({
    atUs: Math.round((nodePerformance?.now() ?? 0) * 1_000),
    name,
    fields,
  });
};

/** Cumulative counters; with `scope`, only ops recorded inside that scope. */
export const snapshotOpCounters = (scope?: string): OpCounterSnapshot => {
  const snapshot: OpCounterSnapshot = {};
  const source = scope === undefined ? counters : scoped.get(scope) ?? new Map<string, OpCounter>();
  for (const [name, counter] of source) {
    snapshot[name] = { calls: counter.calls, bytes: counter.bytes, durationUs: counter.durationUs };
  }
  return snapshot;
};

/** Per-op difference `now - previous`, omitting ops that did not move. */
export const diffOpCounters = (previous: OpCounterSnapshot, scope?: string): OpCounterSnapshot => {
  const delta: OpCounterSnapshot = {};
  const source = scope === undefined ? counters : scoped.get(scope) ?? new Map<string, OpCounter>();
  for (const [name, counter] of source) {
    const before = previous[name];
    const calls = counter.calls - (before?.calls ?? 0);
    const bytes = counter.bytes - (before?.bytes ?? 0);
    const durationUs = counter.durationUs - (before?.durationUs ?? 0);
    if (calls !== 0 || bytes !== 0 || durationUs !== 0) delta[name] = { calls, bytes, durationUs };
  }
  return delta;
};

/** Opt-in sampled (1/16) call sites with bytes seen on sampled calls. */
export const snapshotOpCallSites = (): Record<string, Array<{ site: string; samples: number; bytes: number }>> => {
  const out: Record<string, Array<{ site: string; samples: number; bytes: number }>> = {};
  for (const [name, sites] of callSites) {
    out[name] = [...sites.entries()]
      .map(([site, { samples, bytes }]) => ({ site, samples, bytes }))
      .sort((left, right) => right.bytes - left.bytes || right.samples - left.samples)
      .slice(0, 32);
  }
  return out;
};

/** Reset diagnostic counters without touching Runtime state. Used to isolate
 * one HLT load window from bootstrap/setup work in the same long-lived Hub. */
export const resetOpCounters = (): void => {
  if (!OP_COUNTERS_ENABLED) return;
  counters.clear();
  scoped.clear();
  callSites.clear();
  callSiteTicks.clear();
  opEvents.length = 0;
  resetProcessBaselines();
};

let globalHooksInstalled = false;

/**
 * Wrap process-global entry points that many call sites reach without going
 * through a runtime helper: ethers' keccak256 (via its own `register` hook,
 * so every `ethers.keccak256` caller is counted), ethers ABI encode and the
 * global `structuredClone`. The identical WASM keccak backend is production
 * initialization and must not depend on diagnostic counters being enabled.
 * Counter hooks remain idempotent and no-op when disabled.
 */
export const installGlobalOpCounters = async (label = 'runtime'): Promise<void> => {
  const { installFastKeccak, keccak256Bytes } = await import('../../protocol/crypto/fast-keccak');
  await installFastKeccak();
  if (!OP_COUNTERS_ENABLED || globalHooksInstalled) return;
  globalHooksInstalled = true;
  resetProcessBaselines();
  nodeProcess?.on?.('SIGUSR1', resetOpCounters);
  nodeProcess?.on?.('SIGUSR2', () => dumpOpCounters(label, 'sigusr2'));
  nodeProcess?.on?.('exit', () => dumpOpCounters(label, 'exit'));
  const ethers = await import('ethers');
  // The WASM backend registers itself into ethers; wrap whichever backend is
  // active so every ethers.keccak256 caller in the process is counted.
  ethers.keccak256.register((data: Uint8Array) => {
    countOpWithSite('keccak.ethers', data.length, 2);
    return keccak256Bytes(data);
  });
  const abiEncode = ethers.AbiCoder.prototype.encode;
  ethers.AbiCoder.prototype.encode = function (this: InstanceType<typeof ethers.AbiCoder>, types, values) {
    const encoded = abiEncode.call(this, types, values);
    countOp('abi.encode', (encoded.length - 2) / 2);
    return encoded;
  };
  const abiDecode = ethers.AbiCoder.prototype.decode;
  ethers.AbiCoder.prototype.decode = function (this: InstanceType<typeof ethers.AbiCoder>, types, data, loose) {
    countOp('abi.decode', typeof data === 'string' ? (data.length - 2) / 2 : data.length);
    return abiDecode.call(this, types, data, loose);
  };
  const globalClone = globalThis.structuredClone;
  if (typeof globalClone === 'function') {
    globalThis.structuredClone = (<T>(value: T, options?: StructuredSerializeOptions): T => {
      countOpWithSite('structuredClone', 0, 1);
      return globalClone(value, options);
    }) as typeof structuredClone;
  }
  if (BOUNDARY_AUDIT_ENABLED) {
    const { installBoundaryAudit } = await import('./boundary-audit');
    await installBoundaryAudit({ countOp, countOpWithSite });
  }
};

const resolveDumpDirectory = (): string =>
  String(nodeProcess?.env?.['XLN_RUNTIME_OP_COUNTERS_DIR'] || '').trim() || '/tmp/xln-op-counters';

/** Write cumulative counters and sampled call sites for `label`. */
export const dumpOpCounters = (label: string, reason: string): string | null => {
  if (!OP_COUNTERS_ENABLED) return null;
  const directory = resolveDumpDirectory();
  const { mkdirSync, writeFileSync } = builtin<typeof import('node:fs')>('node:fs');
  mkdirSync(directory, { recursive: true });
  const path = `${directory}/${label}.op-counters.json`;
  writeFileSync(
    path,
    JSON.stringify(
      {
        label,
        reason,
        at: new Date().toISOString(),
        execution: {
          processId: nodeProcess?.pid ?? null,
          threadId: workerThread?.threadId ?? null,
          isMainThread: workerThread?.isMainThread ?? null,
          // Bun exposes process-wide cpuUsage inside every Worker. Consumers
          // must deduplicate this field by processId instead of summing shards.
          cpuUsageScope: 'process',
        },
        cpuUsage: nodeProcess?.cpuUsage ? nodeProcess.cpuUsage(cpuUsageBaseline) : null,
        eventLoopUtilization: nodePerformance?.eventLoopUtilization(eventLoopBaseline) ?? null,
        memoryUsage: nodeProcess?.memoryUsage?.() ?? null,
        resourceUsage: nodeProcess?.resourceUsage?.() ?? null,
        counters: snapshotOpCounters(),
        scopes: Object.fromEntries([...scoped.keys()].map(scope => [scope, snapshotOpCounters(scope)])),
        callSites: snapshotOpCallSites(),
        events: opEvents,
      },
      null,
      2,
    ),
  );
  return path;
};
