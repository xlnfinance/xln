import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { verifyBundledExecutable, verifyBundledFile } from './binary-integrity.ts';
import { acceleratorPlan } from './native-hybrid.ts';

test('bundled-file verification rejects symlink path aliases', () => {
  const temp = mkdtempSync(join(tmpdir(), 'brainvault-integrity-'));
  try {
    const target = join(temp, 'target.bin');
    const alias = join(temp, 'expected.bin');
    const bytes = Buffer.from('audited binary');
    writeFileSync(target, bytes, { mode: 0o644 });
    const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    writeFileSync(join(temp, 'MANIFEST.sha256'), `${digest}  target.bin\n`, { mode: 0o644 });
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
    writeFileSync(join(temp, 'MANIFEST.sha256'), `${digest}  expected.bin\n`, { mode: 0o600 });
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
      cwd: import.meta.dir,
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
    const packageJson = JSON.parse(readFileSync(`${import.meta.dir}/package.json`, 'utf8')) as {
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
    expect(files).toContain('package/MANIFEST.sha256');
    expect(files).toContain('package/AGENTS.md');
    expect(files).toContain('package/SPEC-V1.md');
    expect(files).toContain('package/vectors-v1.json');
    expect(files).toContain('package/dependency-lock.audit');
    const dependencyLock = readFileSync(`${import.meta.dir}/dependency-lock.audit`);
    if (existsSync(`${import.meta.dir}/bun.lock`)) {
      expect(dependencyLock).toEqual(readFileSync(`${import.meta.dir}/bun.lock`));
    }
    const dependencyLockHash = new Bun.CryptoHasher('sha256').update(dependencyLock).digest('hex');
    const manifest = readFileSync(`${import.meta.dir}/MANIFEST.sha256`, 'utf8');
    expect(manifest).toContain(`${dependencyLockHash}  dependency-lock.audit\n`);
    if (files.includes('package/experimental/argon2-opencl/COPYING-GPL-2.0-or-later')) {
      expect(packageJson.license).toContain('GPL-2.0-or-later');
    }
    expect(files).toContain('package/media/brainvault-terminal-demo.mp4');
    expect(files).toContain('package/experimental/argon2-rust/vendor/argon2-rust/.cargo-checksum.json');
    for (const testFile of packageJson.scripts['test']?.match(/[\w/-]+\.test\.ts/g) ?? []) {
      expect(files).toContain(`package/${testFile}`);
    }
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(files).toContain('package/prebuilds/darwin-arm64/brainvault-argon2');
      expect(files).toContain('package/prebuilds/darwin-arm64/brainvault-argon2-m3');
      expect(files).toContain('package/prebuilds/darwin-arm64/brainvault-argon2-rust');
      expect(files).toContain('package/prebuilds/darwin-arm64/brainvault-argon2-rust-m3');
      expect(files).toContain('package/prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe');
      expect(files).toContain('package/prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe-m3');
      expect(files).toContain('package/prebuilds/darwin-arm64/brainvault-argon2-metal');
      expect(files).toContain('package/prebuilds/darwin-arm64/argon2.metallib');
      expect(files).toContain('package/prebuilds/darwin-arm64/brainvault-argon2-opencl');
      expect(files).toContain('package/experimental/argon2-opencl/data/kernels/argon2_kernel.cl');
    }
    expect(files.some(path => path.includes('node_modules/'))).toBe(false);
    expect(files.some(path => path.includes('experimental/results/'))).toBe(false);
    expect(files.some(path => path.includes('/target/'))).toBe(false);
    expect(files.some(path => /\/target(?:-|\/)/.test(path))).toBe(false);

    const manifestPaths = new Set(manifest
      .trim().split('\n').map(line => line.match(/^[0-9a-f]{64}  (.+)$/)?.[1]));
    for (const path of files) {
      if (path === 'package/MANIFEST.sha256') continue;
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
    expect(installed.scripts?.['verify:source']).toBe('bun test native-build.test.ts');
    for (const executable of [
      'brainvault',
      'prebuilds/darwin-arm64/brainvault-argon2',
      'prebuilds/darwin-arm64/brainvault-argon2-m3',
      'prebuilds/darwin-arm64/brainvault-argon2-metal',
      'prebuilds/darwin-arm64/brainvault-argon2-opencl',
      'prebuilds/darwin-arm64/brainvault-argon2-rust',
      'prebuilds/darwin-arm64/brainvault-argon2-rust-m3',
      'prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe',
      'prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe-m3',
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
    if (existsSync(`${import.meta.dir}/bun.lock`)) {
      const installedPackageTest = Bun.spawnSync({
        cmd: ['bun', 'test', 'package.test.ts'],
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
  const metal = readFileSync(`${import.meta.dir}/experimental/argon2-metal/README.md`, 'utf8');
  expect(metal).toContain('640 shards to Metal and 360 to C/NEON');
  expect(metal).toMatch(/eight Metal\s+processes with 40 workers each/);
  expect(metal).toMatch(/8,000 Metal \/\s+2,000 C\/NEON/);
  expect(metal).not.toContain('588 shards to Metal and 412 to C/NEON');
  expect(metal).not.toContain('147 workers in each of two Metal processes');
  const experimental = readFileSync(`${import.meta.dir}/experimental/README.md`, 'utf8');
  expect(experimental).toMatch(/source-only\s+`experimental\/results\/m3-ultra-re-audit-2026-09-03\.md`/);
  expect(experimental).toMatch(/Raw run output and prior model-review notes are source-only under\s+`experimental\/results\/`/);
});
