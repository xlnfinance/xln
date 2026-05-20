import { mkdir } from 'fs/promises';
import { join } from 'path';
import type { StorageHealth } from './orchestrator/storage-monitor';

export const ENTITY_ID_HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;

export const isEntityId32 = (value: unknown): value is string =>
  typeof value === 'string' && ENTITY_ID_HEX_32_RE.test(value);

export const JSON_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': '*',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json',
} as const;

export const getErrorMessage = (error: unknown, fallback = 'Unknown error'): string =>
  error instanceof Error ? error.message : typeof error === 'string' && error.length > 0 ? error : fallback;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const formatTimingMs = (value: number): string => value.toFixed(2);

export const resolveRequiredAnvilRpc = (): string => {
  const rpcUrl = String(process.env['ANVIL_RPC'] || '').trim();
  if (!rpcUrl) {
    throw new Error('ANVIL_RPC is required for server RPC operations');
  }
  return rpcUrl;
};

export const DEBUG_DUMPS_DIR = join(process.cwd(), '.logs', 'debug-dumps');

export const ensureDebugDumpDir = async (): Promise<void> => {
  await mkdir(DEBUG_DUMPS_DIR, { recursive: true });
};

export const buildDebugDumpFileName = (reason: string | undefined, runtimeId: string | undefined): string => {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const reasonPart = String(reason || 'dump')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 48) || 'dump';
  const runtimePart = String(runtimeId || 'runtime').replace(/[^a-zA-Z0-9_-]+/g, '').slice(-16) || 'runtime';
  return `${iso}-${reasonPart}-${runtimePart}.json`;
};

export const buildDiskSummary = (storage: StorageHealth) => {
  const totalBytes = Number(storage.disk.totalBytes || 0);
  const usedBytes = Number(storage.disk.usedBytes || 0);
  const freeBytes = Number(storage.disk.freeBytes || 0);
  const toGiB = (value: number): number => Math.round((value / 1024 ** 3) * 100) / 100;
  return {
    ok: storage.ok,
    minFreeBytes: storage.minFreeBytes,
    freeBytes,
    usedBytes,
    totalBytes,
    freeGiB: toGiB(freeBytes),
    usedGiB: toGiB(usedBytes),
    totalGiB: toGiB(totalBytes),
    usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 10000) / 100 : 0,
  };
};
