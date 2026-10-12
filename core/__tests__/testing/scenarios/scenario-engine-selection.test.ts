import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

const run = (args: string[], engine = 'ts') => spawnSync(
  process.execPath,
  ['core/scenarios/run.ts', ...args],
  { env: { ...process.env, XLN_HLT_ENGINE: engine }, encoding: 'utf8', timeout: 10_000 },
);

test('a Rust selector cannot turn an in-process TS scenario into native evidence', () => {
  for (const args of [['multi-sig', '--single'], ['all']]) {
    const result = run(args, 'rust');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('HUB_ENGINE_RETIRED:XLN_HLT_ENGINE:typescript-only');
    expect(result.stdout).not.toContain('Creating entities');
  }
});

test('explicit engine selection overrides inherited engine and fails before launch', () => {
  const result = run(['multi-sig', '--single', '--hub-engine=rust']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('HUB_ENGINE_RETIRED:XLN_HLT_ENGINE:typescript-only');
  expect(result.stdout).not.toContain('Creating entities');
});

test('an empty or unknown explicit engine cannot silently select TypeScript', () => {
  for (const flag of ['--hub-engine=', '--hub-engine', '--hub-engine=native']) {
    const result = run(['mm-mesh', flag]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(flag === '--hub-engine=native'
      ? 'HUB_ENGINE_SELECTOR_INVALID:native'
      : 'SCENARIO_HUB_ENGINE_REQUIRED:ts');
  }
});
