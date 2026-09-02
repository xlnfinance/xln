import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../../../..');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const harnessRel = 'core/scripts/checks/fints/check-fints-negative-types.ts';
const parallelGateNames = (scriptName: string): string[] =>
  (packageJson.scripts[scriptName] ?? '').trim().split(/\s+/).slice(2);
const srcGateNames = (): string[] => parallelGateNames('check:src');

describe('full check orchestration', () => {
  test('runs independent Rust, TypeScript, and frontend gates concurrently', () => {
    expect(packageJson.scripts['check']).toBe('bun tools/run-parallel-checks.ts check:short check:long');
    expect(parallelGateNames('check:long')).toEqual(['check:src', 'check:frontend']);
    expect(srcGateNames().slice(0, 2)).toEqual(['soundcheck:fast', 'rscore:check']);
    expect(packageJson.scripts['check:src:parallel']).toBeUndefined();
  });

  test('parallel runner preserves child failure output and stops siblings', () => {
    const runner = readFileSync(join(repoRoot, 'tools/run-parallel-checks.ts'), 'utf8');
    expect(runner).toContain('output: stdout + stderr');
    expect(runner).toContain('if (exitCode !== 0) stopChildren()');
    expect(runner).toContain('console.error(result.output.trim())');
  });
});

describe('FinTS negative-type gate registration', () => {
  test('package script points at the existing harness exactly once through soundcheck', () => {
    expect(packageJson.scripts['check:fints-negative-types']).toBe(`bun ${harnessRel}`);
    expect(existsSync(join(repoRoot, harnessRel))).toBe(true);
    expect(srcGateNames().filter(name => name === 'soundcheck:fast')).toEqual(['soundcheck:fast']);
    expect(srcGateNames()).not.toContain('check:fints-negative-types');

    const soundcheck = readFileSync(join(repoRoot, 'tools/soundcheck.ts'), 'utf8');
    expect(soundcheck.match(/name: 'fints-negative-types'/g)).toEqual(["name: 'fints-negative-types'"]);
    expect(soundcheck.match(/check:fints-negative-types/g)).toEqual(['check:fints-negative-types']);
    expect(soundcheck).not.toContain('bun run check:src');
    expect(packageJson.scripts['check:src']).toStartWith('bun tools/run-parallel-checks.ts ');
  });
});
