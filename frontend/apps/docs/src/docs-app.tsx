import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';

import {
  extractDocsHeadings,
  fetchDocsDocument,
  fetchDocsManifest,
  filterDocsSections,
  getDocById,
  normalizeDocId,
  renderDocsMarkdown,
  type DocsManifest,
} from '$lib/docs/docs-page-model';

import { DocsNavigation } from './docs-navigation';
import { DocsReader, type DocsDocumentState } from './docs-reader';

type ManifestState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'error'; message: string }>
  | Readonly<{ status: 'ready'; manifest: DocsManifest }>;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error || 'Unknown error');
const isAbortError = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';

const readRequestedDocId = (): string => normalizeDocId(new URL(window.location.href).searchParams.get('doc') || 'readme');

const scrollToLocationHash = (): void => {
  if (!window.location.hash) return;
  let headingId = window.location.hash.slice(1);
  try {
    headingId = decodeURIComponent(headingId);
  } catch {
    return;
  }
  document.getElementById(headingId)?.scrollIntoView({ block: 'start' });
};

function DocsTopbar() {
  return (
    <header className="docs-topbar">
      <a className="docs-wordmark" href="/" aria-label="xln home">xln<span>.</span></a>
      <span className="docs-product">Documentation</span>
      <nav aria-label="Primary navigation">
        <a href="/market-cap">Market</a>
        <a href="/releases">Releases</a>
        <a className="is-active" href="/docs" aria-current="page">Docs</a>
      </nav>
      <a className="docs-launch" href="/app">Launch <span aria-hidden="true">→</span></a>
    </header>
  );
}

export function DocsApp() {
  const [manifestAttempt, setManifestAttempt] = useState(0);
  const [documentAttempt, setDocumentAttempt] = useState(0);
  const [manifestState, setManifestState] = useState<ManifestState>({ status: 'loading' });
  const [documentState, setDocumentState] = useState<DocsDocumentState>({ status: 'idle' });
  const [requestedDocId, setRequestedDocId] = useState(readRequestedDocId);
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [showArchive, setShowArchive] = useState(false);
  const [isNavigationOpen, setIsNavigationOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setManifestState({ status: 'loading' });
    fetchDocsManifest(fetch, controller.signal).then(
      (manifest) => setManifestState({ status: 'ready', manifest }),
      (error: unknown) => {
        if (!isAbortError(error)) setManifestState({ status: 'error', message: `Failed to load docs catalog: ${errorMessage(error)}` });
      },
    );
    return () => controller.abort();
  }, [manifestAttempt]);

  useEffect(() => {
    const handlePopState = (): void => setRequestedDocId(readRequestedDocId());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (!isNavigationOpen) return;
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsNavigationOpen(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isNavigationOpen]);

  const manifest = manifestState.status === 'ready' ? manifestState.manifest : null;
  const currentDoc = useMemo(() => {
    if (!manifest) return null;
    return getDocById(manifest, requestedDocId) ?? getDocById(manifest, 'readme');
  }, [manifest, requestedDocId]);

  useEffect(() => {
    if (!currentDoc || !manifest) return;
    if (!new URL(window.location.href).searchParams.has('doc')) {
      window.history.replaceState({}, '', `/docs?doc=${encodeURIComponent(currentDoc.id)}${window.location.hash}`);
    }
    const controller = new AbortController();
    setDocumentState({ status: 'loading' });
    fetchDocsDocument(currentDoc, fetch, controller.signal).then(
      (markdown) => setDocumentState({
        status: 'ready',
        html: renderDocsMarkdown(manifest, currentDoc, markdown),
        headings: extractDocsHeadings(markdown),
      }),
      (error: unknown) => {
        if (!isAbortError(error)) setDocumentState({ status: 'error', message: `Failed to load document: ${errorMessage(error)}` });
      },
    );
    return () => controller.abort();
  }, [currentDoc, documentAttempt, manifest]);

  useEffect(() => {
    if (!currentDoc || documentState.status !== 'ready') return;
    document.title = `${currentDoc.title} | xln docs`;
    const frame = window.requestAnimationFrame(scrollToLocationHash);
    return () => window.cancelAnimationFrame(frame);
  }, [currentDoc, documentState]);

  const openDoc = useCallback((docId: string): void => {
    setIsNavigationOpen(false);
    window.history.pushState({}, '', `/docs?doc=${encodeURIComponent(docId)}`);
    setRequestedDocId(normalizeDocId(docId));
  }, []);

  const navigateHref = useCallback((href: string): void => {
    const target = new URL(href, window.location.origin);
    window.history.pushState({}, '', `${target.pathname}${target.search}${target.hash}`);
    setRequestedDocId(normalizeDocId(target.searchParams.get('doc') || 'readme'));
  }, []);

  const visibleSections = useMemo(
    () => manifest ? filterDocsSections(manifest, showArchive, deferredSearchQuery) : [],
    [deferredSearchQuery, manifest, showArchive],
  );
  const visibleDocCount = useMemo(
    () => visibleSections.reduce((total, section) => total + section.items.length, 0),
    [visibleSections],
  );
  const currentSection = useMemo(
    () => manifest?.sections.find((section) => section.id === currentDoc?.sectionId) ?? null,
    [currentDoc, manifest],
  );
  const manifestError = manifestState.status === 'error' ? manifestState.message : '';

  const retry = (): void => {
    if (manifestState.status === 'error') setManifestAttempt((attempt) => attempt + 1);
    else setDocumentAttempt((attempt) => attempt + 1);
  };

  return (
    <div className="docs-frame">
      <DocsTopbar />
      <div className="docs-shell" data-testid="docs-shell">
        <DocsNavigation
          manifest={manifest}
          visibleSections={visibleSections}
          currentDocId={currentDoc?.id ?? ''}
          searchQuery={searchQuery}
          showArchive={showArchive}
          isOpen={isNavigationOpen}
          onClose={() => setIsNavigationOpen(false)}
          onSearch={setSearchQuery}
          onArchiveChange={setShowArchive}
          onOpenDoc={openDoc}
        />
        <DocsReader
          currentDoc={currentDoc}
          currentSection={currentSection}
          documentState={documentState}
          visibleDocCount={visibleDocCount}
          manifestError={manifestError}
          onOpenNavigation={() => setIsNavigationOpen(true)}
          onNavigateHref={navigateHref}
          onRetry={retry}
        />
      </div>
    </div>
  );
}
