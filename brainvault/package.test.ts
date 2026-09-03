import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { verifyBundledFile } from './binary-integrity.ts';

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
    const packageJson = JSON.parse(readFileSync(`${import.meta.dir}/package.json`, 'utf8')) as { files: string[] };
    const exactAllowlist = new Set(packageJson.files.filter(path => !path.endsWith('/')).map(path => `package/${path}`));
    const prefixAllowlist = packageJson.files.filter(path => path.endsWith('/')).map(path => `package/${path}`);
    exactAllowlist.add('package/package.json');
    for (const path of files) {
      expect(path.startsWith('package/')).toBe(true);
      expect(path.split('/')).not.toContain('..');
      expect(exactAllowlist.has(path) || prefixAllowlist.some(prefix => path.startsWith(prefix))).toBe(true);
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
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(files).toContain('package/prebuilds/darwin-arm64/brainvault-argon2-metal');
      expect(files).toContain('package/prebuilds/darwin-arm64/argon2.metallib');
      expect(files).toContain('package/prebuilds/darwin-arm64/brainvault-argon2-opencl');
      expect(files).toContain('package/experimental/argon2-opencl/data/kernels/argon2_kernel.cl');
    }
    expect(files.some(path => path.includes('node_modules/'))).toBe(false);
    expect(files.some(path => path.includes('experimental/results/'))).toBe(false);
    expect(files.some(path => path.includes('/target/'))).toBe(false);

    const manifestPaths = new Set(readFileSync(`${import.meta.dir}/MANIFEST.sha256`, 'utf8')
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
    for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) {
      expect(installed.scripts?.[lifecycle]).toBeUndefined();
    }
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
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 28_000);
