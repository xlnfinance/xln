import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('RuntimeIOPanel renders compact projections instead of raw Env dumps', () => {
  const source = readFileSync('frontend/src/lib/view/panels/RuntimeIOPanel.svelte', 'utf8');

  expect(source).toContain('via compact projections only');
  expect(source).toContain('Raw gossip payload hidden');
  expect(source).toContain('Structured data present; open the typed activity projection for details.');
  expect(source).not.toContain('safeStringify');
  expect(source).not.toContain('Full State JSON');
  expect(source).not.toContain('Full Frame JSON');
  expect(source).not.toContain('Runtime Input');
  expect(source).not.toContain('Runtime Outputs');
  expect(source).not.toContain('class="json-block"');
  expect(source).not.toContain('class="json-mini"');
  expect(source).not.toContain('class="json-block-small"');
});
