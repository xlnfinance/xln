import type { DocSection, DocsManifest, ReadingPath } from '$lib/docs/docs-page-model';

type DocsNavigationProps = Readonly<{
  manifest: DocsManifest | null;
  visibleSections: readonly DocSection[];
  currentDocId: string;
  searchQuery: string;
  showArchive: boolean;
  isOpen: boolean;
  onClose: () => void;
  onSearch: (query: string) => void;
  onArchiveChange: (showArchive: boolean) => void;
  onOpenDoc: (docId: string) => void;
}>;

const docTestId = (docId: string): string => `doc-link-${docId.replaceAll('/', '-')}`;

function ReadingPathButton({ path, onOpenDoc }: Readonly<{
  path: ReadingPath;
  onOpenDoc: (docId: string) => void;
}>) {
  const firstDoc = path.items[0];
  if (!firstDoc) return null;
  return (
    <button className="docs-path" type="button" onClick={() => onOpenDoc(firstDoc.id)}>
      <strong>{path.title}</strong>
      <span>{path.description}</span>
    </button>
  );
}

function SectionDocumentList({ section, currentDocId, onOpenDoc }: Readonly<{
  section: DocSection;
  currentDocId: string;
  onOpenDoc: (docId: string) => void;
}>) {
  return (
    <section className="docs-nav-section" data-testid={`section-${section.id}`}>
      <div className="docs-section-label">
        <span>{section.kind === 'archive' ? 'Archive' : section.id === 'ops' ? 'Operations' : 'Section'}</span>
        <span>{section.items.length.toString().padStart(2, '0')}</span>
      </div>
      <h2>{section.title}</h2>
      <p>{section.description}</p>
      <div className="docs-link-list">
        {section.items.map((doc) => (
          <button
            className={currentDocId === doc.id ? 'docs-link is-active' : 'docs-link'}
            data-testid={docTestId(doc.id)}
            type="button"
            aria-current={currentDocId === doc.id ? 'page' : undefined}
            onClick={() => onOpenDoc(doc.id)}
            key={doc.id}
          >
            <span>{doc.title}</span>
            <code>{doc.id}</code>
          </button>
        ))}
      </div>
    </section>
  );
}

export function DocsNavigation({
  manifest,
  visibleSections,
  currentDocId,
  searchQuery,
  showArchive,
  isOpen,
  onClose,
  onSearch,
  onArchiveChange,
  onOpenDoc,
}: DocsNavigationProps) {
  return (
    <>
      <button
        className={isOpen ? 'docs-backdrop is-open' : 'docs-backdrop'}
        type="button"
        aria-label="Close docs navigation"
        onClick={onClose}
      />
      <aside className={isOpen ? 'docs-sidebar is-open' : 'docs-sidebar'} aria-label="Documentation catalog">
        <div className="docs-sidebar-head">
          <div>
            <span className="docs-overline">Catalog</span>
            <strong>XLN Docs</strong>
          </div>
          <button className="docs-close" type="button" aria-label="Close docs navigation" onClick={onClose}>×</button>
        </div>
        <p className="docs-sidebar-copy">Canonical theory, live specs, launch status, and historical context.</p>

        {manifest ? (
          <div className="docs-counts" aria-label="Document counts">
            <span><strong>{manifest.counts.live}</strong> live</span>
            <span><strong>{manifest.counts.archive}</strong> archive</span>
            <span><strong>{manifest.counts.total}</strong> total</span>
          </div>
        ) : null}

        <label className="docs-search">
          <span>Search</span>
          <input
            data-testid="docs-search"
            type="search"
            value={searchQuery}
            placeholder="Title, path, summary"
            onChange={(event) => onSearch(event.currentTarget.value)}
          />
        </label>

        <div className="docs-scope" aria-label="Catalog scope">
          <button type="button" className={!showArchive ? 'is-active' : undefined} aria-pressed={!showArchive} onClick={() => onArchiveChange(false)}>Live</button>
          <button type="button" className={showArchive ? 'is-active' : undefined} aria-pressed={showArchive} data-testid="archive-toggle" onClick={() => onArchiveChange(true)}>Live + Archive</button>
        </div>

        {manifest ? (
          <div className="docs-sidebar-content">
            <section className="docs-nav-section docs-reading-paths">
              <div className="docs-section-label"><span>Guided reading</span><span>{manifest.readingPaths.length.toString().padStart(2, '0')}</span></div>
              <div className="docs-path-list">
                {manifest.readingPaths.map((path) => <ReadingPathButton path={path} onOpenDoc={onOpenDoc} key={path.id} />)}
              </div>
            </section>

            {manifest.featured.length > 0 ? (
              <section className="docs-nav-section docs-featured">
                <div className="docs-section-label"><span>Featured</span><span>{manifest.featured.length.toString().padStart(2, '0')}</span></div>
                <div className="docs-link-list">
                  {manifest.featured.map((doc) => (
                    <button className={currentDocId === doc.id ? 'docs-link is-active' : 'docs-link'} type="button" onClick={() => onOpenDoc(doc.id)} key={doc.id}>
                      <span>{doc.title}</span><code>{doc.id}</code>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            <nav aria-label="Documents">
              {visibleSections.map((section) => <SectionDocumentList section={section} currentDocId={currentDocId} onOpenDoc={onOpenDoc} key={section.id} />)}
              {visibleSections.length === 0 ? <p className="docs-no-results" data-testid="docs-no-results">No documents match this catalog view.</p> : null}
            </nav>
          </div>
        ) : null}
      </aside>
    </>
  );
}
