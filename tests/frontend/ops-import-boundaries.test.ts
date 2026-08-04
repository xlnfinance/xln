import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..'); const OPS = join(ROOT, 'frontend/apps/ops');
const files = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]);
const sourceFiles = files(OPS).filter(file => /\.(ts|tsx)$/.test(file));

test('ops source contains no Svelte, vault-secret, or edge endpoint ownership', () => {
  const source = sourceFiles.map(file => readFileSync(file, 'utf8')).join('\n');
  expect(source).not.toMatch(/from ['"]svelte|\.svelte['"]/);
  expect(source).not.toContain('vaultStore'); expect(source).not.toContain('ensureProjectionRuntimeConnected');
  for (const path of ['/admin', '/radapter', '/resetdb', '/rpc2']) expect(source).not.toContain(`pattern: '${path}'`);
});

test('Three.js is isolated to its lazy graph panel and ops stays out of other React apps', () => {
  const threeOwners = sourceFiles.filter(file => readFileSync(file, 'utf8').includes("from 'three'"));
  expect(threeOwners.map(file => file.slice(OPS.length))).toEqual(['/workspace/Graph3DPanel.tsx']);
  const workspace = readFileSync(join(OPS, 'workspace/OpsDockWorkspace.tsx'), 'utf8'); expect(workspace).toContain("import('./Graph3DPanel')");
  for (const app of ['site', 'docs', 'wallet']) { const source = files(join(ROOT, 'frontend/apps', app)).filter(file => /\.(ts|tsx)$/.test(file)).map(file => readFileSync(file, 'utf8')).join('\n'); expect(source).not.toContain('apps/ops'); expect(source).not.toContain('../ops/'); }
});

test('manual delta formulas do not exist in ops view or graph code', () => {
  const owners = sourceFiles.filter(file => readFileSync(file, 'utf8').includes("@xln/runtime/account/utils"));
  expect(owners.map(file => file.slice(OPS.length))).toEqual(['/data/ops-delta-adapter.ts']);
});
