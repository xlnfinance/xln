import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertE2ECodeFingerprintStable,
  computeE2EBuildInputHash,
} from '../../../scripts/e2e/harness/e2e-isolated-runtime';
import { buildQaCandidateIdentity } from '../../../qa/candidate';

test('TS provenance binds bytes despite identical size and mtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-ts-provenance-'));
  const file = 'core/runtime.ts';
  const path = join(root, file);
  const timestamp = new Date(1_700_000_000_000);
  try {
    mkdirSync(join(root, 'core'));
    writeFileSync(path, 'export const generation = 1;');
    utimesSync(path, timestamp, timestamp);
    const before = computeE2EBuildInputHash([file], root);
    const metadata = statSync(path);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertE2ECodeFingerprintStable(before, before)).not.toThrow();
    writeFileSync(path, 'export const generation = 2;');
    utimesSync(path, timestamp, timestamp);
    expect(statSync(path).size).toBe(metadata.size);
    expect(statSync(path).mtimeMs).toBe(metadata.mtimeMs);
    const after = computeE2EBuildInputHash([file], root);
    expect(() => assertE2ECodeFingerprintStable(before, after)).toThrow('E2E_CODE_DRIFT');
    const candidate = (codeHash: string) =>
      buildQaCandidateIdentity({
        gitHead: '1'.repeat(40),
        codeHash,
        gateConfig: {},
      });
    expect(candidate(before).candidateId).not.toBe(candidate(after).candidateId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary E2E rejects retired engines before arguments, cleanup or build', () => {
  for (const engine of ['rust', 'ts']) {
    // This forbidden flag stops before cleanup even if engine validation regresses.
    const result = spawnSync(
      process.execPath,
      ['core/scripts/e2e/runners/run-e2e-parallel-isolated.ts', '--base-port=1'],
      {
        env: { ...process.env, XLN_HLT_ENGINE: engine, XLN_RSCORE_BINARY: '/missing/native' },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      engine === 'rust' ? 'RUNTIME_ACCOUNT_ENGINE_RETIRED:XLN_HLT_ENGINE:typescript-only' : 'E2E_BASE_PORT_OVERRIDE_FORBIDDEN',
    );
    expect(result.stdout).not.toContain('E2E Parallel Runner');
  }
});
