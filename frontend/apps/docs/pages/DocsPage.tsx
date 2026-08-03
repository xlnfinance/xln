import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import {
  type DocsCatalogEntry,
  type DocsCatalogManifest,
  type DocsCatalogSection,
  type DocsReadingPath,
} from '../../../packages/client-core/docs-catalog-contract.js';
import { loadDocsDocument, loadDocsManifest } from '../src/docs-client';
import { extractHeadings, renderDocsMarkdown, type TocHeading } from '../src/markdown';

const requestedDocId = (): string => new URLSearchParams(window.location.search).get('doc')?.trim() || 'readme';
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function DocsPage() {
  const [manifest, setManifest] = useState<DocsCatalogManifest | null>(null);
  const [docId, setDocId] = useState(requestedDocId);
  const [currentDoc, setCurrentDoc] = useState<DocsCatalogEntry | null>(null);
  const [renderedHtml, setRenderedHtml] = useState('');
  const [headings, setHeadings] = useState<readonly TocHeading[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const articleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadDocsManifest(controller.signal).then(loaded => {
      setManifest(loaded);
      setLoadError('');
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(`Failed to load docs catalog: ${message(error)}`);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const onPopState = () => setDocId(requestedDocId());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!manifest) return;
    const entry = manifest.items.find(item => item.id === docId);
    if (!entry) {
      setCurrentDoc(null);
      setRenderedHtml('');
      setHeadings([]);
      setLoadError(`Unknown document: ${docId}`);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    loadDocsDocument(entry, controller.signal).then(async markdown => {
      const html = await renderDocsMarkdown(entry, markdown, manifest);
      if (controller.signal.aborted) return;
      setCurrentDoc(entry);
      setRenderedHtml(html);
      setHeadings(extractHeadings(markdown));
      document.title = `${entry.title} · xln docs`;
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(`Failed to load document: ${message(error)}`);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [docId, manifest]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('doc')) return;
    window.history.replaceState(null, '', `/docs?doc=${encodeURIComponent(docId)}`);
  }, [docId]);

  const visibleSections = useMemo<readonly DocsCatalogSection[]>(() => {
    if (!manifest) return [];
    const sections = manifest.sections.filter(section => showArchive || section.kind === 'live');
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return sections;
    return sections.map(section => ({
      ...section,
      items: section.items.filter(item => [
        item.title, item.summary, item.path, item.sectionTitle, item.role, item.status,
      ].join(' ').toLocaleLowerCase().includes(query)),
    })).filter(section => section.items.length > 0);
  }, [manifest, searchQuery, showArchive]);

  const totalVisibleDocs = visibleSections.reduce((total, section) => total + section.items.length, 0);
  const currentSection = manifest?.sections.find(section => section.id === currentDoc?.sectionId);

  const openDoc = (id: string): void => {
    const url = `/docs?doc=${encodeURIComponent(id)}`;
    window.history.pushState(null, '', url);
    setDocId(id);
    setNavOpen(false);
    window.scrollTo({ top: 0 });
  };

  const onArticleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const link = target.closest('a[data-doc-link="1"]');
    if (!(link instanceof HTMLAnchorElement)) return;
    const id = new URL(link.href).searchParams.get('doc');
    if (!id) return;
    event.preventDefault();
    openDoc(id);
  };

  const openReadingPath = (path: DocsReadingPath): void => {
    const first = path.items[0];
    if (first) openDoc(first.id);
  };

  return (
    <div className="docs-app">
      <header className="docs-topbar">
        <a className="docs-brand" href="/" aria-label="xln home"><span>x</span>ln</a>
        <nav aria-label="Primary navigation">
          <a href="/">Overview</a><a className="active" href="/docs">Docs</a><a href="/releases">Releases</a><a href="/app">Open wallet</a>
        </nav>
      </header>
      <div className="docs-shell" data-testid="docs-shell">
        <button type="button" className={`docs-backdrop${navOpen ? ' open' : ''}`} aria-label="Close docs navigation" onClick={() => setNavOpen(false)} />
        <aside className={`docs-sidebar${navOpen ? ' open' : ''}`}>
          <div className="sidebar-header">
            <div className="header-row"><div className="header-mark"><span>◫</span> XLN Docs</div><button type="button" className="mobile-close" aria-label="Close docs navigation" onClick={() => setNavOpen(false)}>×</button></div>
            <p className="header-copy">Canonical theory, live specs, launch status, and historical context.</p>
            {manifest && <div className="header-stats"><span>{manifest.counts.live} live</span><span>{manifest.counts.archive} archive</span><span>{manifest.counts.total} total</span></div>}
          </div>
          <label className="search-field"><span aria-hidden="true">⌕</span><span className="sr-only">Search docs</span><input data-testid="docs-search" type="search" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search titles, paths, summaries" /></label>
          <div className="sidebar-controls">
            <button type="button" className={`control-pill${showArchive ? '' : ' active'}`} onClick={() => setShowArchive(false)}>Live</button>
            <button type="button" className={`control-pill${showArchive ? ' active' : ''}`} onClick={() => setShowArchive(true)} data-testid="archive-toggle">Live + Archive</button>
          </div>
          {manifest && <>
            <section className="sidebar-section"><div className="section-label">Reading Paths</div><div className="path-list">{manifest.readingPaths.map(path => <button type="button" className="path-card" onClick={() => openReadingPath(path)} key={path.id}><strong>{path.title}</strong><span>{path.description}</span></button>)}</div></section>
            <section className="sidebar-section"><div className="section-label">Featured</div><div className="doc-list compact">{manifest.featured.map(doc => <DocButton doc={doc} active={doc.id === currentDoc?.id} onOpen={openDoc} key={doc.id} />)}</div></section>
            <nav className="sidebar-nav" aria-label="Documentation catalog">{visibleSections.map(section => <section className="sidebar-section" data-testid={`section-${section.id}`} key={section.id}><div className="section-label">{section.kind === 'archive' ? 'Archive · ' : ''}{section.title}</div><p className="section-copy">{section.description}</p><div className="doc-list">{section.items.map(doc => <DocButton doc={doc} active={doc.id === currentDoc?.id} onOpen={openDoc} testId key={doc.id} />)}</div></section>)}</nav>
          </>}
        </aside>
        <main className="docs-main">
          <div className="mobile-toolbar"><button type="button" className="catalog-button" data-testid="docs-nav-toggle" onClick={() => setNavOpen(true)}>☰ Browse docs</button>{currentDoc && <span className="mobile-current-doc">{currentDoc.title}</span>}</div>
          <section className="docs-hero"><div><p className="hero-eyebrow">Documentation</p><h1>Full XLN Project Docs</h1><p className="hero-copy">Start with the live docs. Use archive only for historical wording, superseded plans, or research branches.</p></div><div className="hero-metrics"><div className="metric"><span className="metric-label">Visible docs</span><strong>{totalVisibleDocs}</strong></div><div className="metric"><span className="metric-label">Current source of truth</span><strong>Status + Mainnet</strong></div></div></section>
          {loadError ? <div className="state-box error" data-testid="docs-error" role="alert">{loadError}</div> : loading || !currentDoc ? <div className="state-box loading" data-testid="docs-loading">Loading docs…</div> : <div className="docs-layout">
            <article className="docs-article-wrap"><header className="doc-header"><div className="doc-meta-row"><span className={`doc-badge${currentDoc.kind === 'archive' ? ' archive' : ''}`}>{currentDoc.kind === 'archive' ? 'Archive' : 'Live'}</span><span className="doc-path">{currentDoc.id}</span>{currentSection && <span className="doc-section">{currentSection.title}</span>}</div><h2 className="doc-title">{currentDoc.title}</h2>{currentDoc.summary && <p className="doc-summary">{currentDoc.summary}</p>}<div className="doc-facts">{currentDoc.role && <span><strong>Role:</strong> {currentDoc.role}</span>}{currentDoc.status && <span><strong>Status:</strong> {currentDoc.status}</span>}{currentDoc.audience && <span><strong>Audience:</strong> {currentDoc.audience}</span>}<a href={`/docs-catalog/${currentDoc.path}`} target="_blank" rel="noreferrer" className="raw-link">Raw markdown ↗</a></div></header><div ref={articleRef} className="markdown-body" data-testid="docs-article" onClick={onArticleClick} dangerouslySetInnerHTML={{ __html: renderedHtml }} /></article>
            <aside className="toc-rail"><div className="toc-card"><div className="section-label">On this page</div>{headings.length > 0 ? <nav className="toc-list">{headings.map(heading => <a className={`toc-link level-${heading.level}`} href={`#${heading.id}`} key={`${heading.level}-${heading.id}`}>{heading.title}</a>)}</nav> : <p className="toc-empty">No section headings in this document.</p>}</div></aside>
          </div>}
        </main>
      </div>
    </div>
  );
}

function DocButton({ doc, active, onOpen, testId = false }: Readonly<{
  doc: DocsCatalogEntry;
  active: boolean;
  onOpen: (id: string) => void;
  testId?: boolean;
}>) {
  return <button type="button" data-testid={testId ? `doc-link-${doc.id.replaceAll('/', '-')}` : undefined} className={`doc-link${active ? ' active' : ''}`} onClick={() => onOpen(doc.id)}><span className="doc-link-title">{doc.title}</span><span className="doc-link-path">{doc.id}</span></button>;
}
