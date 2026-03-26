import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type StorageKind = 'db' | 'log' | 'temp';

type TrackedStoragePath = {
  name: string;
  kind: StorageKind;
  path: string;
};

type StorageHistoryEntry = {
  ts: number;
  freeBytes: number;
  tracked: Record<string, number>;
};

export type StorageTrackedHealth = {
  name: string;
  kind: StorageKind;
  path: string;
  currentBytes: number;
  deltaBytes1h: number;
  bytesPerHour: number;
  sampleWindowMs: number;
};

export type StorageHealth = {
  ok: boolean;
  minFreeBytes: number;
  disk: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
  };
  tracked: StorageTrackedHealth[];
  sampledAt: number;
  historyPath: string;
};

const MIN_DISK_FREE_BYTES = Math.max(
  1 * 1024 ** 3,
  Number(process.env.XLN_MIN_DISK_FREE_BYTES || String(5 * 1024 ** 3)),
);
const STORAGE_HEALTH_CACHE_MS = Math.max(5_000, Number(process.env.XLN_STORAGE_HEALTH_CACHE_MS || '60000'));
const STORAGE_HISTORY_WINDOW_MS = 26 * 60 * 60 * 1000;
const STORAGE_ONE_HOUR_MS = 60 * 60 * 1000;
const STORAGE_HISTORY_PATH = join(process.cwd(), 'data', 'storage-health-history.json');
const TRACKED_STORAGE_PATHS: TrackedStoragePath[] = [
  { name: 'pm2Logs', kind: 'log', path: '/root/.pm2/logs' },
  { name: 'runtimeLogs', kind: 'log', path: join(process.cwd(), 'logs') },
  { name: 'runtimeArtifacts', kind: 'log', path: join(process.cwd(), '.logs') },
  { name: 'playwrightReport', kind: 'log', path: join(process.cwd(), 'playwright-report') },
  { name: 'testResults', kind: 'log', path: join(process.cwd(), 'test-results') },
  { name: 'runtimeDb', kind: 'db', path: join(process.cwd(), 'db', 'runtime') },
  { name: 'custodyDb', kind: 'db', path: join(process.cwd(), 'db', 'custody') },
  { name: 'foundryAnvilTmp', kind: 'temp', path: join(homedir(), '.foundry', 'anvil', 'tmp') },
];

let cachedStorageHealth: StorageHealth | null = null;
let cachedStorageHealthAt = 0;
let inFlightStorageHealth: Promise<StorageHealth> | null = null;

const statDiskBytes = (): { totalBytes: number; usedBytes: number; freeBytes: number } => {
  const stat = statfsSync('/');
  const totalBytes = Number(stat.blocks) * Number(stat.bsize);
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return { totalBytes, usedBytes, freeBytes };
};

const sumPathBytes = (targetPath: string): number => {
  if (!existsSync(targetPath)) return 0;
  const stats = lstatSync(targetPath);
  if (stats.isSymbolicLink()) return 0;
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;

  let total = 0;
  for (const entry of readdirSync(targetPath)) {
    total += sumPathBytes(join(targetPath, entry));
  }
  return total;
};

const readStorageHistory = (): StorageHistoryEntry[] => {
  if (!existsSync(STORAGE_HISTORY_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(STORAGE_HISTORY_PATH, 'utf8')) as StorageHistoryEntry[];
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry) =>
      typeof entry?.ts === 'number'
      && Number.isFinite(entry.ts)
      && typeof entry?.freeBytes === 'number'
      && Number.isFinite(entry.freeBytes)
      && typeof entry?.tracked === 'object'
      && entry.tracked !== null,
    );
  } catch {
    return [];
  }
};

const writeStorageHistory = (entries: StorageHistoryEntry[]): void => {
  mkdirSync(dirname(STORAGE_HISTORY_PATH), { recursive: true });
  writeFileSync(STORAGE_HISTORY_PATH, JSON.stringify(entries), 'utf8');
};

const buildStorageHealth = (): StorageHealth => {
  const sampledAt = Date.now();
  const disk = statDiskBytes();
  const currentTracked = Object.fromEntries(
    TRACKED_STORAGE_PATHS.map((entry) => [entry.name, sumPathBytes(entry.path)] as const),
  );

  const existingHistory = readStorageHistory().filter((entry) => sampledAt - entry.ts <= STORAGE_HISTORY_WINDOW_MS);
  const nextHistory = [...existingHistory, { ts: sampledAt, freeBytes: disk.freeBytes, tracked: currentTracked }]
    .slice(-512);
  writeStorageHistory(nextHistory);

  const tracked = TRACKED_STORAGE_PATHS.map((entry): StorageTrackedHealth => {
    const currentBytes = currentTracked[entry.name] ?? 0;
    const baseline =
      nextHistory.find((sample) => sampledAt - sample.ts <= STORAGE_ONE_HOUR_MS && typeof sample.tracked[entry.name] === 'number')
      ?? nextHistory[0]
      ?? null;
    const baselineBytes = baseline ? baseline.tracked[entry.name] ?? currentBytes : currentBytes;
    const sampleWindowMs = baseline ? Math.max(0, sampledAt - baseline.ts) : 0;
    const deltaBytes1h = currentBytes - baselineBytes;
    const bytesPerHour = sampleWindowMs > 0
      ? Math.round((deltaBytes1h * STORAGE_ONE_HOUR_MS) / sampleWindowMs)
      : 0;
    return {
      name: entry.name,
      kind: entry.kind,
      path: entry.path,
      currentBytes,
      deltaBytes1h,
      bytesPerHour,
      sampleWindowMs,
    };
  });

  return {
    ok: disk.freeBytes >= MIN_DISK_FREE_BYTES,
    minFreeBytes: MIN_DISK_FREE_BYTES,
    disk,
    tracked,
    sampledAt,
    historyPath: STORAGE_HISTORY_PATH,
  };
};

export const getStorageHealth = async (): Promise<StorageHealth> => {
  const now = Date.now();
  if (cachedStorageHealth && now - cachedStorageHealthAt < STORAGE_HEALTH_CACHE_MS) {
    return cachedStorageHealth;
  }
  if (inFlightStorageHealth) {
    return inFlightStorageHealth;
  }
  inFlightStorageHealth = Promise.resolve().then(() => {
    const next = buildStorageHealth();
    cachedStorageHealth = next;
    cachedStorageHealthAt = Date.now();
    return next;
  }).finally(() => {
    inFlightStorageHealth = null;
  });
  return inFlightStorageHealth;
};

export const getStorageHealthSnapshotSync = (): StorageHealth => {
  const now = Date.now();
  if (cachedStorageHealth && now - cachedStorageHealthAt < STORAGE_HEALTH_CACHE_MS) {
    return cachedStorageHealth;
  }
  const next = buildStorageHealth();
  cachedStorageHealth = next;
  cachedStorageHealthAt = now;
  return next;
};

export const assertMinDiskFree = (): void => {
  const disk = statDiskBytes();
  if (disk.freeBytes < MIN_DISK_FREE_BYTES) {
    throw new Error(
      `INSUFFICIENT_DISK_FREE: free=${String(disk.freeBytes)} required=${String(MIN_DISK_FREE_BYTES)}`,
    );
  }
};
