import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('docs view reports load failures through visible state without raw console output', () => {
  const source = readFileSync('frontend/src/lib/components/Views/DocsView.svelte', 'utf8');

  expect(source).toContain('function errorMessage(error: unknown): string');
  expect(source).toContain('loadError = `Failed to load docs catalog: ${errorMessage(error)}`;');
  expect(source).toContain('loadError = `Failed to load document: ${errorMessage(error)}`;');
  expect(source).toContain('data-testid="docs-error"');
  expect(source).not.toContain('console.error');
  expect(source).not.toContain('console.warn');
});
