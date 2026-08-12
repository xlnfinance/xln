import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('BigIntInput reports invalid amount state without raw console output', () => {
  const source = readFileSync('frontend/src/lib/components/Common/BigIntInput.svelte', 'utf8');

  expect(source).toContain('let inputError: string | null = null;');
  expect(source).toContain('function setInputValidity');
  expect(source).toContain('target.setCustomValidity(error ||');
  expect(source).toContain("aria-invalid={inputError ? 'true' : 'false'}");
  expect(source).toContain('data-testid="bigint-input-error"');
  expect(source).toContain('Use digits and one decimal point only');
  expect(source).toContain('Invalid amount: ${errorMessage(error)}');
  expect(source).not.toContain('console.warn');
  expect(source).not.toContain('console.error');
});
