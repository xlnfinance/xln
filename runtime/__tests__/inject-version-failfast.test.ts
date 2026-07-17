import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('version injection provenance', () => {
  test('fails closed when Git provenance is unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'xln-version-failfast-'));
    tempRoots.push(cwd);
    const child = Bun.spawn([
      process.execPath,
      resolve(ROOT, 'scripts/inject-version.ts'),
    ], {
      cwd,
      env: { ...process.env, GIT_DIR: join(cwd, 'missing.git') },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect(exitCode, stderr).not.toBe(0);
    expect(existsSync(join(cwd, 'frontend/src/lib/generated/version.ts'))).toBe(false);
  });
});
