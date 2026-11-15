import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverDeploymentTests } from '../../../../../tools/deployment/discovery';

const temporary = mkdtempSync(join(tmpdir(), 'xln-deployment-discovery-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

test('discovers nested recovery cases and preserves the original basename order', () => {
  const root = join(temporary, 'cases');
  mkdirSync(join(root, 'recovery'), { recursive: true });
  for (const file of [
    'standalone-deployment-z.test.ts',
    'recovery/standalone-deployment-a.test.ts',
    'recovery/standalone-deployment-support.ts',
    'unrelated.test.ts',
  ])
    writeFileSync(join(root, file), '');
  expect(discoverDeploymentTests(root, temporary)).toEqual([
    'cases/recovery/standalone-deployment-a.test.ts',
    'cases/standalone-deployment-z.test.ts',
  ]);
});

test('missing native tests reject instead of producing an empty green gate', () => {
  const root = join(temporary, 'empty');
  mkdirSync(root);
  expect(() => discoverDeploymentTests(root, temporary)).toThrow('DEPLOYMENT_NATIVE_TASK_TESTS_MISSING');
});
