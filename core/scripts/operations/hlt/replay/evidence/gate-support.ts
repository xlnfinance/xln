import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Bounded subprocess boundary shared by the authoritative recording gates. */

export const AUTHORITY_EVIDENCE_GATE_MAX_MS = 20_000;

export const freshAuthorityEvidenceDir = (prefix: string): string => {
  const configured = String(process.env['XLN_RSCORE_EVIDENCE_DIR'] ?? '').trim();
  if (!configured) return mkdtempSync(join(tmpdir(), prefix));
  const path = resolve(configured);
  if (existsSync(path)) throw new Error(`RSCORE_EVIDENCE_DIR_NOT_FRESH:${path}`);
  return path;
};

export const authorityEvidenceBinary = (): string => {
  const path = resolve(String(
    process.env['XLN_RSCORE_BINARY'] ?? 'rscore/target/release/xln-rscore',
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
  if (elapsedMs >= AUTHORITY_EVIDENCE_GATE_MAX_MS) {
    throw new Error(`${options.label}_TOO_SLOW:${elapsedMs.toFixed(2)}`);
  }
  console.log(`${options.label}_OK elapsedMs=${elapsedMs.toFixed(2)}`);
  return elapsedMs;
};
