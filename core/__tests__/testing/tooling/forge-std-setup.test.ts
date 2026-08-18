import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const setup = readFileSync('jurisdictions/scripts/setup-forge-std.sh', 'utf8');
const contractsPackage = JSON.parse(readFileSync('jurisdictions/package.json', 'utf8')) as {
  scripts: Record<string, string>;
};

test('forge-std setup installs and verifies one immutable upstream commit', () => {
  expect(contractsPackage.scripts['forge:setup']).toBe('bash scripts/setup-forge-std.sh');
  expect(setup).toContain("readonly FORGE_STD_REPOSITORY='https://github.com/foundry-rs/forge-std.git'");
  expect(setup).toContain("readonly FORGE_STD_COMMIT='8e40513d678f392f398620b3ef2b418648b33e89'");
  expect(setup).toContain('fetch --quiet --depth 1 origin "$FORGE_STD_COMMIT"');
  expect(setup).toContain('checkout --quiet --detach "$FORGE_STD_COMMIT"');
  expect(setup).toContain("rev-parse --verify 'HEAD^{commit}'");
  expect(setup).toContain('[ "$head" = "$FORGE_STD_COMMIT" ]');
  expect(setup).not.toContain('--branch v1.11.0');
  expect(setup).not.toContain('rm -rf lib/forge-std/.git');
});

test('forge-std setup rejects unverifiable, wrong, or dirty tracked checkouts', () => {
  expect(setup).toContain('FORGE_STD_CHECKOUT_UNVERIFIABLE');
  expect(setup).toContain('[ -e "$checkout_dir/.git" ]');
  expect(setup).toContain('rev-parse --show-toplevel');
  expect(setup).toContain('FORGE_STD_CHECKOUT_ROOT_MISMATCH');
  expect(setup).toContain('FORGE_STD_ORIGIN_MISMATCH');
  expect(setup).toContain('FORGE_STD_HEAD_MISMATCH');
  expect(setup).toContain('diff --quiet --ignore-submodules --');
  expect(setup).toContain('FORGE_STD_TRACKED_WORKTREE_DIRTY');
  expect(setup).toContain('diff --cached --quiet --ignore-submodules --');
  expect(setup).toContain('FORGE_STD_TRACKED_INDEX_DIRTY');
  expect(setup).toContain('ls-files --others --exclude-standard');
  expect(setup).toContain('FORGE_STD_UNTRACKED_FILES');
  expect(setup).toContain('FORGE_STD_CHECKOUT_SYMLINK_FORBIDDEN');
});
