import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type History = Readonly<{
  format: string;
  releases: ReadonlyArray<{ version: string; path: string; sha256: string }>;
}>;

test('every archived V1 package retains its immutable hash and frozen vectors', async () => {
  const history = await Bun.file(`${import.meta.dir}/historical-v1.json`).json() as History;
  expect(history.format).toBe('brainvault-historical-v1/1');
  for (const release of history.releases) {
    const tarball = `${import.meta.dir}/${release.path}`;
    const bytes = new Uint8Array(await Bun.file(tarball).arrayBuffer());
    const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    expect(actual).toBe(release.sha256);
    const temp = mkdtempSync(join(tmpdir(), `brainvault-v1-${release.version}-`));
    try {
      mkdirSync(join(temp, 'install'));
      writeFileSync(join(temp, 'install/package.json'), '{"private":true}\n');
      const added = Bun.spawnSync({
        cmd: ['bun', 'add', '--offline', '--exact', '--ignore-scripts', tarball],
        cwd: join(temp, 'install'),
        stderr: 'pipe',
        stdout: 'pipe',
      });
      if (added.exitCode !== 0) throw new Error(`BRAINVAULT_HISTORICAL_INSTALL_FAILED:${added.stderr.toString()}`);
      const vectors = Bun.spawnSync({
        cmd: ['bun', 'test', './node_modules/brainvault/core.test.ts'],
        cwd: join(temp, 'install'),
        stderr: 'pipe',
        stdout: 'pipe',
      });
      if (vectors.exitCode !== 0) {
        throw new Error(`BRAINVAULT_HISTORICAL_VECTOR_FAILED:${vectors.stderr.toString()}\n${vectors.stdout.toString()}`);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
}, 28_000);
