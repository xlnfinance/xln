import type { AggregatedHealth } from './orchestrator-types';
import type { StorageHealth } from '../infra/storage-monitor';

const toGiB = (bytes: number): number => Math.round((bytes / 1024 ** 3) * 100) / 100;

/** Converts the storage gate's byte-accurate result into public health units. */
export const buildDiskSummary = (storage: StorageHealth): AggregatedHealth['disk'] => {
  const totalBytes = Number(storage.disk.totalBytes || 0);
  const usedBytes = Number(storage.disk.usedBytes || 0);
  const freeBytes = Number(storage.disk.freeBytes || 0);
  const shortfallBytes = Number(storage.shortfallBytes || 0);
  return {
    ok: storage.ok,
    minFreeBytes: storage.minFreeBytes,
    shortfallBytes,
    freeBytes,
    usedBytes,
    totalBytes,
    shortfallGiB: toGiB(shortfallBytes),
    freeGiB: toGiB(freeBytes),
    usedGiB: toGiB(usedBytes),
    totalGiB: toGiB(totalBytes),
    usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 10_000) / 100 : 0,
  };
};
