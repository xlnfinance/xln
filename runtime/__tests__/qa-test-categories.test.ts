import { expect, test } from 'bun:test';

import {
  inspectQaTestCategory,
  qaRunTestCategory,
  qaTestCategoryFromTags,
} from '../qa/test-categories';
import { parsePlaywrightTestMetadata } from '../scripts/playwright-test-metadata';

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
