import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { safeStringify } from '../protocol/serialization';

export type ChildFailureReceipt = {
  schema: 'xln-child-failure-v1';
  recordedAt: string;
  role: 'hub' | 'market-maker' | 'orchestrator';
  name: string;
  pid: number | null;
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: string;
  reasonCode: string;
  fingerprint: string;
  identicalFailureCount: number;
  action: 'recover' | 'fail-stop';
  backoffMs: number;
  startedAt: number | null;
  exitedAt: number;
  reset: unknown;
  codeFingerprint: unknown;
  lastHealth: unknown;
  lastInfo: unknown;
  recentStdout: string[];
  recentStderr: string[];
};

const writeAtomicDurable = (path: string, payload: string): void => {
  const tmpPath = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
};

export const persistChildFailureReceipt = (
  diagnosticsDir: string,
  receipt: ChildFailureReceipt,
  uniqueId: string,
): { receiptPath: string; latestPath: string } => {
  mkdirSync(diagnosticsDir, { recursive: true, mode: 0o700 });
  const safeName = receipt.name.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = receipt.recordedAt.replaceAll(/[^0-9TZ]/g, '');
  const receiptPath = join(diagnosticsDir, `${timestamp}-${safeName}-${uniqueId}.json`);
  const latestPath = join(diagnosticsDir, 'last-fatal.json');
  const payload = `${safeStringify(receipt)}\n`;
  writeAtomicDurable(receiptPath, payload);
  if (receipt.action === 'fail-stop') {
    writeAtomicDurable(latestPath, payload);
  }
  return { receiptPath, latestPath };
};
