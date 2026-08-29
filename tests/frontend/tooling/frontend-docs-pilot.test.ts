import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  decodeDocsManifest,
  extractDocsHeadings,
  fetchDocsDocument,
  fetchDocsManifest,
  filterDocsSections,
  normalizeDocId,
  resolveDocLink,
  resolveDocsImageSrc,
  type DocsFetcher,
} from '../../../frontend/src/lib/docs/docs-page-model';

const ROOT = resolve(import.meta.dir, '../../..');

const entry = (id: string, kind: 'live' | 'archive', sectionId: string) => ({
  id,
  path: `${id}.md`,
  title: id === 'readme' ? 'xln Documentation' : id.split('/').at(-1) ?? id,
  summary: `${kind} summary for ${id}`,
  role: '',
  status: kind === 'live' ? 'canonical' : 'superseded',
  audience: 'maintainers',
  kind,
  sectionId,
  sectionTitle: kind === 'live' ? 'Start Here' : 'Archive',
  featured: id === 'readme',
  order: 0,
  sectionOrder: kind === 'live' ? 0 : 10,
  url: `/docs?doc=${encodeURIComponent(id)}`,
});

const readme = entry('readme', 'live', 'start-here');
const guide = entry('architecture/hanko', 'live', 'architecture');
const archived = entry('archive/old-plan', 'archive', 'archive-history');
const manifestPayload = {
  generatedAt: '1970-01-01T00:00:00.000Z',
  counts: { total: 3, live: 2, archive: 1 },
  featured: [readme],
  readingPaths: [{ id: 'new-to-xln', title: 'New to xln', description: 'Begin here.', items: [readme, guide] }],
  sections: [
    { id: 'start-here', title: 'Start Here', description: 'Current orientation.', kind: 'live', order: 0, items: [readme] },
    { id: 'architecture', title: 'Architecture', description: 'Protocol structure.', kind: 'live', order: 1, items: [guide] },
    { id: 'archive-history', title: 'Archive', description: 'Historical wording.', kind: 'archive', order: 10, items: [archived] },
  ],
  items: [readme, guide, archived],
};

describe('React docs pilot', () => {
  test('strictly decodes the catalog and preserves live/archive search semantics', () => {
    const manifest = decodeDocsManifest(manifestPayload);
    expect(manifest.counts).toEqual({ total: 3, live: 2, archive: 1 });
    expect(filterDocsSections(manifest, false, '')).toHaveLength(2);
    expect(filterDocsSections(manifest, true, '')).toHaveLength(3);
    expect(filterDocsSections(manifest, true, 'superseded')[0]?.items[0]?.id).toBe('archive/old-plan');
    expect(filterDocsSections(manifest, false, 'missing')).toEqual([]);
    expect(() => decodeDocsManifest({ ...manifestPayload, injected: true })).toThrow('DOCS_MANIFEST_EXTRA_FIELD');
    expect(() => decodeDocsManifest({ ...manifestPayload, items: [{ ...readme, kind: 'draft' }] })).toThrow('DOCS_ENTRY_KIND_INVALID');
  });

  test('resolves deep links, anchors, images, and headings without leaking local paths', () => {
    const manifest = decodeDocsManifest(manifestPayload);
    expect(normalizeDocId('/docs/architecture/hanko.md')).toBe('architecture/hanko');
    expect(resolveDocLink(manifest, 'architecture/contracts.md', 'hanko.md#signatures')).toEqual({
      type: 'internal-doc',
      href: '/docs?doc=architecture%2Fhanko#signatures',
      docId: 'architecture/hanko',
    });
    expect(resolveDocLink(manifest, 'readme.md', '/app')).toEqual({ type: 'site-route', href: '/app' });
    expect(resolveDocLink(manifest, 'readme.md', 'architecture/reactive-network.html')).toEqual({
      type: 'site-route',
      href: '/docs-catalog/architecture/reactive-network.html',
    });
    expect(resolveDocLink(manifest, 'readme.md', '/Users/private/a.md').type).toBe('local-path');
    expect(resolveDocsImageSrc('architecture/contracts.md', '../frontend/static/img/diagram.svg')).toBe('/img/diagram.svg');
    expect(extractDocsHeadings('## Runtime → Entity\n### **Account** state')).toEqual([
      { level: 2, title: 'Runtime → Entity', id: 'runtime-entity' },
      { level: 3, title: 'Account state', id: 'account-state' },
    ]);
  });

  test('loads the manifest and selected Markdown through no-store boundaries', async () => {
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const fetcher: DocsFetcher = (input, init) => {
      requests.push({ input, init });
      return Promise.resolve(input.endsWith('manifest.json')
        ? Response.json(manifestPayload)
        : new Response('# xln\n\n## Start'));
    };
    const manifest = await fetchDocsManifest(fetcher);
    const markdown = await fetchDocsDocument(manifest.items[0]!, fetcher);
    expect(markdown).toContain('## Start');
    expect(requests.map(({ input }) => input)).toEqual(['/docs-catalog/manifest.json', '/docs-catalog/readme.md']);
    expect(requests.every(({ init }) => init.cache === 'no-store')).toBe(true);
  });

  test('keeps Svelte and React on one catalog, link, and sanitizer model', () => {
    const reactSource = readFileSync(resolve(ROOT, 'frontend/apps/docs/src/docs-app.tsx'), 'utf8');
    const readerSource = readFileSync(resolve(ROOT, 'frontend/apps/docs/src/docs-reader.tsx'), 'utf8');
    const svelteSource = readFileSync(resolve(ROOT, 'frontend/src/lib/components/Views/DocsView.svelte'), 'utf8');
    const modelSource = readFileSync(resolve(ROOT, 'frontend/src/lib/docs/docs-page-model.ts'), 'utf8');
    expect(reactSource).toContain("from '$lib/docs/docs-page-model'");
    expect(reactSource).toContain('AbortController');
    expect(readerSource).toContain('dangerouslySetInnerHTML');
    expect(svelteSource).toContain("from '$lib/docs/docs-page-model'");
    expect(svelteSource).not.toContain('const decodeDocsManifest');
    expect(modelSource).toContain('sanitizeRenderedHtml');
  });
});
