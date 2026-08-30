/**
 * Release gate for the Rust account engine.
 *
 * Two failure modes this closes: a checkout where the IPC/parity suites
 * silently skipped because the binary was absent, and a run that tested a
 * binary built from a different commit. The binary is rebuilt from the working
 * tree, its digest and the current SHA are printed, and the suites run with
 * skipping refused.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const ROOT = join(import.meta.dir, '../../../..');
const MANIFEST = join(ROOT, 'rscore/Cargo.toml');
const BINARY = join(ROOT, 'rscore/target/release/xlnrs');
const ENTITY_FIXTURE_GENERATOR = join(ROOT, 'rscore/fixtures/entity-kernel/generate.ts');
const ENTITY_FIXTURE = join(ROOT, 'rscore/fixtures/entity-kernel/parity-v1.json');
const testFilesUnder = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory()
    ? testFilesUnder(join(directory, entry.name))
    : entry.name.endsWith('.test.ts') ? [join(directory, entry.name)] : [])
  .sort();

const run = (command: string, args: readonly string[]): void => {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
};

const capture = (command: string, args: readonly string[]): string =>
  execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' }).trim();

run('cargo', ['build', '--release', '--manifest-path', MANIFEST, '--workspace']);
const generatedEntityFixture = capture('bun', [ENTITY_FIXTURE_GENERATOR]);
const committedEntityFixture = readFileSync(ENTITY_FIXTURE, 'utf8').trim();
if (generatedEntityFixture !== committedEntityFixture) {
  throw new Error('RSCORE_ENTITY_KERNEL_FIXTURE_DRIFT');
}
console.log('RSCORE_ENTITY_KERNEL_FIXTURE_EXACT');
const digest = createHash('sha256').update(readFileSync(BINARY)).digest('hex');
const sha = capture('git', ['rev-parse', 'HEAD']);
const dirty = capture('git', ['status', '--porcelain']).length > 0;
console.log(
  `RSCORE_BINARY sha=${sha}${dirty ? '+dirty' : ''} digest=${digest} ` +
  `bytes=${statSync(BINARY).size}`,
);

// The suites read XLN_RSCORE_REQUIRE_BINARY and throw instead of skipping.
// Bun can starve child-process stdout after the earlier differential corpus
// has run in the same test worker; its 5s timeout then kills healthy Rust
// children and cascades across every process test. A fresh Bun worker for the
// process boundary is deterministic and keeps the whole pair below two seconds.
const testFiles = [
  ...testFilesUnder(join(ROOT, 'tests/rscore')),
  ...testFilesUnder(join(ROOT, 'core/__tests__/rscore')),
];
const processSegment = `${sep}rscore${sep}process${sep}`;
run('bun', ['test', ...testFiles.filter(file => !file.includes(processSegment))]);
run('bun', ['test', ...testFiles.filter(file => file.includes(processSegment))]);
