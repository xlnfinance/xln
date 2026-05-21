<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';
  import { marked } from 'marked';
  import { Archive, BookOpen, Compass, ExternalLink, FileText, Menu, Search, Shield, Wrench, X } from 'lucide-svelte';

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

  let manifest = $state<DocsManifest | null>(null);
  let searchQuery = $state('');
  let showArchive = $state(false);
  let isLoadingManifest = $state(true);
  let isLoadingDoc = $state(false);
  let currentDoc = $state<DocEntry | null>(null);
  let currentDocId = $state('');
  let currentDocContent = $state('');
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

  function getDocById(docId: string): DocEntry | null {
    if (!manifest) return null;
    return manifest.items.find((item) => item.id === docId) || null;
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
      if (hrefWithoutHash.startsWith('/docs-static/')) {
        resolvedDocId = normalizeDocId(hrefWithoutHash.slice('/docs-static/'.length));
      } else if (hrefWithoutHash.startsWith('/docs-catalog/')) {
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

    return marked.parse(preparedMarkdown, {
      renderer,
      gfm: true,
      breaks: false,
    }) as string;
  }

  async function loadManifest() {
    isLoadingManifest = true;
    loadError = '';
    try {
      const response = await fetch('/docs-catalog/manifest.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`manifest request failed: ${response.status}`);
      manifest = await response.json() as DocsManifest;
    } catch (error) {
      console.error('Failed to load docs manifest', error);
      loadError = `Failed to load docs catalog: ${error}`;
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
      currentDocContent = markdown;
      headings = extractHeadings(markdown);
      renderedHtml = await renderMarkdown(doc, markdown);
    } catch (error) {
      console.error('Failed to load doc', error);
      loadError = `Failed to load document: ${error}`;
      renderedHtml = '';
      currentDocContent = '';
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

  function openReadingPath(path: ReadingPath) {
    if (path.items[0]) {
      void openDoc(path.items[0].id);
    }
  }

  const visibleSections = $derived.by(() => {
    if (!manifest) return [] as DocSection[];
    const baseSections = manifest.sections.filter((section) => showArchive || section.kind === 'live');

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

  const featuredDocs = $derived.by<DocEntry[]>(() => manifest?.featured || []);

  const currentSection = $derived.by<DocSection | null>(() => {
    if (!manifest || !currentDoc) return null;
    const activeDoc = currentDoc;
    return manifest.sections.find((section) => section.id === activeDoc.sectionId) || null;
  });

  const totalVisibleDocs = $derived(visibleSections.reduce((sum, section) => sum + section.items.length, 0));

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
          <span>XLN Docs</span>
        </div>
        <button class="mobile-close" type="button" aria-label="Close docs navigation" onclick={() => (isNavOpen = false)}>
          <X size={16} />
        </button>
      </div>
      <p class="header-copy">Canonical theory, live specs, launch status, and historical context.</p>
      {#if manifest}
        <div class="header-stats">
          <span>{manifest.counts.live} live</span>
          <span>{manifest.counts.archive} archive</span>
          <span>{manifest.counts.total} total</span>
        </div>
      {/if}
    </div>

    <label class="search-field" aria-label="Search docs">
      <Search size={16} />
      <input
        data-testid="docs-search"
        type="search"
        bind:value={searchQuery}
        placeholder="Search titles, paths, summaries"
      />
    </label>

    <div class="sidebar-controls">
      <button class:active={!showArchive} class="control-pill" onclick={() => (showArchive = false)}>
        <Compass size={14} />
        <span>Live</span>
      </button>
      <button class:active={showArchive} class="control-pill" onclick={() => (showArchive = true)} data-testid="archive-toggle">
        <Archive size={14} />
        <span>Live + Archive</span>
      </button>
    </div>

    {#if manifest}
      <section class="sidebar-section">
        <div class="section-label">
          <Compass size={14} />
          <span>Reading Paths</span>
        </div>
        <div class="path-list">
          {#each manifest.readingPaths as path}
            <button class="path-card" onclick={() => openReadingPath(path)}>
              <strong>{path.title}</strong>
              <span>{path.description}</span>
            </button>
          {/each}
        </div>
      </section>

      {#if featuredDocs.length > 0}
        <section class="sidebar-section">
          <div class="section-label">
            <Shield size={14} />
            <span>Featured</span>
          </div>
          <div class="doc-list compact">
            {#each featuredDocs as doc}
              <button
                class="doc-link"
                class:active={currentDocId === doc.id}
                onclick={() => openDoc(doc.id)}
              >
                <span class="doc-link-title">{doc.title}</span>
                <span class="doc-link-path">{doc.id}</span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      <nav class="sidebar-nav">
        {#each visibleSections as section}
          <section class="sidebar-section" data-testid={`section-${section.id}`}>
            <div class="section-label">
              {#if section.kind === 'archive'}
                <Archive size={14} />
              {:else if section.id === 'ops'}
                <Wrench size={14} />
              {:else}
                <FileText size={14} />
              {/if}
              <span>{section.title}</span>
            </div>
            <p class="section-copy">{section.description}</p>
            <div class="doc-list">
              {#each section.items as doc}
                <button
                  data-testid={`doc-link-${doc.id.replaceAll('/', '-')}`}
                  class="doc-link"
                  class:active={currentDocId === doc.id}
                  onclick={() => openDoc(doc.id)}
                >
                  <span class="doc-link-title">{doc.title}</span>
                  <span class="doc-link-path">{doc.id}</span>
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

    <section class="docs-hero">
      <div>
        <p class="hero-eyebrow">Documentation</p>
        <h1>Full XLN Project Docs</h1>
        <p class="hero-copy">
          Start with the live docs. Use archive only when you need historical wording,
          superseded plans, or research branches.
        </p>
      </div>
      <div class="hero-metrics">
        <div class="metric">
          <span class="metric-label">Visible docs</span>
          <strong>{manifest ? totalVisibleDocs : 0}</strong>
        </div>
        <div class="metric">
          <span class="metric-label">Current source of truth</span>
          <strong>Status + Mainnet</strong>
        </div>
      </div>
    </section>

    {#if loadError}
      <div class="state-box error" data-testid="docs-error">{loadError}</div>
    {:else if isLoadingManifest || isLoadingDoc || !currentDoc}
      <div class="state-box loading" data-testid="docs-loading">Loading docs...</div>
    {:else}
      <div class="docs-layout">
        <article class="docs-article-wrap">
          <header class="doc-header">
            <div class="doc-meta-row">
              <span class="doc-badge" class:archive={currentDoc.kind === 'archive'}>
                {currentDoc.kind === 'archive' ? 'Archive' : 'Live'}
              </span>
              <span class="doc-path">{currentDoc.id}</span>
              {#if currentSection}
                <span class="doc-section">{currentSection.title}</span>
              {/if}
            </div>
            <h2 class="doc-title">{currentDoc.title}</h2>
            {#if currentDoc.summary}
              <p class="doc-summary">{currentDoc.summary}</p>
            {/if}
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
              <a href={`/docs-catalog/${currentDoc.path}`} target="_blank" rel="noreferrer" class="raw-link">
                <ExternalLink size={14} />
                <span>Raw markdown</span>
              </a>
            </div>
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

  .header-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }

  .header-stats span {
    padding: 5px 9px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.05);
    color: rgba(231, 236, 233, 0.75);
    font-size: 0.72rem;
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

  .sidebar-controls {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }

  .control-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: transparent;
    color: rgba(231, 236, 233, 0.78);
    cursor: pointer;
    font-size: 0.82rem;
  }

  .control-pill.active {
    background: rgba(79, 209, 139, 0.14);
    border-color: rgba(79, 209, 139, 0.35);
    color: #8ee8b4;
  }

  .sidebar-nav,
  .path-list,
  .doc-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
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

  .section-copy {
    margin: 8px 0 10px;
    color: rgba(231, 236, 233, 0.52);
    font-size: 0.8rem;
    line-height: 1.45;
  }

  .path-card,
  .doc-link {
    width: 100%;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.02);
    color: inherit;
    border-radius: 8px;
    text-align: left;
    cursor: pointer;
  }

  .path-card {
    padding: 12px;
  }

  .path-card strong {
    display: block;
    margin-bottom: 6px;
    font-size: 0.87rem;
    color: #f4faf7;
  }

  .path-card span {
    display: block;
    color: rgba(231, 236, 233, 0.58);
    font-size: 0.79rem;
    line-height: 1.45;
  }

  .path-card:hover,
  .doc-link:hover {
    border-color: rgba(79, 209, 139, 0.3);
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

  .doc-link-path {
    display: block;
    margin-top: 5px;
    color: rgba(231, 236, 233, 0.5);
    font-size: 0.74rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
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
  }

  .mobile-current-doc {
    min-width: 0;
    color: rgba(231, 236, 233, 0.7);
    font-size: 0.82rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .docs-hero {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 24px;
    padding-bottom: 18px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .hero-eyebrow {
    margin: 0 0 10px;
    color: #89dcb1;
    font-size: 0.76rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .docs-hero h1 {
    margin: 0;
    font-size: 2rem;
    line-height: 1.1;
    color: #f4faf7;
  }

  .hero-copy {
    max-width: 760px;
    margin: 12px 0 0;
    color: rgba(231, 236, 233, 0.7);
    line-height: 1.6;
  }

  .hero-metrics {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    min-width: 280px;
  }

  .metric {
    padding: 14px 16px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.03);
  }

  .metric-label {
    display: block;
    margin-bottom: 6px;
    color: rgba(231, 236, 233, 0.58);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .metric strong {
    color: #f3faf6;
    font-size: 1rem;
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
  }

  .doc-meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 10px;
  }

  .doc-badge,
  .doc-path,
  .doc-section {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
    font-size: 0.76rem;
  }

  .doc-badge {
    color: #8be1b0;
  }

  .doc-badge.archive {
    color: #f3c272;
  }

  .doc-path {
    color: rgba(231, 236, 233, 0.58);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .doc-section {
    color: rgba(231, 236, 233, 0.74);
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
    width: 100%;
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
      bottom: 0;
      z-index: 40;
      width: min(360px, 86vw);
      height: auto;
      border-right: 1px solid rgba(255, 255, 255, 0.08);
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
      inset: 56px 0 0;
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

    .docs-hero {
      flex-direction: column;
    }

    .hero-metrics {
      grid-template-columns: 1fr 1fr;
      min-width: 0;
    }
  }

  @media (max-width: 640px) {
    .sidebar-controls {
      flex-direction: column;
    }

    .hero-metrics {
      grid-template-columns: 1fr;
    }

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
