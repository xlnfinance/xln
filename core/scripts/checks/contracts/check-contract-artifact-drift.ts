/** Check regeneration drift against the working artifacts, including an uncommitted candidate. */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../../..');
const snapshot = mkdtempSync(join(tmpdir(), 'xln-contract-artifacts-'));
const paths = ['frontend/static/contracts', 'jurisdictions/typechain-types'];
try {
  for (const [index, path] of paths.entries()) cpSync(join(root, path), join(snapshot, String(index)), { recursive: true });
  const generation = Bun.spawnSync(['bun', 'run', 'contracts:sync'], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] });
  if (generation.exitCode !== 0) throw new Error(`CONTRACT_ARTIFACT_GENERATION_FAILED:${generation.exitCode}`);
  for (const [index, path] of paths.entries()) {
    const comparison = Bun.spawnSync(['diff', '-qr', join(snapshot, String(index)), join(root, path)], { stdout: 'pipe', stderr: 'pipe' });
    if (comparison.exitCode !== 0) throw new Error(`CONTRACT_ARTIFACT_DRIFT:${path}\n${comparison.stdout.toString()}${comparison.stderr.toString()}`);
  }
  console.log('CONTRACT_ARTIFACT_DRIFT_OK: regeneration exactly matches working artifacts');
} finally {
  rmSync(snapshot, { recursive: true, force: true });
}
