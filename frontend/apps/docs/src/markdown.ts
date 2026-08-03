import DOMPurify from 'dompurify';
import { marked } from 'marked';

import {
  type DocsCatalogEntry,
  type DocsCatalogManifest,
} from '../../../packages/client-core/docs-catalog-contract.js';

export type TocHeading = Readonly<{ level: number; title: string; id: string }>;

const stripMarkdown = (value: string): string => value
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/\*([^*]+)\*/g, '$1')
  .replace(/<[^>]+>/g, '')
  .trim();

export const slugifyHeading = (value: string): string => value
  .toLocaleLowerCase()
  .replace(/<[^>]+>/g, '')
  .replace(/[`*_]/g, '')
  .replace(/[^\p{L}\p{N}\s-]/gu, '')
  .trim()
  .replace(/\s+/g, '-');

export const extractHeadings = (markdown: string): readonly TocHeading[] => markdown
  .split(/\r?\n/)
  .map(line => line.match(/^(#{2,4})\s+(.+)$/))
  .filter((match): match is RegExpMatchArray => Boolean(match))
  .map(match => {
    const title = stripMarkdown(match[2] ?? '');
    return { level: match[1]?.length ?? 2, title, id: slugifyHeading(title) };
  });

const normalizeDocId = (value: string): string => value
  .trim()
  .replace(/^\/+/, '')
  .replace(/^docs\//, '')
  .replace(/\.md$/i, '');

const resolveDocLink = (
  currentPath: string,
  href: string,
  manifest: DocsCatalogManifest,
): Readonly<{ type: 'internal' | 'anchor' | 'site' | 'external' | 'blocked'; href: string; docId?: string }> => {
  const raw = href.trim();
  if (!raw) return { type: 'blocked', href: '#' };
  if (raw.startsWith('#')) return { type: 'anchor', href: raw };
  if (/^(?:https?:|mailto:)/i.test(raw)) return { type: 'external', href: raw };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) || raw.startsWith('/Users/')) return { type: 'blocked', href: '#' };
  const [withoutHash = '', hashPart = ''] = raw.split('#');
  const hash = hashPart ? `#${hashPart}` : '';
  let id = '';
  if (withoutHash.endsWith('.md')) {
    const prefixes = ['/docs-static/', '/docs-catalog/', '/docs/'];
    const prefix = prefixes.find(candidate => withoutHash.startsWith(candidate));
    if (prefix) id = normalizeDocId(withoutHash.slice(prefix.length));
    else if (withoutHash.startsWith('/')) id = normalizeDocId(withoutHash);
    else id = normalizeDocId(new URL(withoutHash, `https://xln.local/${currentPath}`).pathname);
  }
  if (id && manifest.items.some(item => item.id === id)) {
    return { type: 'internal', href: `/docs?doc=${encodeURIComponent(id)}${hash}`, docId: id };
  }
  if (raw.startsWith('/')) return { type: 'site', href: raw };
  return { type: 'external', href: raw };
};

const resolveImageSrc = (currentPath: string, href: string): string => {
  const raw = href.trim();
  if (!raw || raw.startsWith('/Users/') || /^(?:data|javascript):/i.test(raw)) return '';
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) {
    return raw.includes('/frontend/static/')
      ? raw.slice(raw.indexOf('/frontend/static/') + '/frontend/static'.length)
      : raw;
  }
  const resolved = new URL(raw, `https://xln.local/${currentPath}`);
  if (resolved.pathname.includes('/frontend/static/')) {
    return resolved.pathname.slice(resolved.pathname.indexOf('/frontend/static/') + '/frontend/static'.length);
  }
  return `/docs-catalog/${resolved.pathname.replace(/^\/+/, '')}`;
};

export const renderDocsMarkdown = async (
  doc: DocsCatalogEntry,
  markdown: string,
  manifest: DocsCatalogManifest,
): Promise<string> => {
  const renderer = new marked.Renderer();
  renderer.heading = function (token) {
    const text = this.parser.parseInline(token.tokens);
    return `<h${token.depth} id="${slugifyHeading(stripMarkdown(token.text))}">${text}</h${token.depth}>`;
  };
  renderer.link = function (token) {
    const text = this.parser.parseInline(token.tokens);
    const resolved = resolveDocLink(doc.path, token.href || '', manifest);
    if (resolved.type === 'blocked') return `<code>${text}</code>`;
    const data = resolved.type === 'internal' ? ' data-doc-link="1"' : '';
    const external = resolved.type === 'external' ? ' rel="noreferrer"' : '';
    return `<a href="${resolved.href}"${data}${external}>${text}</a>`;
  };
  renderer.image = function (token) {
    const src = resolveImageSrc(doc.path, token.href || '');
    if (!src) return `<span class="docs-image-missing">${stripMarkdown(token.text || 'image')}</span>`;
    return `<img src="${src}" alt="${stripMarkdown(token.text || '')}" loading="lazy">`;
  };
  const prepared = markdown.replace(/((?:\.\.\/)+)frontend\/static\//g, '/');
  const html = await marked.parse(prepared, { renderer, gfm: true, breaks: false });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option'],
    FORBID_ATTR: ['style', 'srcset'],
  });
};
