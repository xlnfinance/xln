#!/usr/bin/env bun

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  formatQaTestCategoryViolations,
  inspectQaTestCategory,
} from '../qa/test-categories';
import { listPlaywrightTestMetadata } from './playwright-test-metadata';

const listSpecs = (root: string): string[] => {
  const specs: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.spec.ts')) specs.push(path);
    }
  };
  visit(root);
  return specs.sort();
};

const mainTests = listPlaywrightTestMetadata(listSpecs('tests'));
const frontendTests = listPlaywrightTestMetadata(listSpecs('frontend/tests'), {
  profile: 'brainvault',
  project: 'brainvault',
});
const tests = [...mainTests, ...frontendTests];
const violations = tests.flatMap((test) => {
  const violation = inspectQaTestCategory(test);
  return violation ? [violation] : [];
});

if (tests.length === 0) throw new Error('QA_E2E_CATEGORY_GATE_NO_TESTS');
if (violations.length > 0) {
  throw new Error(
    `QA_E2E_CATEGORY_GATE_FAILED:${violations.length}/${tests.length}\n${formatQaTestCategoryViolations(violations)}`,
  );
}

console.log(`QA_E2E_CATEGORY_GATE_OK tests=${tests.length} functional=${tests.filter(test => test.tags.includes('@functional')).length} resilience=${tests.filter(test => test.tags.includes('@resilience')).length}`);
