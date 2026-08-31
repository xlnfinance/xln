import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../../../..');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const harnessRel = 'core/scripts/checks/fints/check-fints-negative-types.ts';
const srcGateNames = (): string[] =>
  (packageJson.scripts['check:src'] ?? '').trim().split(/\s+/).slice(2);

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
