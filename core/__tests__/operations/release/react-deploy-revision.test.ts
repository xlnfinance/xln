import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { assertCleanReleaseSource, assertReleaseTagBindsSource } from '../../../../tools/release-snapshot/source-policy';

const deployScript = resolve('scripts/deployment/deploy-ui.sh');
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
    expect(() => assertReleaseTagBindsSource(root, '0.1.0', reviewed))
      .toThrow('RELEASE_TAG_UNATTESTED_PATHS:ui/src/Unreviewed.tsx');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('React deployment builds the reviewed Runtime revision even after main advances', () => {
  // Real local Git repositories and Bun builds exercise revision selection;
  // no production checkout, remote host or financial service is involved.
  const root = mkdtempSync(join(tmpdir(), 'xln-react-deploy-'));
  const remote = join(root, 'origin');
  const runtime = join(root, 'runtime');
  const wallet = join(root, 'wallet');
  try {
    mkdirSync(remote);
    mkdirSync(runtime);
    run(remote, ['git', 'init', '--quiet', '--bare', '-b', 'main']);
    run(runtime, ['git', 'init', '--quiet', '-b', 'main']);
    run(runtime, ['git', 'config', 'user.name', 'xln test']);
    run(runtime, ['git', 'config', 'user.email', 'xln@example.test']);
    run(runtime, ['git', 'remote', 'add', 'origin', remote]);
    writeFileSync(join(runtime, '.gitignore'), 'ui/dist/\n');
    writeFileSync(join(runtime, 'package.json'), '{"name":"xln-deploy-fixture","private":true}\n');
    mkdirSync(join(runtime, 'ui'));
    writeFileSync(join(runtime, 'ui/package.json'), safeStringify({
      name: 'xln-deploy-fixture-ui', private: true, scripts: { 'build:hosted': 'bun build.ts' },
    }));
    writeFileSync(join(runtime, 'ui/build.ts'), [
      "const result = await Bun.build({ entrypoints: ['runtime.ts', 'account-worker.ts'], outdir: 'dist' });",
      "if (!result.success) throw new Error('FIXTURE_BUILD_FAILED');",
      "await Bun.write('dist/index.html', '<script type=module src=runtime.js></script>');",
    ].join('\n'));
    writeFileSync(join(runtime, 'ui/account-worker.ts'), 'export const worker = true;\n');
    writeFileSync(join(runtime, 'ui/runtime.ts'), "export const version = 'reviewed';\n");
    run(runtime, ['git', 'add', '.']);
    run(runtime, ['git', 'commit', '--quiet', '-m', 'reviewed']);
    const reviewed = run(runtime, ['git', 'rev-parse', 'HEAD']);
    writeFileSync(join(runtime, 'ui/runtime.ts'), "export const version = 'unreviewed';\n");
    run(runtime, ['git', 'commit', '--quiet', '-am', 'later main']);
    const latest = run(runtime, ['git', 'rev-parse', 'HEAD']);
    run(runtime, ['git', 'push', '--quiet', 'origin', 'main']);
    run(runtime, ['git', 'checkout', '--quiet', '--detach', reviewed]);
    const env = { ...process.env, XLN_MAIN_REPO: runtime, XLN_UI_TREE: wallet, BUN: process.execPath, XLN_UI_DEPLOY_SHA: '' };
    run(root, ['bash', deployScript], env);
    expect(run(wallet, ['git', 'rev-parse', 'HEAD'])).toBe(reviewed);
    expect(readFileSync(join(wallet, 'ui/dist/runtime.js'), 'utf8')).toContain('"reviewed"');
    expect(run(runtime, ['git', 'rev-parse', 'HEAD'])).toBe(reviewed);

    run(root, ['bash', deployScript], { ...env, XLN_UI_DEPLOY_SHA: latest });
    expect(run(wallet, ['git', 'rev-parse', 'HEAD'])).toBe(latest);
    const built = readFileSync(join(wallet, 'ui/dist/runtime.js'), 'utf8');
    writeFileSync(join(wallet, 'ui/unreviewed.ts'), 'export const unreviewed = true;\n');
    expect(() => run(root, ['bash', deployScript], env)).toThrow('UI_DEPLOY_UNTRACKED_SOURCE');
    expect(readFileSync(join(wallet, 'ui/dist/runtime.js'), 'utf8')).toBe(built);
    expect(run(wallet, ['git', 'rev-parse', 'HEAD'])).toBe(latest);
    rmSync(join(wallet, 'ui/unreviewed.ts'));
    writeFileSync(join(wallet, 'ui/runtime.ts'), "export const version = 'local-edit';\n");
    expect(() => run(root, ['bash', deployScript], env)).toThrow();
    expect(readFileSync(join(wallet, 'ui/dist/runtime.js'), 'utf8')).toBe(built);
    expect(run(wallet, ['git', 'rev-parse', 'HEAD'])).toBe(latest);
    expect(() => run(root, ['bash', deployScript], { ...env, XLN_UI_DEPLOY_SHA: 'main' }))
      .toThrow('UI_DEPLOY_EXACT_SHA_REQUIRED:main');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
