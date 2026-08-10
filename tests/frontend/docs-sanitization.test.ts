import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('DocsView sanitizes the final Markdown HTML at the shared security boundary', () => {
  const docsView = readFileSync('frontend/src/lib/components/Views/DocsView.svelte', 'utf8');
  const sanitizer = readFileSync('frontend/src/lib/security/safe-markdown.ts', 'utf8');

  expect(docsView).toContain("import { sanitizeRenderedHtml } from '$lib/security/safe-markdown';");
  expect(docsView).toContain('return sanitizeRenderedHtml(marked.parse(preparedMarkdown');
  expect(sanitizer).toContain("const DROP_TAGS = new Set(['EMBED', 'IFRAME', 'MATH', 'OBJECT', 'SCRIPT', 'STYLE', 'SVG'])");
  expect(sanitizer).toContain("attribute.name === 'data-doc-link'");
  expect(sanitizer).toContain("if (!['http:', 'https:'].includes(target.protocol)) element.removeAttribute('src')");
});
