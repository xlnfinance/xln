import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('isolated scenario player reports load failures through visible state without raw console output', () => {
  const source = readFileSync('frontend/src/lib/components/Embed/IsolatedScenarioPlayer.svelte', 'utf8');

  expect(source).toContain('function errorMessage(value: unknown): string');
  expect(source).toContain('error = errorMessage(err);');
  expect(source).toContain('function initThreeJS(): boolean');
  expect(source).toContain("error = 'Container element not available';");
  expect(source).toContain('data-testid="isolated-scenario-error"');
  expect(source).not.toContain('console.error');
  expect(source).not.toContain('console.warn');
});
