import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const checker = resolve('core/scripts/checks/policy/check-no-legacy.ts');
const validation = 'core/__tests__/orchestrator/stack-manager-validation.test.ts';
const providerUrls = [
  'https://eth-sepolia.g.alchemy.com/v2/EXAMPLE_API_KEY',
  'https://sepolia.infura.io/v3/EXAMPLE_API_KEY',
];
const scanRoots = [
  '.github',
  'cli',
  'custody',
  'debates',
  'frontend/src',
  'jurisdictions',
  'native',
  'ops',
  'packages',
  'release',
  'core',
  'scripts',
  'tests',
  'tools',
  'ui/src',
];

const checkFiles = (files: Readonly<Record<string, string>>) => {
  const root = mkdtempSync(join(tmpdir(), 'xln-source-vocabulary-'));
  try {
    for (const path of scanRoots) {
      mkdirSync(join(root, path), { recursive: true });
    }
    for (const [path, source] of Object.entries(files)) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    const result = Bun.spawnSync([process.execPath, checker], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('does not decode sealed compiler snapshots as active source', () => {
  const result = checkFiles({
    'jurisdictions/ignition/deployments/public-stack/manifest.json.artifacts/build-info/compiler.json':
      '{"upstreamSource":"legacy fallback"}',
  });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain('NO_LEGACY_OK files=0');
});

test.each([
  'jurisdictions/ignition/deployments-extra/source.ts',
  'jurisdictions/ignition/modules/stack.ts',
  'jurisdictions/scripts/deployment/source.ts',
  'core/jurisdictions/ignition/deployments/source.ts',
  'core/active-source.ts',
])('still rejects forbidden vocabulary in active source: %s', path => {
  const result = checkFiles({ [path]: 'export const legacyReader = true;\n' });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`${path}:1:`);
});

test.each(providerUrls)('accepts the exact provider-owned credential-rejection fixture: %s', rpcUrl => {
  const result = checkFiles({ [validation]: `  '${rpcUrl}',\n` });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain('NO_LEGACY_OK files=1');
});

test('does not grant a provider URL exemption to another source file', () => {
  const path = 'core/unapproved-url.ts';
  const result = checkFiles({ [path]: `export const rpcUrl = '${providerUrls[0]}';\n` });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`${path}:1:`);
});

test('still rejects a separate forbidden line in the permitted test file', () => {
  const result = checkFiles({
    [validation]: `  '${providerUrls[0]}',\nexport const legacyReader = true;\n`,
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`${validation}:2:`);
});
