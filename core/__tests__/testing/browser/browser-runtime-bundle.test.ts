import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..');
const outputRoot = mkdtempSync(join(tmpdir(), 'xln-browser-runtime-build-'));
const outputPath = join(outputRoot, 'runtime.js');

afterAll(() => rmSync(outputRoot, { recursive: true, force: true }));

describe('browser Runtime bundle', () => {
  test('contains no unresolved Node crypto module import', async () => {
    const child = Bun.spawn({
      cmd: ['bash', 'scripts/build-runtime.sh'],
      cwd: repoRoot,
      env: { ...process.env, XLN_RUNTIME_BUNDLE_OUT: outputPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

    const bundle = readFileSync(outputPath, 'utf8');
    expect(bundle).not.toMatch(/(?:from\s*|import\s*\()\s*["'](?:node:)?crypto["']/u);
  }, 30_000);
});
