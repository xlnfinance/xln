import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react';

import {
  fetchReleaseDocument,
  fetchVerifiedReleaseManifest,
  type ReleaseEntry,
  type ReleaseManifest,
  type ReleaseMetricKey,
} from '$lib/releases/release-catalog';
import { verifyReleaseManifestEntry } from '$lib/releases/release-signature';
import { ReleaseChart } from './release-chart-view';
import { SiteFooter, SiteShell } from './site-shell';

type CatalogState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'error'; message: string }>
  | Readonly<{ status: 'ready'; manifest: ReleaseManifest; initialDocument: string }>;

const createAbortableFetcher = (signal: AbortSignal): typeof fetch => (input, init) => fetch(input, { ...init, signal });

function useReleaseCatalog(): CatalogState {
  const [state, setState] = useState<CatalogState>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const fetcher = createAbortableFetcher(controller.signal);
        const manifest = await fetchVerifiedReleaseManifest(fetcher);
        const latest = manifest.releases.find((release) => release.version === manifest.latest);
        if (!latest) throw new Error('RELEASE_LATEST_MISSING');
        const initialDocument = await fetchReleaseDocument(latest, fetcher);
        if (!controller.signal.aborted) setState({ status: 'ready', manifest, initialDocument });
      } catch (cause) {
        if (!controller.signal.aborted) setState({ status: 'error', message: cause instanceof Error ? cause.message : String(cause) });
      }
    };
    void load();
    return () => controller.abort();
  }, []);
  return state;
}

function ReleaseLoading() {
  return <section className="release-state"><span>Verifying release ledger</span><h1>Checking every<br />signed snapshot.</h1><div className="release-verification-line"><i /></div><p>Manifest policy · Foundation Hanko · code-root binding</p></section>;
}

function ReleaseError({ message }: Readonly<{ message: string }>) {
  return <section className="release-state is-error" role="alert"><span>Verification halted</span><h1>Release ledger<br />rejected.</h1><code>{message}</code><p>No unverified metric or release document is rendered.</p></section>;
}

type DocumentState = Readonly<{
  selectedVersion: string;
  html: string;
  loading: boolean;
  error: string;
}>;

function useReleaseDocument(manifest: ReleaseManifest, initialDocument: string) {
  const initial = manifest.releases.find((release) => release.version === manifest.latest);
  if (!initial) throw new Error('RELEASE_LATEST_MISSING');
  const [state, setState] = useState<DocumentState>({ selectedVersion: initial.version, html: initialDocument, loading: false, error: '' });
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const selectRelease = useCallback(async (release: ReleaseEntry): Promise<void> => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState((current) => ({ ...current, selectedVersion: release.version, loading: true, error: '' }));
    try {
      const html = await fetchReleaseDocument(release, createAbortableFetcher(controller.signal));
      if (!controller.signal.aborted) startTransition(() => setState({ selectedVersion: release.version, html, loading: false, error: '' }));
    } catch (cause) {
      if (!controller.signal.aborted) setState((current) => ({ ...current, loading: false, error: cause instanceof Error ? cause.message : String(cause) }));
    }
  }, []);
  return { state, selectRelease };
}

function ReleaseIdentity({ release }: Readonly<{ release: ReleaseEntry }>) {
  const verified = useMemo(() => Boolean(release.attestation && verifyReleaseManifestEntry(release)), [release]);
  return <div className="release-identity"><strong>{release.tag}</strong><span>{release.sourceCommit.slice(0, 12)}</span><span className={verified ? 'verification is-verified' : 'verification is-invalid'}>{verified ? '✓ Foundation code root verified' : '× Invalid signature'}</span></div>;
}

function ReleaseIndex({ releases, selectedVersion, onSelect }: Readonly<{ releases: readonly ReleaseEntry[]; selectedVersion: string; onSelect: (release: ReleaseEntry) => void }>) {
  return <aside className="release-index" aria-label="Release versions">{releases.map((release) => <button className={release.version === selectedVersion ? 'is-active' : undefined} type="button" key={release.version} onClick={() => onSelect(release)}><strong>{release.version}</strong><span>{new Date(release.generatedAt).toLocaleDateString('en-CA')}</span></button>)}</aside>;
}

function ReleaseDocument({ release, state }: Readonly<{ release: ReleaseEntry; state: DocumentState }>) {
  return (
    <section className="release-document" aria-busy={state.loading}>
      <div className="release-document-actions"><span>Commit {release.sourceCommit.slice(0, 12)}</span><a href={release.snapshot} target="_blank" rel="noreferrer">{'{ }'} Raw JSON</a><a href={release.snapshot} download>↓ Snapshot</a></div>
      {state.loading ? <p className="release-document-state">Loading signed release {release.version}…</p> : state.error ? <p className="release-document-state is-error" role="alert">{state.error}</p> : <article className="release-markdown" dangerouslySetInnerHTML={{ __html: state.html }} />}
    </section>
  );
}

function ReleaseLedger({ manifest, initialDocument }: Readonly<{ manifest: ReleaseManifest; initialDocument: string }>) {
  const { state, selectRelease } = useReleaseDocument(manifest, initialDocument);
  const [selectedMetric, setSelectedMetric] = useState<ReleaseMetricKey>('code');
  const [selectedScope, setSelectedScope] = useState('repository');
  const selectedRelease = useMemo(() => manifest.releases.find((release) => release.version === state.selectedVersion), [manifest.releases, state.selectedVersion]);
  if (!selectedRelease) throw new Error('RELEASE_SELECTION_MISSING');
  return (
    <>
      <header className="release-page-header"><div><p className="kicker">xln engineering ledger</p><h1>Releases</h1><p>{manifest.releases.length} signed codebase snapshots · latest {manifest.latest}</p></div><ReleaseIdentity release={selectedRelease} /></header>
      <ReleaseChart releases={manifest.releases} selectedRelease={selectedRelease} selectedMetric={selectedMetric} selectedScope={selectedScope} onMetricChange={setSelectedMetric} onScopeChange={setSelectedScope} onSelectRelease={(release) => { void selectRelease(release); }} />
      <div className="release-layout"><ReleaseIndex releases={manifest.releases} selectedVersion={state.selectedVersion} onSelect={(release) => { void selectRelease(release); }} /><ReleaseDocument release={selectedRelease} state={state} /></div>
    </>
  );
}

export function ReleasesPage() {
  const catalog = useReleaseCatalog();
  return <SiteShell activeRoute="/releases"><main className="releases-page">{catalog.status === 'loading' ? <ReleaseLoading /> : catalog.status === 'error' ? <ReleaseError message={catalog.message} /> : <ReleaseLedger manifest={catalog.manifest} initialDocument={catalog.initialDocument} />}</main><SiteFooter /></SiteShell>;
}
