import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('DocsView sanitizes the final Markdown HTML at the shared security boundary', () => {
  const docsView = readFileSync('frontend/src/lib/components/Views/DocsView.svelte', 'utf8');
  const reactReader = readFileSync('frontend/apps/docs/src/docs-reader.tsx', 'utf8');
  const docsModel = readFileSync('frontend/src/lib/docs/docs-page-model.ts', 'utf8');
  const sanitizer = readFileSync('frontend/src/lib/security/safe-markdown.ts', 'utf8');

  expect(docsView).toContain('renderDocsMarkdown');
  expect(reactReader).toContain('dangerouslySetInnerHTML');
  expect(docsModel).toContain("import { sanitizeRenderedHtml } from '../security/safe-markdown';");
  expect(docsModel).toContain('return sanitizeRenderedHtml(marked.parse(prepared');
  expect(sanitizer).toContain("const DROP_TAGS = new Set(['EMBED', 'IFRAME', 'MATH', 'OBJECT', 'SCRIPT', 'STYLE', 'SVG'])");
  expect(sanitizer).toContain("attribute.name === 'data-doc-link'");
  expect(sanitizer).toContain("if (!['http:', 'https:'].includes(target.protocol)) element.removeAttribute('src')");
});
