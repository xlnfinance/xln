import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

/**
 * Machine-wide local test stack leases.
 *
 * Every full local stack occupies one 20-port lane. The kernel-held guard is
 * the cross-process authority; callers inspect only the data offsets they will
 * actually bind and never signal an existing listener.
 */
export const LOCAL_TEST_PORT_POOL_VERSION = 'local-test-stack-v1';
export const LOCAL_TEST_STACK_BASES = Object.freeze([
  20_000,
  20_020,
  20_040,
  20_060,
  20_080,
  20_100,
  20_120,
] as const);
const LOCAL_TEST_STACK_GUARD_OFFSET = 19;
const HLT_LANE_BLOCK_PORTS = 4_096;
const HLT_LANE_BLOCK_COUNT = 10;
const HLT_LANE_GUARD_FLOOR = 19_980;
export const HLT_LANE_PORT_FLOOR = 21_000;
const LOCAL_TEST_ASSERT_ONLY_MODE = 'assert-only-v1';
export const LOCAL_TEST_LEASE_ENV_NAMES = Object.freeze([
  'XLN_LOCAL_TEST_LEASE_MODE',
  'XLN_LOCAL_TEST_LEASE_POOL',
  'XLN_LOCAL_TEST_LEASE_BASE',
  'XLN_LOCAL_TEST_LEASE_GUARD',
  'XLN_LOCAL_TEST_LEASE_OWNER_PID',
  'XLN_LOCAL_TEST_LEASE_REPO_ROOT',
] as const);
const LOCAL_TEST_STACK_OFFSETS = Object.freeze([
  0, 1, 2, 4, 7, 8, 10, 11, 12, 13, 14, 15,
] as const);

export type LocalTestPortLease = Readonly<{
  slot: number;
  basePort: number;
  guardPort: number;
  ports: readonly number[];
  release: () => void;
}>;

export type LocalHltLaneLease = Readonly<{
  basePort: number;
  portCount: number;
  release: () => void;
}>;

export const buildInheritedLocalTestLeaseEnv = (
  lease: LocalTestPortLease,
  repoRoot: string,
): Record<(typeof LOCAL_TEST_LEASE_ENV_NAMES)[number], string> => ({
  XLN_LOCAL_TEST_LEASE_MODE: LOCAL_TEST_ASSERT_ONLY_MODE,
  XLN_LOCAL_TEST_LEASE_POOL: LOCAL_TEST_PORT_POOL_VERSION,
  XLN_LOCAL_TEST_LEASE_BASE: String(lease.basePort),
  XLN_LOCAL_TEST_LEASE_GUARD: String(lease.guardPort),
  XLN_LOCAL_TEST_LEASE_OWNER_PID: String(process.pid),
  XLN_LOCAL_TEST_LEASE_REPO_ROOT: realpathSync(repoRoot),
});

export const stripLocalTestLeaseEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const scrubbed = { ...env };
  for (const name of LOCAL_TEST_LEASE_ENV_NAMES) delete scrubbed[name];
  return scrubbed;
};

const AMBIENT_LOCAL_STACK_ENV_NAMES = Object.freeze([
  'ANVIL_LOG',
  'ANVIL_PORT',
  'ANVIL_RPC',
  'ANVIL_RPC2',
  'ANVIL_STATE',
  'ANVIL_TMPDIR',
  'ANVIL2_LOG',
  'ANVIL2_PORT',
  'ANVIL2_STATE',
  'API_PORT',
  'CUSTODY_DAEMON_PORT',
  'CUSTODY_PORT',
  'DEV_DATA_ROOT',
  'DEV_LOG_DIR',
  'DEV_RUNTIME_BUNDLE_PATH',
  'DEV_STARTED_AT_MS',
  'PORT',
  'PUBLIC_RELAY_URL',
  'PUBLIC_RPC',
  'PUBLIC_WS_BASE_URL',
  'RELAY_URL',
  'RPC_PORT',
  'RPC_TRON',
  'WATCHTOWER_PORT',
  'WEB_HTTP_PORT',
  'WEB_PORT',
  'XLN_DB_PATH',
  'XLN_JDB_ROOT',
  'XLN_JURISDICTIONS_PATH',
  'XLN_MESH_DB_ROOT',
  'XLN_PORT_BASE',
  'XLN_RDB_ROOT',
  'XLN_SERVER_PORT',
  'XLN_STORAGE_HISTORY_PATH',
] as const);

/**
 * A local stand receives its ports and durable roots from its acquired lease
 * and owned work directory. Ambient dev/testnet endpoints must not be allowed
 * to override those explicit values in a child shell.
 */
export const stripAmbientLocalStackEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const scrubbed = stripLocalTestLeaseEnv(env);
  for (const name of AMBIENT_LOCAL_STACK_ENV_NAMES) delete scrubbed[name];
  for (const name of Object.keys(scrubbed)) {
    if (name.startsWith('XLN_DEV_')) delete scrubbed[name];
  }
  return scrubbed;
};

export const parseLocalTestListeningPortOutput = (output: string): Map<number, number[]> => {
  const pidsByPort = new Map<number, Set<number>>();
  let currentPid: number | null = null;
  for (const field of output.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    if (field.startsWith('p')) {
      const pid = Number(field.slice(1));
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`LOCAL_TEST_LSOF_OUTPUT_INVALID:${field.slice(0, 200)}`);
      }
      currentPid = pid;
      continue;
    }
    if (!field.startsWith('n')) continue;
    const portMatch = field.match(/:(\d+)$/);
    if (currentPid === null || !portMatch) {
      throw new Error(`LOCAL_TEST_LSOF_OUTPUT_INVALID:${field.slice(0, 200)}`);
    }
    const port = Number(portMatch[1]);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`LOCAL_TEST_LSOF_OUTPUT_INVALID:${field.slice(0, 200)}`);
    }
    const pids = pidsByPort.get(port) ?? new Set<number>();
    pids.add(currentPid);
    pidsByPort.set(port, pids);
  }
  return new Map(Array.from(pidsByPort.entries())
    .sort(([left], [right]) => left - right)
    .map(([port, pids]) => [port, Array.from(pids).sort((left, right) => left - right)]));
};

export const readLocalTestListeningPortPids = (ports: readonly number[]): Map<number, number[]> => {
  const normalizedPorts = Array.from(new Set(ports))
    .filter(port => Number.isSafeInteger(port) && port > 0 && port <= 65_535)
    .sort((left, right) => left - right);
  if (normalizedPorts.length === 0) return new Map();
  const result = spawnSync('lsof', [
    '-nP',
    '-a',
    '-sTCP:LISTEN',
    '-FnP',
    ...normalizedPorts.map(port => `-iTCP:${port}`),
  ], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    timeout: 5_000,
    killSignal: 'SIGKILL',
  });
  const output = String(result.stdout || '').trim();
  // `lsof` exits 1 whenever *any* `-i` selector matched nothing, even when the
  // other selectors produced rows. A partially occupied lane is the normal case
  // here, so exit 1 is a valid result and its stdout must still be parsed.
  // Only a spawn failure, a timeout, or a status outside {0,1} is a scan error.
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(
      `LOCAL_TEST_PORT_SCAN_FAILED:ports=${normalizedPorts.length}:status=${String(result.status)}:` +
      `${result.error?.message || 'unknown'}`,
    );
  }
  if (!output) return new Map();
  const requested = new Set(normalizedPorts);
  return new Map(Array.from(parseLocalTestListeningPortOutput(output).entries())
    .filter(([port]) => requested.has(port)));
};

export const assertLocalTestPortsFree = (ports: readonly number[]): void => {
  const listeners = readLocalTestListeningPortPids(ports);
  if (listeners.size === 0) return;
  const detail = Array.from(listeners.entries()).map(([port, pids]) => `${port}:${pids.join(',')}`).join(';');
  throw new Error(`LOCAL_TEST_PORT_BUSY:${detail}`);
};

const readListeningPortsInRange = (first: number, last: number): Map<number, number[]> => {
  const result = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-FnP'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    timeout: 5_000,
    killSignal: 'SIGKILL',
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`HLT_LANE_PORT_SCAN_FAILED:${result.error?.message || String(result.status)}`);
  }
  return new Map(Array.from(parseLocalTestListeningPortOutput(String(result.stdout || '')).entries())
    .filter(([port]) => port >= first && port <= last));
};

const stopHltGuards = (guards: Bun.Server<unknown>[]): void => {
  for (const guard of guards) guard.stop(true);
};

const tryAcquireHltLaneBlock = (
  startBlock: number,
  blocks: number,
): LocalHltLaneLease | null => {
  const guards: Bun.Server<unknown>[] = [];
  try {
    for (let block = startBlock; block < startBlock + blocks; block += 1) {
      guards.push(Bun.serve({
        hostname: '127.0.0.1',
        port: HLT_LANE_GUARD_FLOOR + block,
        fetch: () => Response.json({ service: 'xln-hlt-lane-lease', block, pid: process.pid }),
      }));
    }
  } catch (cause) {
    stopHltGuards(guards);
    if ((cause as NodeJS.ErrnoException).code === 'EADDRINUSE') return null;
    throw new Error(`HLT_LANE_GUARD_FAILED:${startBlock}`, { cause });
  }
  const basePort = HLT_LANE_PORT_FLOOR + startBlock * HLT_LANE_BLOCK_PORTS;
  const portCount = blocks * HLT_LANE_BLOCK_PORTS;
  if (readListeningPortsInRange(basePort, basePort + portCount - 1).size > 0) {
    stopHltGuards(guards);
    return null;
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off('exit', release);
    stopHltGuards(guards);
  };
  process.once('exit', release);
  return { basePort, portCount, release };
};

export const acquireLocalHltLaneLease = async (
  portCount: number,
  timeoutMs = 25_000,
): Promise<LocalHltLaneLease> => {
  if (
    !Number.isSafeInteger(portCount) ||
    portCount < HLT_LANE_BLOCK_PORTS ||
    portCount > 32_768 ||
    portCount % HLT_LANE_BLOCK_PORTS !== 0
  ) throw new Error(`HLT_LANE_LEASE_SIZE_INVALID:${portCount}`);
  const blocks = portCount / HLT_LANE_BLOCK_PORTS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    for (let start = 0; start + blocks <= HLT_LANE_BLOCK_COUNT; start += 1) {
      const lease = tryAcquireHltLaneBlock(start, blocks);
      if (lease) return lease;
    }
    if (Date.now() >= deadline) throw new Error(`HLT_LANE_LEASE_EXHAUSTED:${portCount}`);
    await Bun.sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
};

const normalizeOffsets = (offsets: readonly number[]): number[] => {
  const normalized = Array.from(new Set(offsets)).sort((left, right) => left - right);
  if (
    normalized.length === 0 ||
    normalized.some(offset => !Number.isSafeInteger(offset) || offset < 0 || offset >= LOCAL_TEST_STACK_GUARD_OFFSET)
  ) {
    throw new Error(`LOCAL_TEST_PORT_OFFSETS_INVALID:${offsets.join(',')}`);
  }
  return normalized;
};

export const acquireLocalTestPortLease = async (options: {
  requiredOffsets?: readonly number[];
  timeoutMs?: number;
  signal?: AbortSignal;
  slotBases?: readonly number[];
} = {}): Promise<LocalTestPortLease> => {
  const offsets = normalizeOffsets(options.requiredOffsets ?? LOCAL_TEST_STACK_OFFSETS);
  const slotBases = options.slotBases ?? LOCAL_TEST_STACK_BASES;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error(`LOCAL_TEST_PORT_LEASE_TIMEOUT_INVALID:${String(timeoutMs)}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (options.signal?.aborted) throw new Error('LOCAL_TEST_PORT_LEASE_ABORTED');
    for (const [slot, basePort] of slotBases.entries()) {
      const guardPort = basePort + LOCAL_TEST_STACK_GUARD_OFFSET;
      let guard: Bun.Server<unknown>;
      try {
        guard = Bun.serve({
          hostname: '127.0.0.1',
          port: guardPort,
          fetch: () => Response.json({
            ok: true,
            service: LOCAL_TEST_PORT_POOL_VERSION,
            slot,
            basePort,
            pid: process.pid,
          }),
        });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
        throw new Error(`LOCAL_TEST_PORT_GUARD_FAILED:${guardPort}`, { cause });
      }
      const ports = offsets.map(offset => basePort + offset);
      const busy = readLocalTestListeningPortPids(ports);
      if (busy.size > 0) {
        guard.stop(true);
        continue;
      }
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        process.off('exit', release);
        guard.stop(true);
      };
      process.once('exit', release);
      return { slot, basePort, guardPort, ports, release };
    }
    if (Date.now() >= deadline) {
      throw new Error(`LOCAL_TEST_PORT_SLOTS_EXHAUSTED:${slotBases.join(',')}`);
    }
    await Bun.sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
};
