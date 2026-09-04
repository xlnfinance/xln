import { expect, test } from 'bun:test';
import { join } from 'node:path';

const PACKAGE_ROOT = join(import.meta.dir, '..');
type History = Readonly<{
  format: string;
  releases: ReadonlyArray<{
    version: string;
    path: string;
    sha256: string;
    artifacts: Readonly<Record<string, string>>;
  }>;
}>;

test('every archived V1 package retains its immutable hash and frozen vectors', async () => {
  const history = await Bun.file(`${PACKAGE_ROOT}/tests/data/historical-v1.json`).json() as History;
  expect(history.format).toBe('brainvault-historical-v1/1');
  for (const release of history.releases) {
    const tarball = `${PACKAGE_ROOT}/${release.path}`;
    const bytes = new Uint8Array(await Bun.file(tarball).arrayBuffer());
    const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    expect(actual).toBe(release.sha256);
    const listed = Bun.spawnSync({ cmd: ['tar', '-tzf', tarball], stderr: 'pipe', stdout: 'pipe' });
    expect(listed.exitCode).toBe(0);
    const paths = listed.stdout.toString().trim().split('\n');
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(path.startsWith('/')).toBe(false);
      expect(path.split('/')).not.toContain('..');
    }
    for (const [artifact, expected] of Object.entries(release.artifacts)) {
      expect(paths).toContain(artifact);
      const extracted = Bun.spawnSync({
        cmd: ['tar', '-xOzf', tarball, artifact], stderr: 'pipe', stdout: 'pipe',
      });
      expect(extracted.exitCode).toBe(0);
      const digest = new Bun.CryptoHasher('sha256').update(extracted.stdout).digest('hex');
      expect(digest).toBe(expected);
    }
  }
}, 28_000);
