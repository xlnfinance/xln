import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCleanReleaseSource,
  assertReleaseTagBindsSource,
} from '../../../../tools/release-snapshot/source-policy';

const run = (cwd: string, command: string[], env = process.env): string => {
  const result = Bun.spawnSync(command, { cwd, env, stdout: 'pipe', stderr: 'pipe', timeout: 15_000 });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
};

test('React wallet edits and untracked source participate in release authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-react-release-scope-'));
  try {
    run(root, ['git', 'init', '--quiet', '-b', 'main']);
    run(root, ['git', 'config', 'user.name', 'xln test']);
    run(root, ['git', 'config', 'user.email', 'xln@example.test']);
    mkdirSync(join(root, 'ui/src'), { recursive: true });
    writeFileSync(join(root, 'ui/src/App.tsx'), "export const version = 'reviewed';\n");
    run(root, ['git', 'add', '.']);
    run(root, ['git', 'commit', '--quiet', '-m', 'reviewed wallet']);
    const reviewed = run(root, ['git', 'rev-parse', 'HEAD']);
    expect(() => assertCleanReleaseSource(root)).not.toThrow();
    writeFileSync(join(root, 'ui/src/App.tsx'), "export const version = 'changed';\n");
    expect(() => assertCleanReleaseSource(root)).toThrow('RELEASE_SOURCE_DIRTY');
    run(root, ['git', 'checkout', '--', 'ui/src/App.tsx']);
    writeFileSync(join(root, 'ui/src/Unreviewed.tsx'), 'export const added = true;\n');
    expect(() => assertCleanReleaseSource(root)).toThrow('RELEASE_SOURCE_DIRTY');
    run(root, ['git', 'add', '.']);
    run(root, ['git', 'commit', '--quiet', '-m', 'unreviewed wallet source']);
    run(root, ['git', 'tag', '-a', 'v0.1.0', '-m', 'release']);
    expect(() => assertReleaseTagBindsSource(root, '0.1.0', reviewed)).toThrow(
      'RELEASE_TAG_UNATTESTED_PATHS:ui/src/Unreviewed.tsx',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
