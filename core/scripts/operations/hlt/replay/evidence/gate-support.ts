import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Subprocess boundary shared by the replay fixture commands. */

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
  });
  const elapsedMs = performance.now() - startedAt;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${options.label}_FAILED:status=${String(result.status)}:signal=${String(result.signal)}`,
    );
  }
  // Production setup is reusable and may legitimately exceed one short test
  // phase. Its child emits named stage timings; only a silent/stalled stage is
  // a failure, not the aggregate wall time of setup + economic work.
  console.log(`${options.label}_OK elapsedMs=${elapsedMs.toFixed(2)}`);
  return elapsedMs;
};

/**
 * Owner-authorized exemption (2026-09-01) from the 30-second hard execution
 * budget, and only for the authority-evidence recorder chain.
 *
 * The Rust replay gate proves parity over at least 1,000 contiguous
 * RuntimeFrames on one immutable artifact. The canonical 1,000-user mixed
 * workload cannot reach that frame depth inside 30 seconds, so the recorder
 * is the single sanctioned long child. Every other script, benchmark, test
 * and gate in this repository keeps the 30-second limit; do not reuse this
 * constant to make an unrelated slow run pass.
 */
export const AUTHORITY_EVIDENCE_RECORD_BUDGET_MS = 600_000;

/** Journal read + artifact write for the same recording, sharing that exemption. */
export const AUTHORITY_EVIDENCE_BUILD_BUDGET_MS = 120_000;
