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

test('docs view exposes only canonical docs and keeps responsive scroll local', () => {
  const source = readFileSync('frontend/src/lib/components/Views/DocsView.svelte', 'utf8');

  expect(source).toContain("manifest.sections.filter((section) => section.kind === 'live')");
  expect(source).toContain("item.id === docId && item.kind === 'live'");
  expect(source).not.toContain('Live + Archive');
  expect(source).not.toContain('archive-toggle');
  expect(source).not.toContain('showArchive');
  expect(source).toContain('height: calc(100dvh - 56px);');
  expect(source).toContain('overscroll-behavior: contain;');
  expect(source).toContain('overscroll-behavior-inline: contain;');
});
