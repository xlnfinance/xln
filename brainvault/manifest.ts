#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const root = import.meta.dir;
const temp = mkdtempSync(join(tmpdir(), 'brainvault-manifest-'));
try {
  const packed = Bun.spawnSync({
    cmd: ['bun', 'pm', 'pack', '--ignore-scripts', '--destination', temp, '--quiet'],
    cwd: root,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (packed.exitCode !== 0) throw new Error(`BRAINVAULT_PACK_FAILED:${packed.stderr.toString()}`);
  const reported = packed.stdout.toString().trim();
  const tarball = isAbsolute(reported) ? reported : join(temp, reported);
  const listed = Bun.spawnSync({ cmd: ['tar', '-tzf', tarball], stderr: 'pipe', stdout: 'pipe' });
  if (listed.exitCode !== 0) throw new Error(`BRAINVAULT_TARBALL_LIST_FAILED:${listed.stderr.toString()}`);
  const paths = listed.stdout.toString().trim().split('\n')
    .filter(path => path.startsWith('package/') && path !== 'package/MANIFEST.sha256')
    .map(path => path.slice('package/'.length))
    .sort((left, right) => left.localeCompare(right, 'en'));
  const lines = paths.map(path => {
    const digest = new Bun.CryptoHasher('sha256').update(readFileSync(join(root, path))).digest('hex');
    return `${digest}  ${path}`;
  });
  writeFileSync(join(root, 'MANIFEST.sha256'), `${lines.join('\n')}\n`, { mode: 0o644 });
  console.log(`Wrote ${lines.length} package hashes to MANIFEST.sha256`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
