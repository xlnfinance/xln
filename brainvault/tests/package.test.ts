import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { verifyBundledExecutable, verifyBundledFile } from '../src/packaging/binary-integrity.ts';
import { acceleratorPlan } from '../src/native/hybrid.ts';

const PACKAGE_ROOT = join(import.meta.dir, '..');

test('bundled-file verification rejects symlink path aliases', () => {
  const temp = mkdtempSync(join(tmpdir(), 'brainvault-integrity-'));
  try {
    const target = join(temp, 'target.bin');
    const alias = join(temp, 'expected.bin');
    const bytes = Buffer.from('audited binary');
    writeFileSync(target, bytes, { mode: 0o644 });
    const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    mkdirSync(join(temp, 'docs'));
    writeFileSync(join(temp, 'docs/manifest.sha256'), `${digest}  target.bin\n`, { mode: 0o644 });
    symlinkSync('target.bin', alias);
    expect(() => verifyBundledFile(alias, temp)).toThrow('BRAINVAULT_BINARY_NOT_REGULAR');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('bundled executable verification rejects a non-executable file', () => {
  const temp = mkdtempSync(join(tmpdir(), 'brainvault-executable-'));
  try {
    const executable = join(temp, 'expected.bin');
    const bytes = Buffer.from('audited binary');
    writeFileSync(executable, bytes, { mode: 0o600 });
    const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    mkdirSync(join(temp, 'docs'));
    writeFileSync(join(temp, 'docs/manifest.sha256'), `${digest}  expected.bin\n`, { mode: 0o600 });
    expect(() => verifyBundledExecutable(executable, temp)).toThrow('BRAINVAULT_BINARY_NOT_EXECUTABLE');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('packed package installs inertly and runs from an audited empty directory', () => {
  const temp = mkdtempSync(join(tmpdir(), 'brainvault-package-'));
  try {
    const packed = Bun.spawnSync({
      cmd: ['bun', 'pm', 'pack', '--ignore-scripts', '--destination', temp, '--quiet'],
      cwd: PACKAGE_ROOT,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    if (packed.exitCode !== 0) throw new Error(`BRAINVAULT_PACK_FAILED:${packed.stderr.toString()}`);
    const packedPath = packed.stdout.toString().trim();
    const tarball = isAbsolute(packedPath) ? packedPath : join(temp, packedPath);
    const listed = Bun.spawnSync({ cmd: ['tar', '-tzf', tarball], stderr: 'pipe', stdout: 'pipe' });
    if (listed.exitCode !== 0) {
      throw new Error(`BRAINVAULT_TARBALL_LIST_FAILED:${tarball}:${listed.stderr.toString()}:pack=${packed.stdout.toString()}`);
    }
    const files = listed.stdout.toString().trim().split('\n');
    expect(new Set(files).size).toBe(files.length);
    const packageJson = JSON.parse(readFileSync(`${PACKAGE_ROOT}/package.json`, 'utf8')) as {
      files: string[];
      license: string;
      scripts: Record<string, string>;
    };
    const exactAllowlist = new Set(packageJson.files.filter(path => !path.endsWith('/')).map(path => `package/${path}`));
    const prefixAllowlist = packageJson.files.filter(path => path.endsWith('/')).map(path => `package/${path}`);
    exactAllowlist.add('package/package.json');
    for (const path of files) {
      expect(path.startsWith('package/')).toBe(true);
      expect(path.split('/')).not.toContain('..');
      expect(exactAllowlist.has(path) || prefixAllowlist.some(prefix => path.startsWith(prefix))).toBe(true);
    }
    for (const path of packageJson.files.filter(path => !path.endsWith('/'))) {
      expect(files).toContain(`package/${path}`);
    }
    const verbose = Bun.spawnSync({ cmd: ['tar', '-tvzf', tarball], stderr: 'pipe', stdout: 'pipe' });
    expect(verbose.exitCode).toBe(0);
    for (const line of verbose.stdout.toString().trim().split('\n')) {
      expect(['l', 'h'].includes(line[0] ?? '')).toBe(false);
    }
    expect(files).toContain('package/docs/manifest.sha256');
    expect(files).toContain('package/AGENTS.md');
    expect(files).toContain('package/docs/spec-v1.md');
    expect(files).toContain('package/tests/data/vectors-v1.json');
    expect(files).toContain('package/docs/dependency-lock.audit');
    const dependencyLock = readFileSync(`${PACKAGE_ROOT}/docs/dependency-lock.audit`);
    if (existsSync(`${PACKAGE_ROOT}/bun.lock`)) {
      expect(dependencyLock).toEqual(readFileSync(`${PACKAGE_ROOT}/bun.lock`));
    }
    const dependencyLockHash = new Bun.CryptoHasher('sha256').update(dependencyLock).digest('hex');
    const manifest = readFileSync(`${PACKAGE_ROOT}/docs/manifest.sha256`, 'utf8');
    expect(manifest).toContain(`${dependencyLockHash}  docs/dependency-lock.audit\n`);
    if (files.includes('package/src/native/source/opencl/COPYING-GPL-2.0-or-later')) {
      expect(packageJson.license).toContain('GPL-2.0-or-later');
    }
    expect(files).toContain('package/docs/media/brainvault-terminal-demo.mp4');
    expect(files).toContain('package/src/native/source/rust/vendor/argon2-rust/.cargo-checksum.json');
    for (const testFile of packageJson.scripts['test']?.match(/[\w/-]+\.test\.ts/g) ?? []) {
      expect(files).toContain(`package/${testFile}`);
    }
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(files).toContain('package/src/native/prebuilds/darwin-arm64/brainvault-argon2');
      expect(files).toContain('package/src/native/prebuilds/darwin-arm64/brainvault-argon2-m3');
      expect(files).toContain('package/src/native/prebuilds/darwin-arm64/brainvault-argon2-rust');
      expect(files).toContain('package/src/native/prebuilds/darwin-arm64/brainvault-argon2-rust-m3');
      expect(files).toContain('package/src/native/prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe');
      expect(files).toContain('package/src/native/prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe-m3');
      expect(files).toContain('package/src/native/prebuilds/darwin-arm64/brainvault-argon2-metal');
      expect(files).toContain('package/src/native/prebuilds/darwin-arm64/argon2.metallib');
      expect(files).toContain('package/src/native/prebuilds/darwin-arm64/brainvault-argon2-opencl');
      expect(files).toContain('package/src/native/source/opencl/data/kernels/argon2_kernel.cl');
    }
    expect(files.some(path => path.includes('node_modules/'))).toBe(false);
    expect(files.some(path => path.includes('docs/evidence/'))).toBe(false);
    expect(files.some(path => path.includes('/target/'))).toBe(false);
    expect(files.some(path => /\/target(?:-|\/)/.test(path))).toBe(false);

    const manifestPaths = new Set(manifest
      .trim().split('\n').map(line => line.match(/^[0-9a-f]{64}  (.+)$/)?.[1]));
    for (const path of files) {
      if (path === 'package/docs/manifest.sha256') continue;
      expect(manifestPaths.has(path.slice('package/'.length))).toBe(true);
    }

    const install = join(temp, 'install');
    mkdirSync(install);
    writeFileSync(join(install, 'package.json'), '{"private":true}\n');
    const added = Bun.spawnSync({
      cmd: ['bun', 'add', '--offline', '--exact', '--ignore-scripts', tarball],
      cwd: install,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    if (added.exitCode !== 0) throw new Error(`BRAINVAULT_INSTALL_FAILED:${added.stderr.toString()}`);
    const installed = JSON.parse(readFileSync(join(install, 'node_modules/brainvault/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const installedRoot = join(install, 'node_modules/brainvault');
    for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) {
      expect(installed.scripts?.[lifecycle]).toBeUndefined();
    }
    expect(installed.scripts?.['verify:source']).toBe('bun test tests/native-build.test.ts');
    for (const executable of [
      'brainvault',
      'src/native/prebuilds/darwin-arm64/brainvault-argon2',
      'src/native/prebuilds/darwin-arm64/brainvault-argon2-m3',
      'src/native/prebuilds/darwin-arm64/brainvault-argon2-metal',
      'src/native/prebuilds/darwin-arm64/brainvault-argon2-opencl',
      'src/native/prebuilds/darwin-arm64/brainvault-argon2-rust',
      'src/native/prebuilds/darwin-arm64/brainvault-argon2-rust-m3',
      'src/native/prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe',
      'src/native/prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe-m3',
    ]) verifyBundledExecutable(join(installedRoot, executable), installedRoot);
    const help = Bun.spawnSync({
      cmd: ['bun', 'node_modules/brainvault/brainvault', '--help'],
      cwd: install,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toStartWith('BrainVault v1 (bv)');
    const smoke = Bun.spawnSync({
      cmd: ['bun', 'node_modules/brainvault/brainvault', '--smoke', '--workers', '2'],
      cwd: install,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    if (smoke.exitCode !== 0) throw new Error(`BRAINVAULT_PACKED_SMOKE_FAILED:${smoke.stderr.toString()}\n${smoke.stdout.toString()}`);
    expect(smoke.stdout.toString()).toContain('Root parity: PASS');
    if (existsSync(`${PACKAGE_ROOT}/bun.lock`)) {
      const installedPackageTest = Bun.spawnSync({
        cmd: ['bun', 'test', 'tests/package.test.ts'],
        cwd: installedRoot,
        stderr: 'pipe',
        stdout: 'pipe',
      });
      if (installedPackageTest.exitCode !== 0) {
        throw new Error(`BRAINVAULT_INSTALLED_PACKAGE_TEST_FAILED:${installedPackageTest.stderr.toString()}\n${installedPackageTest.stdout.toString()}`);
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 45_000);

test('shipped experimental documentation matches the production Metal plan and labels source-only evidence', () => {
  const gib = 1024 ** 3;
  const thousand = acceleratorPlan('metal', 1_000, 32, 32, 512 * gib);
  const defaultWork = acceleratorPlan('metal', 10_000, 32, 32, 512 * gib);
  expect(thousand).toEqual({
    cpuShards: 360,
    cpuWorkers: 32,
    acceleratorShards: 640,
    acceleratorWorkers: 40,
    acceleratorProcesses: 8,
  });
  expect(defaultWork).toEqual({
    cpuShards: 2_000,
    cpuWorkers: 32,
    acceleratorShards: 8_000,
    acceleratorWorkers: 40,
    acceleratorProcesses: 8,
  });
  const metal = readFileSync(`${PACKAGE_ROOT}/src/native/source/metal/README.md`, 'utf8');
  expect(metal).toContain('640 shards to Metal and 360 to C/NEON');
  expect(metal).toMatch(/eight Metal\s+processes with 40 workers each/);
  expect(metal).toMatch(/8,000 Metal \/\s+2,000 C\/NEON/);
  expect(metal).not.toContain('588 shards to Metal and 412 to C/NEON');
  expect(metal).not.toContain('147 workers in each of two Metal processes');
  expect(metal).not.toContain('may fall back to C/NEON');
  const experimental = readFileSync(`${PACKAGE_ROOT}/src/native/source/README.md`, 'utf8');
  expect(experimental).toContain('docs/evidence/audits/m3-ultra-re-audit-2026-09-03.md');
  expect(experimental).toContain('docs/evidence/');
  const readme = readFileSync(`${PACKAGE_ROOT}/README.md`, 'utf8');
  expect(readme).not.toContain('accelerator failure falls back');
  expect(readme).not.toContain('safe fallbacks are automatic');
  expect(readme).toContain("from './src/core/index.ts'");
  expect(readme).toContain('bun test tests/core.test.ts');
  expect(readme).toMatch(/`--reveal` requests an early\s+sensitive-terminal capability check/);
});

test('published benchmark math and every audit-surface size cannot drift', () => {
  const experimental = readFileSync(`${PACKAGE_ROOT}/src/native/source/README.md`, 'utf8');
  const table = experimental.slice(experimental.indexOf('## 32-worker results'));
  const rows = [...table.matchAll(
    /^\| .*? \| \*{0,2}([\d.]+) s\*{0,2} \| \*{0,2}[\d.]+\*{0,2} \| \*{0,2}([\d.]+)x\*{0,2} \|$/gm,
  )];
  expect(rows).toHaveLength(8);
  for (const row of rows) {
    expect(row[2]).toBe((15.335 / Number(row[1])).toFixed(2));
  }

  const countLines = (paths: readonly string[]) => paths.reduce(
    (total, path) => total + readFileSync(`${PACKAGE_ROOT}/${path}`, 'utf8').split('\n').length - 1,
    0,
  );
  const canonicalPaths = ['src/core/primitives/spec.ts', 'src/core/primitives/kdf.ts', 'src/core/canonical.ts'];
  const canonicalLines = countLines(canonicalPaths);
  const walletLines = canonicalLines + countLines(['src/core/primitives/encoding.ts', 'src/core/index.ts']);
  const cliLines = countLines(['src/cli/index.ts', 'src/cli/policy.ts', 'src/cli/presets.ts', 'src/cli/suggestion.ts']);
  const nativeLines = countLines([
    'src/native/index.ts', 'src/native/hybrid.ts', 'src/native/shard-collector.ts',
    'src/native/children.ts', 'src/native/progress.ts', 'src/native/workers/browser.ts',
    'src/native/workers/native.ts', 'src/native/workers/sync.ts', 'src/native/workers/wasm.ts',
  ]);
  const packagingLines = countLines([
    'src/packaging/binary-integrity.ts', 'src/packaging/manifest.ts', 'src/packaging/normalize-macho.ts',
  ]);
  const metalLines = countLines([
    'src/native/source/metal/brainvault_argon2_metal.m', 'src/native/source/metal/argon2.metal',
  ]);
  const cBridgeLines = countLines(['src/native/source/c/brainvault_argon2.c']);
  const cUpstreamLines = countLines([
    'src/native/source/c/vendor/argon2/src/argon2.c', 'src/native/source/c/vendor/argon2/src/core.c',
    'src/native/source/c/vendor/argon2/src/blake2/blake2b.c', 'src/native/source/c/vendor/argon2/src/thread.c',
    'src/native/source/c/vendor/argon2/src/encoding.c', 'src/native/source/c/vendor/argon2/src/opt.c',
    'src/native/source/c/compat/emmintrin.h', 'src/native/source/c/vendor/sse2neon/sse2neon.h',
    'src/native/source/c/vendor/argon2/include/argon2.h', 'src/native/source/c/vendor/argon2/src/core.h',
    'src/native/source/c/vendor/argon2/src/encoding.h', 'src/native/source/c/vendor/argon2/src/thread.h',
    'src/native/source/c/vendor/argon2/src/blake2/blake2.h',
    'src/native/source/c/vendor/argon2/src/blake2/blake2-impl.h',
    'src/native/source/c/vendor/argon2/src/blake2/blamka-round-opt.h',
    'src/native/source/c/vendor/argon2/src/blake2/blamka-round-ref.h',
  ]);
  const readme = readFileSync(`${PACKAGE_ROOT}/README.md`, 'utf8');
  const audit = readFileSync(`${PACKAGE_ROOT}/docs/audit.md`, 'utf8');
  for (const [value, label] of [
    [canonicalLines, 'root'], [walletLines, 'wallet'], [cliLines, 'CLI'], [nativeLines, 'native'],
    [packagingLines, 'packaging'], [metalLines, 'Metal'], [cBridgeLines, 'C bridge'],
    [cUpstreamLines, 'upstream C'],
  ] as const) {
    expect(`${readme}\n${audit}`, `${label} line count`).toContain(value.toLocaleString('en-US'));
  }
});

test('native source verification fails instead of passing vacuously on unsupported hosts', () => {
  const verifier = readFileSync(`${PACKAGE_ROOT}/tests/native-build.test.ts`, 'utf8');
  expect(verifier).toContain('BRAINVAULT_NATIVE_BUILD_HOST_UNSUPPORTED');
  expect(verifier).not.toContain("if (process.platform !== 'darwin' || process.arch !== 'arm64') return;");
});

test('first-party directories expose at most ten entries each', () => {
  const directories = [
    '.', 'src', 'src/core', 'src/core/primitives', 'src/cli', 'src/native',
    'src/native/workers', 'src/native/source', 'src/packaging', 'tests',
    'tests/data', 'tests/fixtures', 'docs', 'docs/evidence',
    'docs/evidence/audits', 'docs/evidence/releases', 'docs/evidence/benchmarks',
    'docs/evidence/benchmarks/cli', 'docs/evidence/benchmarks/baseline',
    'docs/evidence/benchmarks/c-neon', 'docs/evidence/benchmarks/node',
    'docs/evidence/benchmarks/rust', 'docs/evidence/benchmarks/gpu', 'site', 'site/assets',
  ];
  for (const directory of directories) {
    const path = join(PACKAGE_ROOT, directory);
    if (!existsSync(path)) continue;
    const entries = readdirSync(path)
      .filter(entry => !entry.startsWith('.') && entry !== 'node_modules');
    expect(entries.length, `${directory}: ${entries.join(', ')}`).toBeLessThanOrEqual(10);
  }
});
