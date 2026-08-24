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
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../../..');
const MANIFEST = join(ROOT, 'rscore/Cargo.toml');
const BINARY = join(ROOT, 'rscore/target/release/xln-rscore');
const SUITES = ['tests/rscore', 'core/__tests__/rscore'];

const run = (command: string, args: readonly string[]): void => {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
};

const capture = (command: string, args: readonly string[]): string =>
  execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' }).trim();

run('cargo', ['build', '--release', '--manifest-path', MANIFEST, '--workspace']);
const digest = createHash('sha256').update(readFileSync(BINARY)).digest('hex');
const sha = capture('git', ['rev-parse', 'HEAD']);
const dirty = capture('git', ['status', '--porcelain']).length > 0;
console.log(
  `RSCORE_BINARY sha=${sha}${dirty ? '+dirty' : ''} digest=${digest} ` +
  `bytes=${statSync(BINARY).size}`,
);

// The suites read XLN_RSCORE_REQUIRE_BINARY and throw instead of skipping.
run('bun', ['test', ...SUITES]);
