#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  E2E_FATAL_LOG_TAIL_LINES,
  findFirstRuntimeFatalLogHit,
  tailLog,
} from './e2e-fatal-log-monitor';

type RunnerLockPayload = {
  pid: number;
  startedAt: number;
  cwd: string;
  logsDir?: string;
};

const repoRoot = process.cwd();
const e2eRoot = resolve(repoRoot, '.logs', 'e2e-parallel');
const runnerLockPath = join(e2eRoot, '.runner-lock.json');

const argValue = (name: string): string | null => {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(arg => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
};

const hasFlag = (name: string): boolean => process.argv.slice(2).includes(`--${name}`);

const positiveInt = (raw: string | null, fallback: number): number => {
  const parsed = Number(raw ?? '');
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const pidIsAlive = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readRunnerLock = (): RunnerLockPayload | null => {
  try {
    return JSON.parse(readFileSync(runnerLockPath, 'utf8')) as RunnerLockPayload;
  } catch {
    return null;
  }
};

const latestLogsDir = (): string | null => {
  if (!existsSync(e2eRoot)) return null;
  return readdirSync(e2eRoot)
    .map(name => join(e2eRoot, name))
    .filter(path => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      try {
        return statSync(right).mtimeMs - statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    })[0] ?? null;
};

const resolveLogsDir = (): string | null => {
  const explicit = argValue('dir');
  if (explicit) return resolve(explicit);
  const lock = readRunnerLock();
  if (lock?.logsDir) return resolve(lock.logsDir);
  if (hasFlag('latest')) return latestLogsDir();
  return null;
};

const shardLogPaths = (logsDir: string): string[] => {
  if (!existsSync(logsDir)) return [];
  return readdirSync(logsDir)
    .filter(name => /^e2e-shard-\d+\.log$/.test(name))
    .sort()
    .map(name => join(logsDir, name));
};

const stopRunner = async (): Promise<void> => {
  const lock = readRunnerLock();
  if (!lock || !pidIsAlive(lock.pid)) return;
  console.error(`[e2e-monitor] stopping runner pid=${lock.pid} lock=${runnerLockPath}`);
  try {
    process.kill(lock.pid, 'SIGTERM');
  } catch {}
  await delay(3_000);
  if (!pidIsAlive(lock.pid)) return;
  try {
    process.kill(lock.pid, 'SIGKILL');
  } catch {}
};

const scanOnce = (logsDir: string, scannedLinesByPath: Map<string, number>): boolean => {
  for (const path of shardLogPaths(logsDir)) {
    const fromLine = scannedLinesByPath.get(path) ?? 0;
    const hit = findFirstRuntimeFatalLogHit(path, fromLine);
    if (hit) {
      console.error(
        `E2E_FATAL_RUNTIME_LOG marker=${hit.pattern} file=${path} line=${hit.lineNumber}\n` +
        `${hit.lineNumber}: ${hit.line}\n` +
        `--- last ${E2E_FATAL_LOG_TAIL_LINES} lines (${path}) ---\n${tailLog(path, E2E_FATAL_LOG_TAIL_LINES)}`,
      );
      return true;
    }
    try {
      scannedLinesByPath.set(path, readFileSync(path, 'utf8').split('\n').length);
    } catch {
      scannedLinesByPath.set(path, 0);
    }
  }
  return false;
};

const main = async (): Promise<void> => {
  const intervalMs = positiveInt(argValue('interval-ms'), 500);
  const timeoutMs = positiveInt(argValue('timeout-ms'), 0);
  const killRunner = !hasFlag('no-kill');
  const once = hasFlag('once');
  const startedAt = Date.now();
  const scannedLinesByPath = new Map<string, number>();

  while (timeoutMs === 0 || Date.now() - startedAt < timeoutMs) {
    const logsDir = resolveLogsDir();
    if (logsDir && scanOnce(logsDir, scannedLinesByPath)) {
      if (killRunner) await stopRunner();
      process.exit(1);
    }
    if (once) break;
    await delay(intervalMs);
  }

  const dir = resolveLogsDir();
  console.log(`[e2e-monitor] clean dir=${dir || '(none)'} latest=${dir ? basename(dir) : '(none)'}`);
};

main().catch(async (error) => {
  console.error('[e2e-monitor] failed:', error instanceof Error ? error.stack || error.message : String(error));
  await stopRunner();
  process.exit(1);
});
