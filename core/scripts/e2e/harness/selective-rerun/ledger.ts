/**
 * Durable local gate that forces every observed scenario/E2E failure through
 * one exact green rerun before another broad run may start. The ledger is QA
 * local evidence only; it never enters Runtime, Entity, Account, or protocol state.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { safeStringify } from '../../../../protocol/serialization';

const LEDGER_VERSION = 1;
const DEFAULT_LEDGER_PATH = resolve(process.cwd(), '.logs', 'qa', 'selective-reruns.json');
const CODE_HASH_PATTERN = /^[0-9a-f]{64}$/;
const LOCK_RETRY_COUNT = 100;
const LOCK_RETRY_MS = 10;
const INCOMPLETE_LOCK_STALE_MS = 30_000;

export type SelectiveRerunKind = 'scenario' | 'e2e';

export type SelectiveRerunEntry = Readonly<{
  kind: SelectiveRerunKind;
  target: string;
  failedCodeHash: string;
  failedAt: string;
  reason: string;
}>;

type SelectiveRerunLedger = Readonly<{
  version: typeof LEDGER_VERSION;
  unresolved: readonly SelectiveRerunEntry[];
}>;

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}_RECORD_REQUIRED`);
  }
  return value as Record<string, unknown>;
};

const requireExactKeys = (
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void => {
  const actual = Object.keys(record).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label}_FIELDS_INVALID:${actual.join(',')}`);
  }
};

const requireText = (value: unknown, label: string, maxLength: number): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || /[\r\n]/.test(value)) {
    throw new Error(`${label}_INVALID`);
  }
  return value;
};

const decodeEntry = (value: unknown, index: number): SelectiveRerunEntry => {
  const label = `SELECTIVE_RERUN_ENTRY_${index}`;
  const record = requireRecord(value, label);
  requireExactKeys(record, ['kind', 'target', 'failedCodeHash', 'failedAt', 'reason'], label);
  const kind = record['kind'];
  if (kind !== 'scenario' && kind !== 'e2e') throw new Error(`${label}_KIND_INVALID`);
  const target = requireText(record['target'], `${label}_TARGET`, 1000);
  const failedCodeHash = requireText(record['failedCodeHash'], `${label}_CODE_HASH`, 64);
  if (!CODE_HASH_PATTERN.test(failedCodeHash)) throw new Error(`${label}_CODE_HASH_INVALID`);
  return {
    kind,
    target,
    failedCodeHash,
    failedAt: requireText(record['failedAt'], `${label}_FAILED_AT`, 64),
    reason: requireText(record['reason'], `${label}_REASON`, 500),
  };
};

const decodeLedger = (value: unknown): SelectiveRerunLedger => {
  const record = requireRecord(value, 'SELECTIVE_RERUN_LEDGER');
  requireExactKeys(record, ['version', 'unresolved'], 'SELECTIVE_RERUN_LEDGER');
  if (record['version'] !== LEDGER_VERSION) throw new Error('SELECTIVE_RERUN_LEDGER_VERSION_INVALID');
  if (!Array.isArray(record['unresolved'])) throw new Error('SELECTIVE_RERUN_LEDGER_UNRESOLVED_INVALID');
  const unresolved = record['unresolved'].map(decodeEntry);
  const keys = new Set<string>();
  for (const entry of unresolved) {
    const key = `${entry.kind}\0${entry.target}`;
    if (keys.has(key)) throw new Error(`SELECTIVE_RERUN_LEDGER_DUPLICATE:${entry.kind}:${entry.target}`);
    keys.add(key);
  }
  return { version: LEDGER_VERSION, unresolved };
};

export const readSelectiveRerunLedger = (
  path = DEFAULT_LEDGER_PATH,
): SelectiveRerunLedger => {
  try {
    return decodeLedger(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code ?? '')
      : '';
    if (code === 'ENOENT') return { version: LEDGER_VERSION, unresolved: [] };
    throw new Error(`SELECTIVE_RERUN_LEDGER_INVALID:${path}`, { cause: error });
  }
};

const writeLedger = (ledger: SelectiveRerunLedger, path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temporary, `${safeStringify(ledger, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
};

const waitForLedgerLock = (): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code ?? '')
      : '';
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
};

const removeStaleLedgerLock = (lockPath: string): boolean => {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    if (!raw) {
      if (Date.now() - statSync(lockPath).mtimeMs < INCOMPLETE_LOCK_STALE_MS) return false;
    } else {
      if (!/^[1-9][0-9]*$/.test(raw)) {
        throw new Error(`SELECTIVE_RERUN_LEDGER_LOCK_INVALID:${lockPath}`);
      }
      if (processIsAlive(Number(raw))) return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code ?? '')
      : '';
    if (code === 'ENOENT') return true;
    throw error;
  }
};

const withLedgerLock = <T>(path: string, action: () => T): T => {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(descriptor, `${String(process.pid)}\n`);
      closeSync(descriptor);
      try {
        return action();
      } finally {
        unlinkSync(lockPath);
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error
        ? String((error as NodeJS.ErrnoException).code ?? '')
        : '';
      if (code !== 'EEXIST') throw error;
      if (removeStaleLedgerLock(lockPath)) continue;
      waitForLedgerLock();
    }
  }
  throw new Error(`SELECTIVE_RERUN_LEDGER_LOCK_TIMEOUT:${lockPath}`);
};

export const recordSelectiveRerunFailure = (
  entry: SelectiveRerunEntry,
  path = DEFAULT_LEDGER_PATH,
): void => {
  withLedgerLock(path, () => {
    const reason = entry.reason.replace(/[\r\n]+/g, ' ').trim().slice(0, 500) || 'unknown-failure';
    const canonicalEntry = decodeEntry({
      ...entry,
      reason,
    }, 0);
    const ledger = readSelectiveRerunLedger(path);
    const unresolved = ledger.unresolved.filter(
      current => current.kind !== canonicalEntry.kind || current.target !== canonicalEntry.target,
    );
    unresolved.push(canonicalEntry);
    unresolved.sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.target.localeCompare(right.target));
    writeLedger({ version: LEDGER_VERSION, unresolved }, path);
  });
};

export const recordSelectiveRerunPass = (
  kind: SelectiveRerunKind,
  target: string,
  path = DEFAULT_LEDGER_PATH,
): void => {
  withLedgerLock(path, () => {
    const ledger = readSelectiveRerunLedger(path);
    const unresolved = ledger.unresolved.filter(
      current => current.kind !== kind || current.target !== target,
    );
    if (unresolved.length === ledger.unresolved.length) return;
    writeLedger({ version: LEDGER_VERSION, unresolved }, path);
  });
};

export type BroadRunLedgerFilter = Readonly<{
  kind?: SelectiveRerunKind;
  targets?: readonly string[];
}>;

export const assertBroadRunHasNoUnresolvedReruns = (
  path = DEFAULT_LEDGER_PATH,
  filter?: BroadRunLedgerFilter,
): void => {
  const targetSet = filter?.targets === undefined ? undefined : new Set(filter.targets);
  const unresolved = readSelectiveRerunLedger(path).unresolved.filter(entry => {
    if (filter?.kind !== undefined && entry.kind !== filter.kind) return false;
    if (targetSet !== undefined && !targetSet.has(entry.target)) return false;
    return true;
  });
  if (unresolved.length === 0) return;
  const table = unresolved
    .map(entry => {
      const rerun = entry.kind === 'scenario'
        ? `bun core/scenarios/run.ts ${entry.target} --mode=rpc --single`
        : `bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts --shards=1 --workers-per-shard=1 --pw-files=${entry.target} --strict-browser-health --preserve-artifacts`;
      return `${entry.kind}\t${entry.target}\t${entry.failedCodeHash.slice(0, 12)}\t${entry.reason}\n  ${rerun}`;
    })
    .join('\n');
  throw new Error(
    `BROAD_RUN_BLOCKED_EXACT_RERUN_REQUIRED count=${unresolved.length}\n` +
    `kind\ttarget\tfailed-code\treason\n${table}`,
  );
};

export const selectiveE2ETarget = (file: string, title: string): string =>
  `${file}::${title}`;
