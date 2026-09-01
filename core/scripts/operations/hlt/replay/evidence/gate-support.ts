import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Subprocess boundary shared by the replay fixture commands. */

/** Every recorder/replay command remains inside the repository-wide hard gate. */
export const AUTHORITY_EVIDENCE_RECORD_BUDGET_MS = 30_000;

/** Closed-WAL read and artifact write share that same aggregate command gate. */
export const AUTHORITY_EVIDENCE_BUILD_BUDGET_MS = 30_000;

export const freshAuthorityEvidenceDir = (prefix: string): string => {
  const configured = String(process.env['XLN_RSCORE_EVIDENCE_DIR'] ?? '').trim();
  if (!configured) return mkdtempSync(join(tmpdir(), prefix));
  const path = resolve(configured);
  if (existsSync(path)) throw new Error(`RSCORE_EVIDENCE_DIR_NOT_FRESH:${path}`);
  return path;
};

export const authorityEvidenceBinary = (): string => {
  const path = resolve(String(
    process.env['XLN_RSCORE_BINARY'] ?? 'rscore/target/release/xlnrs',
  ));
  accessSync(path, constants.X_OK);
  return path;
};

export const runAuthorityEvidenceGate = (options: Readonly<{
  label: string;
  script: string;
  args?: readonly string[];
  env: NodeJS.ProcessEnv;
}>): number => {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [options.script, ...(options.args ?? [])], {
    cwd: process.cwd(),
    env: options.env,
    stdio: 'inherit',
    timeout: AUTHORITY_EVIDENCE_RECORD_BUDGET_MS,
  });
  const elapsedMs = performance.now() - startedAt;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${options.label}_FAILED:status=${String(result.status)}:signal=${String(result.signal)}`,
    );
  }
  console.log(`${options.label}_OK elapsedMs=${elapsedMs.toFixed(2)}`);
  return elapsedMs;
};
