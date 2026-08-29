import type { MouseEvent } from 'react';

import type { DocEntry, DocSection, TocHeading } from '$lib/docs/docs-page-model';

export type DocsDocumentState =
  | Readonly<{ status: 'idle' | 'loading' }>
  | Readonly<{ status: 'error'; message: string }>
  | Readonly<{ status: 'ready'; html: string; headings: readonly TocHeading[] }>;

type DocsReaderProps = Readonly<{
  currentDoc: DocEntry | null;
  currentSection: DocSection | null;
  documentState: DocsDocumentState;
  visibleDocCount: number;
  manifestError: string;
  onOpenNavigation: () => void;
  onNavigateHref: (href: string) => void;
  onRetry: () => void;
}>;

const handleArticleNavigation = (
  event: MouseEvent<HTMLElement>,
  onNavigateHref: (href: string) => void,
): void => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest<HTMLAnchorElement>('a[data-doc-link="1"]');
  const href = anchor?.getAttribute('href');
  if (!href) return;
  event.preventDefault();
  onNavigateHref(href);
};

function ReaderState({ message, error, onRetry }: Readonly<{
  message: string;
  error?: boolean;
  onRetry: () => void;
}>) {
  return (
    <div className={error ? 'docs-state is-error' : 'docs-state'} data-testid={error ? 'docs-error' : 'docs-loading'} role={error ? 'alert' : 'status'}>
      <span>{error ? 'Catalog unavailable' : 'Loading documentation'}</span>
      <strong>{message}</strong>
      {error ? <button type="button" onClick={onRetry}>Retry request <span aria-hidden="true">→</span></button> : null}
    </div>
  );
}

export function DocsReader({
  currentDoc,
  currentSection,
  documentState,
  visibleDocCount,
  manifestError,
  onOpenNavigation,
  onNavigateHref,
  onRetry,
}: DocsReaderProps) {
  const headings = documentState.status === 'ready' ? documentState.headings : [];
  return (
    <main className="docs-main">
      <div className="docs-mobile-toolbar">
        <button type="button" data-testid="docs-nav-toggle" onClick={onOpenNavigation}>Browse docs <span aria-hidden="true">↗</span></button>
        <span>{currentDoc?.title ?? 'Documentation catalog'}</span>
      </div>

      <section className="docs-intro">
        <div>
          <p className="docs-overline">Documentation</p>
          <h1>Project documentation</h1>
          <p>Start with live specifications. Open the archive only for historical wording, superseded plans, or research branches.</p>
        </div>
        <dl className="docs-intro-facts">
          <div><dt>Visible docs</dt><dd>{visibleDocCount}</dd></div>
          <div><dt>Current truth</dt><dd>Status + Mainnet</dd></div>
        </dl>
      </section>

      {manifestError ? <ReaderState message={manifestError} error onRetry={onRetry} /> : null}
      {!manifestError && (documentState.status === 'idle' || documentState.status === 'loading') ? <ReaderState message="Resolving the catalog and selected source…" onRetry={onRetry} /> : null}
      {!manifestError && documentState.status === 'error' ? <ReaderState message={documentState.message} error onRetry={onRetry} /> : null}

      {!manifestError && currentDoc && documentState.status === 'ready' ? (
        <div className="docs-reader-layout">
          <article className="docs-article-wrap">
            <header className="docs-document-header">
              <div className="docs-document-meta">
                <span className={currentDoc.kind === 'archive' ? 'is-archive' : undefined}>{currentDoc.kind}</span>
                <code>{currentDoc.id}</code>
                {currentSection ? <span>{currentSection.title}</span> : null}
              </div>
              <h2>{currentDoc.title}</h2>
              {currentDoc.summary ? <p>{currentDoc.summary}</p> : null}
              <div className="docs-document-facts">
                {currentDoc.role ? <span><strong>Role</strong>{currentDoc.role}</span> : null}
                {currentDoc.status ? <span><strong>Status</strong>{currentDoc.status}</span> : null}
                {currentDoc.audience ? <span><strong>Audience</strong>{currentDoc.audience}</span> : null}
                <a href={`/docs-catalog/${currentDoc.path}`} target="_blank" rel="noreferrer">Raw markdown <span aria-hidden="true">↗</span></a>
              </div>
            </header>
            <div
              className="markdown-body"
              data-testid="docs-article"
              onClick={(event) => handleArticleNavigation(event, onNavigateHref)}
              dangerouslySetInnerHTML={{ __html: documentState.html }}
            />
          </article>

          <aside className="docs-toc" aria-label="On this page">
            <span className="docs-overline">On this page</span>
            {headings.length > 0 ? (
              <nav>{headings.map((heading) => <a className={`level-${heading.level}`} href={`#${heading.id}`} key={`${heading.level}-${heading.id}`}>{heading.title}</a>)}</nav>
            ) : <p>No section headings in this document.</p>}
          </aside>
        </div>
      ) : null}
    </main>
  );
}
