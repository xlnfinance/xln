import { marked } from 'marked';

const ALLOWED_TAGS = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DETAILS', 'EM', 'H1', 'H2', 'H3', 'H4',
  'H5', 'H6', 'HR', 'LI', 'OL', 'P', 'PRE', 'STRONG', 'SUMMARY', 'TABLE', 'TBODY',
  'TD', 'TH', 'THEAD', 'TR', 'UL',
]);
const DROP_TAGS = new Set(['EMBED', 'IFRAME', 'MATH', 'OBJECT', 'SCRIPT', 'STYLE', 'SVG']);

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export function sanitizeRenderedHtml(html: string): string {
  if (typeof document === 'undefined') return escapeHtml(html);
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const element of [...template.content.querySelectorAll('*')]) {
    if (DROP_TAGS.has(element.tagName)) {
      element.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const allowed = (element.tagName === 'A' && (attribute.name === 'href' || attribute.name === 'title')) ||
        (element.tagName === 'CODE' && attribute.name === 'class') ||
        ((element.tagName === 'TD' || element.tagName === 'TH') && attribute.name === 'align');
      if (!allowed) element.removeAttribute(attribute.name);
    }
    if (element instanceof HTMLAnchorElement && element.hasAttribute('href')) {
      try {
        const target = new URL(element.getAttribute('href') || '', window.location.origin);
        if (!['http:', 'https:', 'mailto:'].includes(target.protocol)) element.removeAttribute('href');
      } catch {
        element.removeAttribute('href');
      }
      element.rel = 'noreferrer noopener';
    }
  }
  return template.innerHTML;
}

export function renderSafeMarkdown(markdown: string): string {
  const source = String(markdown || '');
  if (typeof document === 'undefined') return escapeHtml(source);
  return sanitizeRenderedHtml(marked.parse(source, { async: false, breaks: true, gfm: true }) as string);
}
