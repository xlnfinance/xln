#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';

import {
  formatQaTestCategoryViolations,
  inspectQaTestCategory,
} from '../qa/test-categories';
import { listPlaywrightTestMetadata } from './playwright-test-metadata';

const listSpecs = (root: string): string[] => {
  const result = spawnSync('rg', ['--files', root], { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`E2E_SPEC_DISCOVERY_FAILED:${String(result.stderr ?? '').trim()}`);
  }
  return String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.spec.ts'))
    .sort();
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
