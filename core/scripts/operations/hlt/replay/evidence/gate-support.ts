import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Subprocess boundary shared by the replay fixture commands. */

/** Owner-approved aggregate budget for the >=1,000-frame recording and replay gate. */
// Four replays of a ~2,200-frame WAL (TS W1/W4 ≈ 60-90 s each on a shared
// box, Rust W1/W4 ≈ 12 s each) need up to ~200 s when the machine also
// carries an interactive session; 180 s tripped the live TPS pre-check three
// times on 2026-09-02 with the same recording that passed in isolation.
// Larger production recordings (2,000-3,000 users) replay for minutes per
// engine; the ladder run sets XLN_HLT_PARITY_BUDGET_MS explicitly.
export const AUTHORITY_EVIDENCE_GATE_BUDGET_MS = Number(process.env['XLN_HLT_PARITY_BUDGET_MS'] || 0) || 300_000;

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
    timeout: AUTHORITY_EVIDENCE_GATE_BUDGET_MS,
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
