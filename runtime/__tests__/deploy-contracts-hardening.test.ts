import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../..');

test('local contract deployment waits for Ignition finality without duplicate generators', () => {
  const deploy = readFileSync(resolve(repoRoot, 'deploy-contracts.sh'), 'utf8');

  expect(deploy).toContain('wait_for_confirmations "$port" 6');
  expect(deploy).toContain('bunx hardhat compile --force');
  expect(deploy).toContain('bunx hardhat test test/EntityProvider* --network hardhat');
  expect(deploy).not.toMatch(/\bnpx\b/);
  expect(deploy).not.toContain('xargs -0');
  expect(deploy).not.toMatch(/\btypechain\s+--target\b/);
});

test('local deployment outputs and Ignition state stay untracked', () => {
  const gitignore = readFileSync(resolve(repoRoot, '.gitignore'), 'utf8');

  expect(gitignore).toContain('/jurisdictions.json');
  expect(gitignore).toContain('/frontend/static/jurisdictions.json');
  expect(gitignore).toContain('jurisdictions/ignition/deployments/chain-1337/');
});
