import { expect, test } from 'bun:test';

import { inspectQaTestCategory, qaRunTestCategory, qaTestCategoryFromTags } from '../../../qa/test-categories';
import {
  listPlaywrightTestMetadata,
  parsePlaywrightTestMetadata,
} from '../../../scripts/e2e/harness/playwright-test-metadata';

test('Playwright loads custody Runtime wire decoders without importing server configuration', async () => {
  const tests = await listPlaywrightTestMetadata(['tests/e2e-custody.spec.ts']);
  expect(tests.length).toBeGreaterThan(0);
  expect(tests.every(entry => entry.file === 'tests/e2e-custody.spec.ts')).toBe(true);
}, 30_000);

test('Playwright discovery reports an actual failed CLI instead of an empty catalog', async () => {
  await expect(
    listPlaywrightTestMetadata(['tests/e2e-custody.spec.ts'], {
      project: 'xln-missing-discovery-project',
    }),
  ).rejects.toThrow('PLAYWRIGHT_LIST_PROCESS_FAILED:exit=1:signal=none');
});

test('Playwright discovery preserves JSON reporter errors with the failed process status', async () => {
  let failure: unknown;
  try {
    await listPlaywrightTestMetadata(['tests/xln-missing-discovery-spec.spec.ts']);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('PLAYWRIGHT_LIST_PROCESS_FAILED:exit=1:signal=none');
  expect((failure as Error).message).toContain('No tests found');
});

test('classifies exactly one native Playwright QA category tag', () => {
  expect(qaTestCategoryFromTags(['@functional'])).toBe('functional');
  expect(qaTestCategoryFromTags(['@resilience', '@slow'])).toBe('resilience');
  expect(qaTestCategoryFromTags([])).toBeNull();
  expect(qaTestCategoryFromTags(['@functional', '@resilience'])).toBeNull();
});

test('reports missing and conflicting QA category tags', () => {
  const base = { file: 'tests/example.spec.ts', line: 12, title: 'example' };
  expect(inspectQaTestCategory({ ...base, tags: [] })?.code).toBe('QA_TEST_CATEGORY_MISSING');
  expect(inspectQaTestCategory({ ...base, tags: ['@functional', '@resilience'] })?.code).toBe(
    'QA_TEST_CATEGORY_CONFLICT',
  );
  expect(inspectQaTestCategory({ ...base, tags: ['@functional'] })).toBeNull();
});

test('summarizes a run category without hiding mixed or unknown evidence', () => {
  expect(qaRunTestCategory([])).toBe('unknown');
  expect(qaRunTestCategory(['functional', 'functional'])).toBe('functional');
  expect(qaRunTestCategory(['resilience'])).toBe('resilience');
  expect(qaRunTestCategory(['functional', 'resilience'])).toBe('mixed');
});

test('parses Playwright JSON metadata and restores native tag prefixes', () => {
  const tests = parsePlaywrightTestMetadata({
    config: { rootDir: `${process.cwd()}/tests` },
    errors: [],
    suites: [
      {
        specs: [
          {
            title: 'opens an account',
            file: 'open-account.spec.ts',
            line: 7,
            tags: ['functional'],
          },
        ],
        suites: [],
      },
    ],
  });

  expect(tests).toEqual([
    {
      file: 'tests/open-account.spec.ts',
      line: 7,
      title: 'opens an account',
      tags: ['@functional'],
    },
  ]);
});
