/** Build the working candidate in two real checkouts with independent dependencies/caches. */
import { constants, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../../..');
const temporary = mkdtempSync(join(tmpdir(), 'xln-contract-reproducibility-'));
const clone = join(temporary, 'checkout with spaces');
const artifacts = ['jurisdictions/artifacts', 'frontend/static/contracts', 'jurisdictions/typechain-types'];

function run(command: string[], cwd = root): string {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'inherit' });
  const output = result.stdout.toString();
  if (result.exitCode !== 0) throw new Error(`CONTRACT_REPRODUCIBILITY_COMMAND_FAILED:${command.join(' ')}\n${output}`);
  return output;
}

function prepareClone(): void {
  run(['git', 'clone', '--local', '--no-hardlinks', root, clone]);
  run(['git', 'checkout', '-B', 'main', 'HEAD'], clone);
  // Include the exact uncommitted candidate, including added/deleted build tooling.
  const changed = run(['git', 'diff', '--name-only', '-z', 'HEAD']);
  const added = run(['git', 'ls-files', '--others', '--exclude-standard', '-z']);
  for (const path of new Set(`${changed}${added}`.split('\0').filter(Boolean))) {
    rmSync(join(clone, path), { recursive: true, force: true });
    if (existsSync(join(root, path))) cpSync(join(root, path), join(clone, path), { recursive: true, verbatimSymlinks: true });
  }
  // Copy rather than symlink: dependency realpaths must differ between builds.
  for (const path of ['node_modules', 'jurisdictions/lib']) {
    if (existsSync(join(root, path))) {
      cpSync(join(root, path), join(clone, path), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    }
  }
}

function build(checkout: string): void {
  // A verified sync cache hit cannot test compiler-input reproducibility.
  rmSync(join(checkout, '.tmp/contracts-sync-input.sha256'), { force: true });
  console.log(run(['bun', 'run', 'contracts:sync'], checkout));
}

function buildIds(checkout: string): string[] {
  const directory = join(checkout, 'jurisdictions/artifacts/build-info');
  const ids = readdirSync(directory).filter(name => name.endsWith('.json') && !name.endsWith('.output.json'))
    .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')).id as string).sort();
  if (ids.length === 0) throw new Error('CONTRACT_BUILD_INFO_MISSING');
  return ids;
}

try {
  prepareClone();
  build(root);
  build(clone);
  const ids = buildIds(root);
  if (JSON.stringify(ids) !== JSON.stringify(buildIds(clone))) throw new Error('CONTRACT_BUILD_INFO_ID_DRIFT');
  for (const path of artifacts) run(['diff', '-qr', join(root, path), join(clone, path)]);
  console.log(`CONTRACT_ARTIFACT_REPRODUCIBILITY_OK checkouts=2 trees=${artifacts.length} ids=${ids.join(',')}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
