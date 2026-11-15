import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { safeStringify } from '../../core/protocol/serialization';
import { git } from './git';

const project = resolve(import.meta.dir, '../..');
const commit = (root: string): void => {
  git(root, ['add', '.']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'verification fixture']);
};

const createFixture = (root: string, check: string, contracts: string, deployment: string): string => {
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Verification Test']);
  git(root, ['config', 'user.email', 'verification@example.invalid']);
  writeFileSync(
    join(root, 'package.json'),
    safeStringify({
      packageManager: 'bun@1.4.3',
      scripts: {
        check: 'bun check.ts',
        'test:contracts:full': 'bun contracts.ts',
        'check:deployment': 'bun deployment.ts',
      },
    }),
  );
  for (const [name, body] of Object.entries({ check, contracts, deployment }))
    writeFileSync(join(root, `${name}.ts`), body);
  writeFileSync(join(root, 'input.txt'), 'committed\n');
  commit(root);
  return root;
};

const copyGate = (root: string): void => {
  for (const path of [
    ...['git', 'install', 'pre-push', 'process', 'profile', 'verify'].map(name => `scripts/verification/${name}.ts`),
    'core/scripts/e2e/runners/process-group.ts',
    'core/protocol/serialization/index.ts',
    'core/protocol/serialization/base64.ts',
    'core/protocol/errors/failure-taxonomy.ts',
    'tools/release-snapshot/scope.ts',
    'tools/checks/check-environment.ts',
    '.githooks/pre-push',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(project, path), join(root, path));
  }
  chmodSync(join(root, '.githooks/pre-push'), 0o755);
  commit(root);
};

export const createVerificationFixtures = () => {
  const temporary = mkdtempSync(join(tmpdir(), 'xln-verification-'));
  let sequence = 0;
  const fixture = (
    check = 'console.log("fixture-check-output");',
    contracts = 'console.log("fixture-contracts-output");',
    deployment = 'console.log("fixture-deployment-output");',
  ): string => createFixture(join(temporary, `repo ${sequence++}`), check, contracts, deployment);
  return { temporary, project, fixture, copyGate, commit };
};
