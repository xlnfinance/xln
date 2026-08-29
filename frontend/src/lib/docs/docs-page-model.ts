import { marked } from 'marked';

import { sanitizeRenderedHtml } from '../security/safe-markdown';
import {
  readJsonUnknown,
  rejectExtraKeys,
  requireBoolean,
  requireFiniteNumber,
  requireString,
  requireUnknownRecord,
} from '../utils/boundary';

export type DocsKind = 'live' | 'archive';

export interface DocEntry {
  id: string;
  path: string;
  title: string;
  summary: string;
  role: string;
  status: string;
  audience: string;
  kind: DocsKind;
  sectionId: string;
  sectionTitle: string;
  featured: boolean;
  order: number;
  sectionOrder: number;
  url: string;
}

export interface DocSection {
  id: string;
  title: string;
  description: string;
  kind: DocsKind;
  order: number;
  items: DocEntry[];
}

export interface ReadingPath {
  id: string;
  title: string;
  description: string;
  items: DocEntry[];
}

export interface DocsManifest {
  generatedAt: string;
  counts: { total: number; live: number; archive: number };
  featured: DocEntry[];
  readingPaths: ReadingPath[];
  sections: DocSection[];
  items: DocEntry[];
}

export interface TocHeading {
  level: number;
  title: string;
  id: string;
}

export type DocsFetcher = (input: string, init: RequestInit) => Promise<Response>;

const requireDocsKind = (value: unknown, code: string): DocsKind => {
  if (value !== 'live' && value !== 'archive') throw new Error(code);
  return value;
};

const decodeDocEntry = (value: unknown): DocEntry => {
  const record = requireUnknownRecord(value, 'DOCS_ENTRY_INVALID');
  rejectExtraKeys(record, ['id', 'path', 'title', 'summary', 'role', 'status', 'audience', 'kind', 'sectionId', 'sectionTitle', 'featured', 'order', 'sectionOrder', 'url'], 'DOCS_ENTRY_EXTRA_FIELD');
  return {
    id: requireString(record['id'], 'DOCS_ENTRY_ID_INVALID'),
    path: requireString(record['path'], 'DOCS_ENTRY_PATH_INVALID'),
    title: requireString(record['title'], 'DOCS_ENTRY_TITLE_INVALID'),
    summary: requireString(record['summary'], 'DOCS_ENTRY_SUMMARY_INVALID'),
    role: requireString(record['role'], 'DOCS_ENTRY_ROLE_INVALID'),
    status: requireString(record['status'], 'DOCS_ENTRY_STATUS_INVALID'),
    audience: requireString(record['audience'], 'DOCS_ENTRY_AUDIENCE_INVALID'),
    kind: requireDocsKind(record['kind'], 'DOCS_ENTRY_KIND_INVALID'),
    sectionId: requireString(record['sectionId'], 'DOCS_ENTRY_SECTION_ID_INVALID'),
    sectionTitle: requireString(record['sectionTitle'], 'DOCS_ENTRY_SECTION_TITLE_INVALID'),
    featured: requireBoolean(record['featured'], 'DOCS_ENTRY_FEATURED_INVALID'),
    order: requireFiniteNumber(record['order'], 'DOCS_ENTRY_ORDER_INVALID'),
    sectionOrder: requireFiniteNumber(record['sectionOrder'], 'DOCS_ENTRY_SECTION_ORDER_INVALID'),
    url: requireString(record['url'], 'DOCS_ENTRY_URL_INVALID'),
  };
};

const decodeDocSection = (value: unknown): DocSection => {
  const record = requireUnknownRecord(value, 'DOCS_SECTION_INVALID');
  rejectExtraKeys(record, ['id', 'title', 'description', 'kind', 'order', 'items'], 'DOCS_SECTION_EXTRA_FIELD');
  if (!Array.isArray(record['items'])) throw new Error('DOCS_SECTION_ITEMS_INVALID');
  return {
    id: requireString(record['id'], 'DOCS_SECTION_ID_INVALID'),
    title: requireString(record['title'], 'DOCS_SECTION_TITLE_INVALID'),
    description: requireString(record['description'], 'DOCS_SECTION_DESCRIPTION_INVALID'),
    kind: requireDocsKind(record['kind'], 'DOCS_SECTION_KIND_INVALID'),
    order: requireFiniteNumber(record['order'], 'DOCS_SECTION_ORDER_INVALID'),
    items: record['items'].map(decodeDocEntry),
  };
};

const decodeReadingPath = (value: unknown): ReadingPath => {
  const record = requireUnknownRecord(value, 'DOCS_READING_PATH_INVALID');
  rejectExtraKeys(record, ['id', 'title', 'description', 'items'], 'DOCS_READING_PATH_EXTRA_FIELD');
  if (!Array.isArray(record['items'])) throw new Error('DOCS_READING_PATH_ITEMS_INVALID');
  return {
    id: requireString(record['id'], 'DOCS_READING_PATH_ID_INVALID'),
    title: requireString(record['title'], 'DOCS_READING_PATH_TITLE_INVALID'),
    description: requireString(record['description'], 'DOCS_READING_PATH_DESCRIPTION_INVALID'),
    items: record['items'].map(decodeDocEntry),
  };
};

export const decodeDocsManifest = (value: unknown): DocsManifest => {
  const record = requireUnknownRecord(value, 'DOCS_MANIFEST_INVALID');
  rejectExtraKeys(record, ['generatedAt', 'counts', 'featured', 'readingPaths', 'sections', 'items'], 'DOCS_MANIFEST_EXTRA_FIELD');
  const counts = requireUnknownRecord(record['counts'], 'DOCS_MANIFEST_COUNTS_INVALID');
  rejectExtraKeys(counts, ['total', 'live', 'archive'], 'DOCS_MANIFEST_COUNTS_EXTRA_FIELD');
  if (!Array.isArray(record['featured']) || !Array.isArray(record['readingPaths']) || !Array.isArray(record['sections']) || !Array.isArray(record['items'])) {
    throw new Error('DOCS_MANIFEST_FIELD_INVALID');
  }
  return {
    generatedAt: requireString(record['generatedAt'], 'DOCS_MANIFEST_GENERATED_AT_INVALID'),
    counts: {
      total: requireFiniteNumber(counts['total'], 'DOCS_MANIFEST_TOTAL_INVALID'),
      live: requireFiniteNumber(counts['live'], 'DOCS_MANIFEST_LIVE_INVALID'),
      archive: requireFiniteNumber(counts['archive'], 'DOCS_MANIFEST_ARCHIVE_INVALID'),
    },
    featured: record['featured'].map(decodeDocEntry),
    readingPaths: record['readingPaths'].map(decodeReadingPath),
    sections: record['sections'].map(decodeDocSection),
    items: record['items'].map(decodeDocEntry),
  };
};

export const normalizeDocId = (value: string): string => String(value || '')
  .trim()
  .replace(/^\/+/, '')
  .replace(/^docs\//, '')
  .replace(/\.md$/i, '') || 'readme';

export const slugifyDocHeading = (value: string): string => String(value || '')
  .toLowerCase()
  .replace(/<[^>]+>/g, '')
  .replace(/[`*_]/g, '')
  .replace(/[^\p{L}\p{N}\s-]/gu, '')
  .trim()
  .replace(/\s+/g, '-');

export const stripDocsMarkdown = (value: string): string => String(value || '')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/\*([^*]+)\*/g, '$1')
  .replace(/<[^>]+>/g, '')
  .trim();

const normalizeDocsProse = (value: string): string =>
  stripDocsMarkdown(value).replace(/\s+/g, ' ').toLocaleLowerCase();

const prepareDocsMarkdown = (doc: DocEntry, markdown: string): string => {
  const lines = markdown.replace(/((?:\.\.\/)+)frontend\/static\//g, '/').split(/\r?\n/);
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  const firstHeading = firstContentIndex >= 0 ? lines[firstContentIndex]?.match(/^#\s+(.+)$/) : null;
  if (firstHeading && stripDocsMarkdown(firstHeading[1] ?? '').toLocaleLowerCase() === doc.title.toLocaleLowerCase()) {
    lines.splice(firstContentIndex, 1);
  }
  const firstParagraphIndex = lines.findIndex((line) => line.trim().length > 0);
  if (!doc.summary || firstParagraphIndex < 0 || /^\s*(?:#|[-*+] |\d+\. |```|>)/.test(lines[firstParagraphIndex] ?? '')) {
    return lines.join('\n');
  }
  let paragraphEnd = firstParagraphIndex;
  while (paragraphEnd < lines.length && lines[paragraphEnd]?.trim()) paragraphEnd += 1;
  const paragraph = normalizeDocsProse(lines.slice(firstParagraphIndex, paragraphEnd).join(' '));
  const summary = normalizeDocsProse(doc.summary).replace(/(?:\.\.\.|…)$/, '');
  if (paragraph === summary || paragraph.startsWith(summary)) {
    lines.splice(firstParagraphIndex, paragraphEnd - firstParagraphIndex);
  }
  return lines.join('\n');
};

export const getDocById = (manifest: DocsManifest, docId: string): DocEntry | null =>
  manifest.items.find((item) => item.id === docId) ?? null;

export const resolveDocLink = (manifest: DocsManifest, currentPath: string, href: string) => {
  const rawHref = String(href || '').trim();
  if (!rawHref) return { type: 'external', href: '#' } as const;
  if (rawHref.startsWith('#')) return { type: 'anchor', href: rawHref } as const;
  if (/^https?:\/\//i.test(rawHref) || /^mailto:/i.test(rawHref)) return { type: 'external', href: rawHref } as const;
  if (rawHref.startsWith('/Users/')) return { type: 'local-path', href: rawHref } as const;

  const [hrefWithoutHash = '', hashPart = ''] = rawHref.split('#');
  const hash = hashPart ? `#${hashPart}` : '';
  const prefixes = ['/docs-static/', '/docs-catalog/', '/docs/'];
  const prefix = prefixes.find((candidate) => hrefWithoutHash.startsWith(candidate));
  const candidatePath = (prefix
    ? hrefWithoutHash.slice(prefix.length)
    : new URL(hrefWithoutHash, `https://xln.local/${currentPath}`).pathname
  ).replace(/^\/+/, '');
  if (hrefWithoutHash.endsWith('.html')) {
    const htmlHref = hrefWithoutHash.startsWith('/') ? hrefWithoutHash : `/docs-catalog/${candidatePath}`;
    return { type: 'site-route', href: `${htmlHref}${hash}` } as const;
  }
  const pathEntry = manifest.items.find((item) => item.path === candidatePath);
  const idEntry = hrefWithoutHash.endsWith('.md') ? getDocById(manifest, normalizeDocId(candidatePath)) : null;
  const resolvedDoc = pathEntry ?? idEntry;
  if (resolvedDoc) {
    return { type: 'internal-doc', href: `/docs?doc=${encodeURIComponent(resolvedDoc.id)}${hash}`, docId: resolvedDoc.id } as const;
  }
  if (rawHref.startsWith('/')) return { type: 'site-route', href: rawHref } as const;
  return { type: 'external', href: rawHref } as const;
};

export const resolveDocsImageSrc = (currentPath: string, href: string): string => {
  const rawHref = String(href || '').trim();
  if (!rawHref || rawHref.startsWith('/Users/')) return '';
  if (/^https?:\/\//i.test(rawHref) || rawHref.startsWith('/')) {
    return rawHref.includes('/frontend/static/')
      ? rawHref.slice(rawHref.indexOf('/frontend/static/') + '/frontend/static'.length)
      : rawHref;
  }
  const resolvedUrl = new URL(rawHref, `https://xln.local/${currentPath}`);
  if (resolvedUrl.pathname.includes('/frontend/static/')) {
    return resolvedUrl.pathname.slice(resolvedUrl.pathname.indexOf('/frontend/static/') + '/frontend/static'.length);
  }
  return `/docs-catalog/${resolvedUrl.pathname.replace(/^\/+/, '')}`;
};

export const extractDocsHeadings = (markdown: string): TocHeading[] => markdown
  .split(/\r?\n/)
  .map((line) => line.match(/^(#{2,4})\s+(.+)$/))
  .filter((match): match is RegExpMatchArray => Boolean(match))
  .map((match) => {
    const title = stripDocsMarkdown(match[2] ?? '');
    return { level: match[1]?.length ?? 2, title, id: slugifyDocHeading(title) };
  });

export const renderDocsMarkdown = (manifest: DocsManifest, doc: DocEntry, markdown: string): string => {
  const renderer = new marked.Renderer();
  renderer.heading = function (token) {
    return `<h${token.depth} id="${slugifyDocHeading(stripDocsMarkdown(token.text))}">${this.parser.parseInline(token.tokens)}</h${token.depth}>`;
  };
  renderer.link = function (token) {
    const text = this.parser.parseInline(token.tokens);
    const resolved = resolveDocLink(manifest, doc.path, token.href || '');
    if (resolved.type === 'internal-doc') return `<a href="${resolved.href}" data-doc-link="1">${text}</a>`;
    if (resolved.type === 'local-path') return `<code>${text}</code>`;
    if (resolved.type === 'external') return `<a href="${resolved.href}" target="_blank" rel="noreferrer">${text}</a>`;
    return `<a href="${resolved.href}">${text}</a>`;
  };
  renderer.image = function (token) {
    const src = resolveDocsImageSrc(doc.path, token.href || '');
    if (!src) return `<span class="docs-image-missing">${stripDocsMarkdown(token.text || 'image')}</span>`;
    const title = token.title ? ` title="${token.title}"` : '';
    return `<img src="${src}" alt="${stripDocsMarkdown(token.text || '')}" loading="lazy"${title}>`;
  };
  const prepared = prepareDocsMarkdown(doc, markdown);
  return sanitizeRenderedHtml(marked.parse(prepared, { renderer, gfm: true, breaks: false }) as string);
};

export const filterDocsSections = (manifest: DocsManifest, showArchive: boolean, searchQuery: string): DocSection[] => {
  const sections = manifest.sections.filter((section) => showArchive || section.kind === 'live');
  const query = searchQuery.trim().toLowerCase();
  if (!query) return sections;
  return sections.map((section) => ({
    ...section,
    items: section.items.filter((item) => [item.title, item.summary, item.path, item.sectionTitle, item.role, item.status]
      .join(' ').toLowerCase().includes(query)),
  })).filter((section) => section.items.length > 0);
};

export const fetchDocsManifest = async (fetcher: DocsFetcher = fetch, signal?: AbortSignal): Promise<DocsManifest> => {
  const init: RequestInit = signal ? { cache: 'no-store', signal } : { cache: 'no-store' };
  const response = await fetcher('/docs-catalog/manifest.json', init);
  if (!response.ok) throw new Error(`manifest request failed: ${response.status}`);
  return decodeDocsManifest(await readJsonUnknown(response));
};

export const fetchDocsDocument = async (doc: DocEntry, fetcher: DocsFetcher = fetch, signal?: AbortSignal): Promise<string> => {
  const init: RequestInit = signal ? { cache: 'no-store', signal } : { cache: 'no-store' };
  const response = await fetcher(`/docs-catalog/${doc.path}`, init);
  if (!response.ok) throw new Error(`document request failed: ${response.status}`);
  return await response.text();
};
