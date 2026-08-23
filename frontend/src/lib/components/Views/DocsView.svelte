<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';
  import { marked } from 'marked';
  import { sanitizeRenderedHtml } from '$lib/security/safe-markdown';
  import { BookOpen, ExternalLink, FileText, Menu, Search, Wrench, X } from 'lucide-svelte';
  import { readJsonUnknown, requireBoolean, rejectExtraKeys, requireFiniteNumber, requireString, requireUnknownRecord } from '$lib/utils/boundary';

  interface DocEntry {
    id: string;
    path: string;
    title: string;
    summary: string;
    role: string;
    status: string;
    audience: string;
    kind: 'live' | 'archive';
    sectionId: string;
    sectionTitle: string;
    featured: boolean;
    order: number;
    sectionOrder: number;
    url: string;
  }

  interface DocSection {
    id: string;
    title: string;
    description: string;
    kind: 'live' | 'archive';
    order: number;
    items: DocEntry[];
  }

  interface ReadingPath {
    id: string;
    title: string;
    description: string;
    items: DocEntry[];
  }

  interface DocsManifest {
    generatedAt: string;
    counts: {
      total: number;
      live: number;
      archive: number;
    };
    featured: DocEntry[];
    readingPaths: ReadingPath[];
    sections: DocSection[];
    items: DocEntry[];
  }

  interface TocHeading {
    level: number;
    title: string;
    id: string;
  }

  const decodeDocEntry = (value: unknown): DocEntry => {
    const record = requireUnknownRecord(value, 'DOCS_ENTRY_INVALID');
    rejectExtraKeys(record, ['id', 'path', 'title', 'summary', 'role', 'status', 'audience', 'kind', 'sectionId', 'sectionTitle', 'featured', 'order', 'sectionOrder', 'url'], 'DOCS_ENTRY_EXTRA_FIELD');
    if (record['kind'] !== 'live' && record['kind'] !== 'archive') throw new Error('DOCS_ENTRY_KIND_INVALID');
    const kind = record['kind'];
    return {
      id: requireString(record['id'], 'DOCS_ENTRY_ID_INVALID'),
      path: requireString(record['path'], 'DOCS_ENTRY_PATH_INVALID'),
      title: requireString(record['title'], 'DOCS_ENTRY_TITLE_INVALID'),
      summary: requireString(record['summary'], 'DOCS_ENTRY_SUMMARY_INVALID'),
      role: requireString(record['role'], 'DOCS_ENTRY_ROLE_INVALID'),
      status: requireString(record['status'], 'DOCS_ENTRY_STATUS_INVALID'),
      audience: requireString(record['audience'], 'DOCS_ENTRY_AUDIENCE_INVALID'),
      kind,
      sectionId: requireString(record['sectionId'], 'DOCS_ENTRY_SECTION_ID_INVALID'),
      sectionTitle: requireString(record['sectionTitle'], 'DOCS_ENTRY_SECTION_TITLE_INVALID'),
      featured: requireBoolean(record['featured'], 'DOCS_ENTRY_FEATURED_INVALID'),
      order: requireFiniteNumber(record['order'], 'DOCS_ENTRY_ORDER_INVALID'),
      sectionOrder: requireFiniteNumber(record['sectionOrder'], 'DOCS_ENTRY_SECTION_ORDER_INVALID'),
      url: requireString(record['url'], 'DOCS_ENTRY_URL_INVALID'),
    };
  };

  const decodeDocsManifest = (value: unknown): DocsManifest => {
    const record = requireUnknownRecord(value, 'DOCS_MANIFEST_INVALID');
    rejectExtraKeys(record, ['generatedAt', 'counts', 'featured', 'readingPaths', 'sections', 'items'], 'DOCS_MANIFEST_EXTRA_FIELD');
    const counts = requireUnknownRecord(record['counts'], 'DOCS_MANIFEST_COUNTS_INVALID');
    rejectExtraKeys(counts, ['total', 'live', 'archive'], 'DOCS_MANIFEST_COUNTS_EXTRA_FIELD');
    const generatedAt = requireString(record['generatedAt'], 'DOCS_MANIFEST_GENERATED_AT_INVALID');
    const total = requireFiniteNumber(counts['total'], 'DOCS_MANIFEST_TOTAL_INVALID');
    const live = requireFiniteNumber(counts['live'], 'DOCS_MANIFEST_LIVE_INVALID');
    const archive = requireFiniteNumber(counts['archive'], 'DOCS_MANIFEST_ARCHIVE_INVALID');
    if (!Array.isArray(record['featured']) || !Array.isArray(record['readingPaths']) || !Array.isArray(record['sections']) || !Array.isArray(record['items'])) throw new Error('DOCS_MANIFEST_FIELD_INVALID');
    const sections: DocSection[] = record['sections'].map((value): DocSection => {
      const section = requireUnknownRecord(value, 'DOCS_SECTION_INVALID');
      rejectExtraKeys(section, ['id', 'title', 'description', 'kind', 'order', 'items'], 'DOCS_SECTION_EXTRA_FIELD');
      if (section['kind'] !== 'live' && section['kind'] !== 'archive') throw new Error('DOCS_SECTION_KIND_INVALID');
      if (!Array.isArray(section['items'])) throw new Error('DOCS_SECTION_ITEMS_INVALID');
      const kind: DocSection['kind'] = section['kind'] === 'live' ? 'live' : 'archive';
      return { id: requireString(section['id'], 'DOCS_SECTION_ID_INVALID'), title: requireString(section['title'], 'DOCS_SECTION_TITLE_INVALID'), description: requireString(section['description'], 'DOCS_SECTION_DESCRIPTION_INVALID'), kind, order: requireFiniteNumber(section['order'], 'DOCS_SECTION_ORDER_INVALID'), items: section['items'].map(decodeDocEntry) };
    });
    const readingPaths = record['readingPaths'].map((value) => {
      const path = requireUnknownRecord(value, 'DOCS_READING_PATH_INVALID');
      rejectExtraKeys(path, ['id', 'title', 'description', 'items'], 'DOCS_READING_PATH_EXTRA_FIELD');
      if (!Array.isArray(path['items'])) throw new Error('DOCS_READING_PATH_ITEMS_INVALID');
      return { id: requireString(path['id'], 'DOCS_READING_PATH_ID_INVALID'), title: requireString(path['title'], 'DOCS_READING_PATH_TITLE_INVALID'), description: requireString(path['description'], 'DOCS_READING_PATH_DESCRIPTION_INVALID'), items: path['items'].map(decodeDocEntry) };
    });
    return { generatedAt, counts: { total, live, archive }, featured: record['featured'].map(decodeDocEntry), readingPaths, sections, items: record['items'].map(decodeDocEntry) };
  };

  let manifest = $state<DocsManifest | null>(null);
  let searchQuery = $state('');
  let isLoadingManifest = $state(true);
  let isLoadingDoc = $state(false);
  let currentDoc = $state<DocEntry | null>(null);
  let currentDocId = $state('');
  let renderedHtml = $state('');
  let headings = $state<TocHeading[]>([]);
  let loadError = $state('');
  let articleElement = $state<HTMLElement | null>(null);
  let isNavOpen = $state(false);

  const requestedDocId = $derived(normalizeDocId($page.url.searchParams.get('doc') || 'readme'));

  function normalizeDocId(value: string): string {
    return String(value || '')
      .trim()
      .replace(/^\/+/, '')
      .replace(/^docs\//, '')
      .replace(/\.md$/i, '') || 'readme';
  }

  function slugify(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/[`*_]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');
  }

  function stripMarkdown(value: string): string {
    return String(value || '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/<[^>]+>/g, '')
      .trim();
  }

  function normalizeProse(value: string): string {
    return stripMarkdown(value).replace(/\s+/g, ' ').toLocaleLowerCase();
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || 'Unknown error');
  }

  function getDocById(docId: string): DocEntry | null {
    if (!manifest) return null;
    return manifest.items.find((item) => item.id === docId && item.kind === 'live') || null;
  }

  function resolveDocLink(currentPath: string, href: string) {
    const rawHref = String(href || '').trim();
    if (!rawHref) return { type: 'external', href: '#' } as const;
    if (rawHref.startsWith('#')) return { type: 'anchor', href: rawHref } as const;
    if (/^https?:\/\//i.test(rawHref) || /^mailto:/i.test(rawHref)) {
      return { type: 'external', href: rawHref } as const;
    }
    if (rawHref.startsWith('/Users/')) {
      return { type: 'local-path', href: rawHref } as const;
    }

    const [hrefWithoutHashRaw = '', hashPart = ''] = rawHref.split('#');
    const hrefWithoutHash = hrefWithoutHashRaw || '';
    const hash = hashPart ? `#${hashPart}` : '';

    let resolvedDocId = '';
    if (hrefWithoutHash.endsWith('.md')) {
      if (hrefWithoutHash.startsWith('/docs-catalog/')) {
        resolvedDocId = normalizeDocId(hrefWithoutHash.slice('/docs-catalog/'.length));
      } else if (hrefWithoutHash.startsWith('/docs/')) {
        resolvedDocId = normalizeDocId(hrefWithoutHash.slice('/docs/'.length));
      } else if (hrefWithoutHash.startsWith('/')) {
        resolvedDocId = normalizeDocId(hrefWithoutHash);
      } else {
        const resolvedUrl = new URL(hrefWithoutHash, `https://xln.local/${currentPath}`);
        resolvedDocId = normalizeDocId(resolvedUrl.pathname);
      }
    }

    if (resolvedDocId && getDocById(resolvedDocId)) {
      return {
        type: 'internal-doc',
        href: `/docs?doc=${encodeURIComponent(resolvedDocId)}${hash}`,
        docId: resolvedDocId,
      } as const;
    }

    if (rawHref.startsWith('/')) {
      return { type: 'site-route', href: rawHref } as const;
    }

    return { type: 'external', href: rawHref } as const;
  }

  function resolveImageSrc(currentPath: string, href: string): string {
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
  }

  function extractHeadings(markdown: string): TocHeading[] {
    return markdown
      .split(/\r?\n/)
      .map((line) => line.match(/^(#{2,4})\s+(.+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => {
        const level = match[1]?.length || 2;
        const title = stripMarkdown(match[2] || '');
        return {
          level,
          title,
          id: slugify(title),
        };
      });
  }

  async function renderMarkdown(doc: DocEntry, markdown: string): Promise<string> {
    const preparedMarkdown = markdown.replace(
      /((?:\.\.\/)+)frontend\/static\//g,
      '/',
    );
    const lines = preparedMarkdown.split(/\r?\n/);
    const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
    const firstHeading = firstContentIndex >= 0 ? lines[firstContentIndex]?.match(/^#\s+(.+)$/) : null;
    if (firstHeading && stripMarkdown(firstHeading[1] || '').toLocaleLowerCase() === doc.title.toLocaleLowerCase()) {
      lines.splice(firstContentIndex, 1);
    }
    const firstParagraphIndex = lines.findIndex((line) => line.trim().length > 0);
    if (doc.summary && firstParagraphIndex >= 0 && !/^\s*(?:#|[-*+] |\d+\. |```|>)/.test(lines[firstParagraphIndex] || '')) {
      let paragraphEnd = firstParagraphIndex;
      while (paragraphEnd < lines.length && lines[paragraphEnd]?.trim()) paragraphEnd += 1;
      const firstParagraph = lines.slice(firstParagraphIndex, paragraphEnd).join(' ');
      const normalizedParagraph = normalizeProse(firstParagraph);
      const normalizedSummary = normalizeProse(doc.summary).replace(/(?:\.\.\.|…)$/, '');
      if (normalizedParagraph === normalizedSummary || normalizedParagraph.startsWith(normalizedSummary)) {
        lines.splice(firstParagraphIndex, paragraphEnd - firstParagraphIndex);
      }
    }
    const articleMarkdown = lines.join('\n');

    const renderer = new marked.Renderer();

    renderer.heading = function (token) {
      const textHtml = this.parser.parseInline(token.tokens);
      const id = slugify(stripMarkdown(token.text));
      return `<h${token.depth} id="${id}">${textHtml}</h${token.depth}>`;
    };

    renderer.link = function (token) {
      const textHtml = this.parser.parseInline(token.tokens);
      const resolved = resolveDocLink(doc.path, token.href || '');
      if (resolved.type === 'internal-doc') {
        return `<a href="${resolved.href}" data-doc-link="1">${textHtml}</a>`;
      }
      if (resolved.type === 'site-route') {
        return `<a href="${resolved.href}">${textHtml}</a>`;
      }
      if (resolved.type === 'anchor') {
        return `<a href="${resolved.href}">${textHtml}</a>`;
      }
      if (resolved.type === 'local-path') {
        return `<code>${textHtml}</code>`;
      }
      return `<a href="${resolved.href}" target="_blank" rel="noreferrer">${textHtml}</a>`;
    };

    renderer.image = function (token) {
      const src = resolveImageSrc(doc.path, token.href || '');
      if (!src) return `<span class="docs-image-missing">${stripMarkdown(token.text || 'image')}</span>`;
      const alt = stripMarkdown(token.text || '');
      const title = token.title ? ` title="${token.title}"` : '';
      return `<img src="${src}" alt="${alt}" loading="lazy"${title}>`;
    };

    return sanitizeRenderedHtml(marked.parse(articleMarkdown, {
      renderer,
      gfm: true,
      breaks: false,
    }) as string);
  }

  async function loadManifest() {
    isLoadingManifest = true;
    loadError = '';
    try {
      const response = await fetch('/docs-catalog/manifest.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`manifest request failed: ${response.status}`);
      manifest = decodeDocsManifest(await readJsonUnknown(response));
    } catch (error) {
      loadError = `Failed to load docs catalog: ${errorMessage(error)}`;
    } finally {
      isLoadingManifest = false;
    }
  }

  async function loadDoc(docId: string) {
    if (!manifest) return;
    const doc = getDocById(docId);
    if (!doc) {
      loadError = `Unknown document: ${docId}`;
      return;
    }

    isLoadingDoc = true;
    loadError = '';

    try {
      const response = await fetch(`/docs-catalog/${doc.path}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`document request failed: ${response.status}`);
      const markdown = await response.text();
      currentDoc = doc;
      currentDocId = doc.id;
      headings = extractHeadings(markdown);
      renderedHtml = await renderMarkdown(doc, markdown);
    } catch (error) {
      loadError = `Failed to load document: ${errorMessage(error)}`;
      renderedHtml = '';
      headings = [];
    } finally {
      isLoadingDoc = false;
    }
  }

  async function openDoc(docId: string, replaceState = false) {
    isNavOpen = false;
    await goto(`/docs?doc=${encodeURIComponent(docId)}`, {
      replaceState,
      noScroll: true,
      keepFocus: true,
    });
  }

  async function handleArticleClick(event: MouseEvent) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest('a[data-doc-link="1"]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    const href = anchor.getAttribute('href');
    if (!href) return;
    await goto(href, {
      noScroll: true,
      keepFocus: true,
    });
  }

  const visibleSections = $derived.by(() => {
    if (!manifest) return [] as DocSection[];
    const baseSections = manifest.sections.filter((section) => section.kind === 'live');

    if (!searchQuery.trim()) return baseSections;

    const query = searchQuery.trim().toLowerCase();
    return baseSections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) =>
          [
            item.title,
            item.summary,
            item.path,
            item.sectionTitle,
            item.role,
            item.status,
          ].join(' ').toLowerCase().includes(query),
        ),
      }))
      .filter((section) => section.items.length > 0);
  });

  const currentSection = $derived.by<DocSection | null>(() => {
    if (!manifest || !currentDoc) return null;
    const activeDoc = currentDoc;
    return manifest.sections.find((section) => section.id === activeDoc.sectionId) || null;
  });

  onMount(async () => {
    await loadManifest();
    if (!browser || !manifest) return;

    const initialDocId = getDocById(requestedDocId) ? requestedDocId : 'readme';
    if (!$page.url.searchParams.get('doc')) {
      await openDoc(initialDocId, true);
      return;
    }
    await loadDoc(initialDocId);
  });

  $effect(() => {
    if (!manifest || !browser) return;
    const nextDocId = getDocById(requestedDocId) ? requestedDocId : 'readme';
    if (nextDocId !== currentDocId && !isLoadingDoc) {
      void loadDoc(nextDocId);
    }
  });

  $effect(() => {
    if (!articleElement) return;
    const node = articleElement;
    node.addEventListener('click', handleArticleClick);
    return () => {
      node.removeEventListener('click', handleArticleClick);
    };
  });
</script>

<div class="docs-shell" data-testid="docs-shell">
  <button
    type="button"
    class:open={isNavOpen}
    class="docs-backdrop"
    aria-label="Close docs navigation"
    onclick={() => (isNavOpen = false)}
  ></button>

  <aside class:open={isNavOpen} class="docs-sidebar">
    <div class="sidebar-header">
      <div class="header-row">
        <div class="header-mark">
          <BookOpen size={18} />
          <span>xln docs</span>
        </div>
        <button class="mobile-close" type="button" aria-label="Close docs navigation" onclick={() => (isNavOpen = false)}>
          <X size={16} />
        </button>
      </div>
      <p class="header-copy">Canonical architecture, protocol, security, and operations.</p>
    </div>

    <label class="search-field" aria-label="Search docs">
      <Search size={16} />
      <input
        data-testid="docs-search"
        type="search"
        bind:value={searchQuery}
        placeholder="Search docs"
      />
    </label>

    {#if manifest}
      <nav class="sidebar-nav">
        {#each visibleSections as section}
          <section class="sidebar-section" data-testid={`section-${section.id}`}>
            <div class="section-label">
              {#if section.id === 'ops'}
                <Wrench size={14} />
              {:else}
                <FileText size={14} />
              {/if}
              <span>{section.title}</span>
            </div>
            <div class="doc-list">
              {#each section.items as doc}
                <button
                  data-testid={`doc-link-${doc.id.replaceAll('/', '-')}`}
                  class="doc-link"
                  class:active={currentDocId === doc.id}
                  onclick={() => openDoc(doc.id)}
                >
                  <span class="doc-link-title">{doc.title}</span>
                </button>
              {/each}
            </div>
          </section>
        {/each}
      </nav>
    {/if}
  </aside>

  <main class="docs-main">
    <div class="mobile-toolbar">
      <button class="catalog-button" type="button" data-testid="docs-nav-toggle" onclick={() => (isNavOpen = true)}>
        <Menu size={16} />
        <span>Browse docs</span>
      </button>
      {#if currentDoc}
        <span class="mobile-current-doc">{currentDoc.title}</span>
      {/if}
    </div>

    {#if loadError}
      <div class="state-box error" data-testid="docs-error">{loadError}</div>
    {:else if isLoadingManifest || isLoadingDoc || !currentDoc}
      <div class="state-box loading" data-testid="docs-loading">Loading docs...</div>
    {:else}
      <div class="docs-layout">
        <article class="docs-article-wrap">
          <header class="doc-header">
            <div class="doc-meta-row">
              {#if currentSection}
                <span class="doc-section">{currentSection.title}</span>
              {/if}
              <span class="doc-path">{currentDoc.id}</span>
              <a href={`/docs-catalog/${currentDoc.path}`} target="_blank" rel="noreferrer" class="raw-link">
                <ExternalLink size={14} />
                <span>Markdown</span>
              </a>
            </div>
            <h1 class="doc-title">{currentDoc.title}</h1>
            {#if currentDoc.summary}
              <p class="doc-summary">{currentDoc.summary}</p>
            {/if}
            {#if currentDoc.role || currentDoc.status || currentDoc.audience}
              <div class="doc-facts">
                {#if currentDoc.role}
                  <span><strong>Role:</strong> {currentDoc.role}</span>
                {/if}
                {#if currentDoc.status}
                  <span><strong>Status:</strong> {currentDoc.status}</span>
                {/if}
                {#if currentDoc.audience}
                  <span><strong>Audience:</strong> {currentDoc.audience}</span>
                {/if}
              </div>
            {/if}
          </header>

          <div
            bind:this={articleElement}
            class="markdown-body"
            data-testid="docs-article"
          >
            {@html renderedHtml}
          </div>
        </article>

        <aside class="toc-rail">
          <div class="toc-card">
            <div class="section-label">
              <BookOpen size={14} />
              <span>On this page</span>
            </div>
            {#if headings.length > 0}
              <nav class="toc-list">
                {#each headings as heading}
                  <a class={`toc-link level-${heading.level}`} href={`#${heading.id}`}>
                    {heading.title}
                  </a>
                {/each}
              </nav>
            {:else}
              <p class="toc-empty">No section headings in this document.</p>
            {/if}
          </div>
        </aside>
      </div>
    {/if}
  </main>
</div>

<style>
  .docs-shell {
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr);
    min-height: calc(100dvh - 56px);
    background:
      radial-gradient(circle at top right, rgba(79, 209, 139, 0.1), transparent 32%),
      linear-gradient(180deg, #09110c 0%, #080909 100%);
    color: #e7ece9;
  }

  .docs-sidebar {
    position: sticky;
    top: 56px;
    align-self: start;
    height: calc(100dvh - 56px);
    box-sizing: border-box;
    overflow-y: auto;
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(7, 10, 8, 0.92);
    padding: 20px 16px 28px;
  }

  .sidebar-header {
    margin-bottom: 18px;
  }

  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .header-mark {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 0.95rem;
    font-weight: 700;
    color: #7fe0aa;
  }

  .mobile-close {
    display: none;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    color: #dfe9e2;
  }

  .header-copy {
    margin: 10px 0 0;
    color: rgba(231, 236, 233, 0.66);
    font-size: 0.88rem;
    line-height: 1.5;
  }

  .search-field {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
    color: rgba(231, 236, 233, 0.62);
  }

  .search-field input {
    width: 100%;
    border: none;
    outline: none;
    background: transparent;
    color: #eef6f1;
    font-size: 0.88rem;
  }

  .search-field input::placeholder {
    color: rgba(231, 236, 233, 0.42);
  }

  .sidebar-nav,
  .doc-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .sidebar-nav {
    margin-top: 18px;
  }

  .sidebar-section {
    margin-top: 18px;
  }

  .section-label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: rgba(231, 236, 233, 0.78);
    font-size: 0.76rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .doc-link {
    width: 100%;
    border: 1px solid transparent;
    background: transparent;
    color: inherit;
    border-radius: 8px;
    text-align: left;
    cursor: pointer;
  }

  .doc-link:hover {
    border-color: rgba(79, 209, 139, 0.14);
    background: rgba(79, 209, 139, 0.08);
  }

  .doc-link {
    padding: 10px 12px;
  }

  .doc-link.active {
    border-color: rgba(79, 209, 139, 0.42);
    background: rgba(79, 209, 139, 0.14);
  }

  .doc-link-title {
    display: block;
    color: #eef6f1;
    font-size: 0.84rem;
    line-height: 1.35;
  }

  .docs-main {
    min-width: 0;
    padding: 28px 32px 40px;
  }

  .mobile-toolbar {
    display: none;
  }

  .catalog-button {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
    border: 1px solid rgba(127, 224, 170, 0.24);
    background: rgba(9, 19, 13, 0.84);
    color: #e8f3ec;
    border-radius: 10px;
    padding: 10px 12px;
    font: inherit;
    font-size: 0.86rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .mobile-current-doc {
    min-width: 0;
    color: rgba(231, 236, 233, 0.7);
    font-size: 0.82rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .state-box {
    padding: 14px 16px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
  }

  .state-box.error {
    color: #ffc6c6;
    border-color: rgba(255, 107, 107, 0.25);
    background: rgba(255, 107, 107, 0.08);
  }

  .docs-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 240px;
    gap: 28px;
    align-items: start;
  }

  .docs-article-wrap {
    min-width: 0;
  }

  .doc-header {
    margin-bottom: 28px;
    padding-bottom: 24px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .doc-meta-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 16px;
  }

  .doc-path,
  .doc-section {
    display: inline-flex;
    align-items: center;
    font-size: 0.76rem;
  }

  .doc-path {
    color: rgba(231, 236, 233, 0.58);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .doc-section {
    color: #8be1b0;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .doc-title {
    margin: 0;
    color: #f5fbf8;
    font-size: 2.1rem;
    line-height: 1.12;
  }

  .doc-summary {
    margin: 14px 0 0;
    max-width: 920px;
    color: rgba(231, 236, 233, 0.72);
    line-height: 1.65;
    font-size: 1rem;
  }

  .doc-facts {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 18px;
    margin-top: 16px;
    color: rgba(231, 236, 233, 0.62);
    font-size: 0.84rem;
    line-height: 1.5;
  }

  .doc-facts strong {
    color: #dfece5;
  }

  .raw-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #8adfb0;
    text-decoration: none;
    margin-left: auto;
  }

  .toc-rail {
    position: sticky;
    top: 84px;
  }

  .toc-card {
    padding: 14px 16px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
  }

  .toc-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 12px;
  }

  .toc-link {
    color: rgba(231, 236, 233, 0.62);
    text-decoration: none;
    font-size: 0.82rem;
    line-height: 1.45;
  }

  .toc-link.level-3 {
    padding-left: 12px;
  }

  .toc-link.level-4 {
    padding-left: 24px;
  }

  .toc-link:hover {
    color: #91e6b5;
  }

  .toc-empty {
    margin: 12px 0 0;
    color: rgba(231, 236, 233, 0.5);
    font-size: 0.82rem;
  }

  .markdown-body {
    max-width: 940px;
    color: #e8eeea;
  }

  .markdown-body :global(h1) {
    font-size: 2.3rem;
    line-height: 1.15;
    margin: 0 0 1rem;
    color: #f5fbf8;
  }

  .markdown-body :global(h2) {
    font-size: 1.55rem;
    line-height: 1.2;
    margin: 2.5rem 0 0.85rem;
    padding-bottom: 0.55rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    color: #f2f8f5;
  }

  .markdown-body :global(h3) {
    font-size: 1.18rem;
    line-height: 1.25;
    margin: 1.8rem 0 0.65rem;
    color: #eff6f2;
  }

  .markdown-body :global(h4) {
    font-size: 1rem;
    line-height: 1.3;
    margin: 1.4rem 0 0.6rem;
    color: #eaf3ee;
  }

  .markdown-body :global(p),
  .markdown-body :global(li) {
    color: rgba(232, 238, 234, 0.86);
    line-height: 1.72;
    font-size: 0.98rem;
  }

  .markdown-body :global(a) {
    color: #8ee4b3;
    text-decoration: none;
  }

  .markdown-body :global(a:hover) {
    text-decoration: underline;
  }

  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    padding-left: 1.4rem;
  }

  .markdown-body :global(code) {
    padding: 0.14rem 0.36rem;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.06);
    color: #a7efc8;
    font-size: 0.9em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .markdown-body :global(pre) {
    margin: 1.3rem 0;
    padding: 14px 16px;
    border-radius: 8px;
    overflow-x: auto;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(5, 8, 6, 0.92);
  }

  .markdown-body :global(pre code) {
    padding: 0;
    background: transparent;
    color: #dde9e2;
  }

  .markdown-body :global(blockquote) {
    margin: 1.4rem 0;
    padding-left: 1rem;
    border-left: 3px solid rgba(79, 209, 139, 0.65);
    color: rgba(231, 236, 233, 0.68);
  }

  .markdown-body :global(table) {
    display: block;
    width: 100%;
    max-width: 100%;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    border-collapse: collapse;
    margin: 1.5rem 0;
    font-size: 0.9rem;
  }

  .markdown-body :global(th),
  .markdown-body :global(td) {
    padding: 10px 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    text-align: left;
    vertical-align: top;
  }

  .markdown-body :global(th) {
    background: rgba(255, 255, 255, 0.04);
    color: #eef6f1;
  }

  .markdown-body :global(tr:hover) {
    background: rgba(255, 255, 255, 0.025);
  }

  .markdown-body :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    margin: 1.2rem 0;
  }

  .markdown-body :global(hr) {
    border: 0;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    margin: 2rem 0;
  }

  .docs-image-missing {
    display: inline-block;
    margin: 0.5rem 0;
    color: rgba(231, 236, 233, 0.46);
    font-size: 0.84rem;
  }

  .docs-backdrop {
    display: none;
    border: 0;
    padding: 0;
    cursor: default;
  }

  @media (max-width: 1180px) {
    .docs-layout {
      grid-template-columns: minmax(0, 1fr);
    }

    .toc-rail {
      display: none;
    }
  }

  @media (max-width: 980px) {
    .docs-shell {
      grid-template-columns: 1fr;
    }

    .docs-sidebar {
      position: fixed;
      top: 56px;
      left: 0;
      bottom: auto;
      z-index: 40;
      width: min(360px, 86vw);
      height: calc(100dvh - 56px);
      max-height: calc(100dvh - 56px);
      min-height: 0;
      box-sizing: border-box;
      overscroll-behavior: contain;
      border-right: 1px solid rgba(255, 255, 255, 0.08);
      background: #070b08;
      transform: translateX(-105%);
      transition: transform 180ms ease;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
    }

    .docs-sidebar.open {
      transform: translateX(0);
    }

    .mobile-close {
      display: inline-flex;
    }

    .docs-backdrop {
      position: fixed;
      top: 56px;
      right: 0;
      bottom: auto;
      left: 0;
      height: calc(100dvh - 56px);
      z-index: 30;
      background: rgba(2, 4, 3, 0.62);
    }

    .docs-backdrop.open {
      display: block;
    }

    .docs-main {
      padding: 20px 18px 32px;
    }

    .mobile-toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }

    :global(html:has(.docs-sidebar.open)) {
      overflow: hidden;
    }
  }

  @media (max-width: 640px) {
    .doc-title {
      font-size: 1.7rem;
    }

    .markdown-body :global(h1) {
      font-size: 1.9rem;
    }

    .markdown-body :global(h2) {
      font-size: 1.35rem;
    }
  }
</style>
