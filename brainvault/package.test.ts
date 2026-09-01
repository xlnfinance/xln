import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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
    expect(files).toContain('package/SPEC-V1.md');
    expect(files).toContain('package/vectors-v1.json');
    expect(files.some(path => path.includes('node_modules/'))).toBe(false);
    expect(files.some(path => path.includes('experimental/results/'))).toBe(false);
    expect(files.some(path => path.includes('/target/'))).toBe(false);

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
