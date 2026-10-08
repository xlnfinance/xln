import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const checker = resolve('core/scripts/checks/architecture/check-english-source.ts');
const russianText = '\u0420\u0443\u0441\u0441\u043a\u0438\u0439';

const checkFiles = (paths: readonly string[]) => {
  const root = mkdtempSync(join(tmpdir(), 'xln-source-language-'));
  try {
    expect(Bun.spawnSync(['git', 'init', '--quiet'], { cwd: root }).exitCode).toBe(0);
    for (const path of paths) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, russianText + '\n');
    }
    expect(Bun.spawnSync(['git', 'add', '.'], { cwd: root }).exitCode).toBe(0);
    const result = Bun.spawnSync([process.execPath, checker], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('source language policy', () => {
  test('permits Russian publications and build sources below docs/ru/', () => {
    const result = checkFiles(['docs/ru/manual.md', 'docs/ru/nested/content.json', 'docs/ru/manual/build.py']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('ENGLISH_SOURCE_OK');
  });

  test.each(['docs/guide.md', 'docs/ru-extra/guide.md', 'docs/rust/guide.md', 'core/docs/ru/source.ts'])(
    'rejects Cyrillic outside the authorized tree: %s',
    path => {
      const result = checkFiles([path]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(`${path}:1:`);
    },
  );
});
