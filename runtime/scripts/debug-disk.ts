#!/usr/bin/env bun

import { getStorageHealthSnapshotReadOnlySync, type StorageHealth } from '../orchestrator/storage-monitor';
import { safeStringify } from '../serialization-utils';

type DiskDebugPayload = {
  ok: boolean;
  readOnly: true;
  sampledAt: number;
  minFreeBytes: number;
  shortfallBytes: number;
  freeBytes: number;
  freeGiB: string;
  shortfallGiB: string;
  usedPct: string;
  historyPath: string;
  tracked: Array<{
    name: string;
    kind: string;
    path: string;
    currentBytes: number;
    currentGiB: string;
    deltaBytes1h: number;
    bytesPerHour: number;
    scanTruncated: boolean;
    scanMode: string;
  }>;
};

const usage = (code = 1): never => {
  console.log([
    'Usage:',
    '  bun runtime/scripts/debug-disk.ts [--json]',
    '',
    'Options:',
    '  --json   Print machine-readable JSON',
    '  --help   Show this help',
    '',
    'This command is read-only. It does not write storage health history.',
  ].join('\n'));
  process.exit(code);
};

const parseArgs = (): { json: boolean } => {
  const args = process.argv.slice(2);
  const out = { json: false };
  for (const arg of args) {
    switch (arg) {
      case '--json':
        out.json = true;
        break;
      case '--help':
      case '-h':
        usage(0);
        break;
      default:
        throw new Error(`ARG_UNKNOWN:${arg}`);
    }
  }
  return out;
};

const formatGiB = (bytes: number): string => (Math.max(0, bytes) / (1024 ** 3)).toFixed(2);

const buildPayload = (health: StorageHealth): DiskDebugPayload => {
  const totalBytes = Math.max(1, health.disk.totalBytes);
  const usedPct = ((health.disk.usedBytes / totalBytes) * 100).toFixed(2);
  return {
    ok: health.ok,
    readOnly: true,
    sampledAt: health.sampledAt,
    minFreeBytes: health.minFreeBytes,
    shortfallBytes: health.shortfallBytes,
    freeBytes: health.disk.freeBytes,
    freeGiB: formatGiB(health.disk.freeBytes),
    shortfallGiB: formatGiB(health.shortfallBytes),
    usedPct,
    historyPath: health.historyPath,
    tracked: [...health.tracked]
      .sort((left, right) => right.currentBytes - left.currentBytes)
      .map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        path: entry.path,
        currentBytes: entry.currentBytes,
        currentGiB: formatGiB(entry.currentBytes),
        deltaBytes1h: entry.deltaBytes1h,
        bytesPerHour: entry.bytesPerHour,
        scanTruncated: entry.scanTruncated,
        scanMode: entry.scanMode,
      })),
  };
};

const printHuman = (payload: DiskDebugPayload): void => {
  console.log('XLN disk diagnostic');
  console.log(
    `ok=${payload.ok} readOnly=${payload.readOnly} freeBytes=${payload.freeBytes} freeGiB=${payload.freeGiB} minFreeBytes=${payload.minFreeBytes} shortfallBytes=${payload.shortfallBytes} shortfallGiB=${payload.shortfallGiB} usedPct=${payload.usedPct}`,
  );
  console.log(`historyPath=${payload.historyPath}`);
  for (const entry of payload.tracked.slice(0, 12)) {
    const truncated = entry.scanTruncated ? ' truncated=true' : '';
    console.log(
      `tracked=${entry.name} kind=${entry.kind} bytes=${entry.currentBytes} GiB=${entry.currentGiB} mode=${entry.scanMode}${truncated} path=${entry.path}`,
    );
  }
  if (!payload.ok) {
    console.log('operatorAction=free host disk outside repo or remove old generated artifacts before rerunning gates');
  }
};

const main = (): void => {
  const args = parseArgs();
  const payload = buildPayload(getStorageHealthSnapshotReadOnlySync());
  if (args.json) {
    console.log(safeStringify(payload, 2));
  } else {
    printHuman(payload);
  }
  if (!payload.ok) process.exit(1);
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
