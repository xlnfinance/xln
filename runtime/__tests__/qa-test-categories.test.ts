import { expect, test } from 'bun:test';

import {
  inspectQaTestCategory,
  qaRunTestCategory,
  qaTestCategoryFromTags,
} from '../qa/test-categories';
import {
  chunkPlaywrightMetadataFiles,
  parsePlaywrightTestMetadata,
} from '../scripts/playwright-test-metadata';
import { PLAYWRIGHT_NODE_EXECUTABLE, playwrightCliArgs } from '../scripts/playwright-command';

test('classifies exactly one native Playwright QA category tag', () => {
  expect(qaTestCategoryFromTags(['@functional'])).toBe('functional');
  expect(qaTestCategoryFromTags(['@resilience', '@slow'])).toBe('resilience');
  expect(qaTestCategoryFromTags([])).toBeNull();
  expect(qaTestCategoryFromTags(['@functional', '@resilience'])).toBeNull();
});

test('reports missing and conflicting QA category tags', () => {
  const base = { file: 'tests/example.spec.ts', line: 12, title: 'example' };
  expect(inspectQaTestCategory({ ...base, tags: [] })?.code).toBe('QA_TEST_CATEGORY_MISSING');
  expect(inspectQaTestCategory({ ...base, tags: ['@functional', '@resilience'] })?.code)
    .toBe('QA_TEST_CATEGORY_CONFLICT');
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
    suites: [{
      specs: [{
        title: 'opens an account',
        file: 'open-account.spec.ts',
        line: 7,
        tags: ['functional'],
      }],
      suites: [],
    }],
  });

  expect(tests).toEqual([{
    file: 'tests/open-account.spec.ts',
    line: 7,
    title: 'opens an account',
    tags: ['@functional'],
  }]);
});

test('runs the Playwright CLI with its supported Node runtime', () => {
  expect(PLAYWRIGHT_NODE_EXECUTABLE).toBe('node');
  expect(playwrightCliArgs(['test', '--list'])).toEqual([
    `${process.cwd()}/node_modules/playwright/cli.js`,
    'test',
    '--list',
  ]);
});

test('batches Playwright metadata discovery below the transform failure threshold', () => {
  const files = Array.from({ length: 21 }, (_, index) => `tests/example-${index}.spec.ts`);
  expect(chunkPlaywrightMetadataFiles(files).map(batch => batch.length)).toEqual([10, 10, 1]);
  expect(chunkPlaywrightMetadataFiles([])).toEqual([]);
});
