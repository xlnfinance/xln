import { useCallback, useEffect, useState } from 'react';
import { QaAdminControls } from '../components/QaAdminControls';
import { qaToken, readQaCockpit, readQaRun, type QaCockpit, type QaRunDetail } from '../data/ops-qa';

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error || 'OPS_QA_READ_FAILED');
const duration = (value: number | null): string => value === null ? 'n/a' : value >= 1_000 ? `${(value / 1_000).toFixed(1)}s` : `${value}ms`;

export const QaPage = () => {
  const [cockpit, setCockpit] = useState<QaCockpit | null>(null);
  const [run, setRun] = useState<QaRunDetail | null>(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setError(null);
    try {
      const next = await readQaCockpit();
      const requested = new URL(window.location.href).searchParams.get('runId');
      const selected = requested && next.runs.some(item => item.runId === requested) ? requested : next.runs[0]?.runId;
      const detail = selected ? await readQaRun(selected) : null;
      setCockpit(next); setRun(detail);
    } catch (cause) { setError(errorMessage(cause)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { setToken(qaToken.initialize()); void load(); }, [load]);
  const selectRun = (runId: string): void => {
    setError(null); setLoading(true);
    const url = new URL(window.location.href); url.searchParams.set('runId', runId); window.history.replaceState(null, '', url);
    void readQaRun(runId).then(setRun).catch(cause => setError(errorMessage(cause))).finally(() => setLoading(false));
  };
  return (
    <section className="ops-page ops-qa" data-testid="ops-qa-page">
      <header className="ops-page-head"><div><p className="ops-eyebrow">quality evidence</p><h1>QA</h1><p>Protected run evidence, browser health, artifacts, and explicit admin actions.</p></div><div className="ops-auth"><span>qa auth · {cockpit?.auth ?? 'checking'}</span><div><input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} placeholder="QA token"/><button type="button" onClick={() => { qaToken.write(token); void load(); }}>Apply</button><button type="button" onClick={() => { qaToken.clear(); setToken(''); void load(); }}>Forget</button></div></div></header>
      {error ? <div className="ops-error" role="alert" data-testid="qa-error">{error}</div> : null}
      {cockpit ? <>
        <section className="ops-metrics" data-testid="qa-summary"><article><span>runs</span><strong>{cockpit.runs.length}</strong></article><article><span>catalog</span><strong>{cockpit.catalog.length}</strong></article><article><span>history</span><strong>{cockpit.historyCount}</strong></article><article><span>restart audit</span><strong>{cockpit.auditCount}</strong></article><article><span>screenshots</span><strong>{cockpit.storyCount}</strong></article></section>
        <div className="ops-two-column ops-qa-grid"><section className="ops-panel"><header><span>recent runs</span><strong>{cockpit.runs.filter(item => item.status === 'passed').length}/{cockpit.runs.length} passed</strong></header><div className="ops-list">{cockpit.runs.map(item => <button type="button" className={run?.runId === item.runId ? 'is-active' : ''} key={item.runId} onClick={() => selectRun(item.runId)}><strong>{item.status.toUpperCase()} · {item.suiteLabel}</strong><code>{item.runId}</code><span>{duration(item.totalMs)}</span></button>)}</div></section>
          <section className="ops-panel" data-testid="qa-run-detail"><header><span>selected run</span><strong>{run?.status ?? (loading ? 'loading' : 'none')}</strong></header>{run ? <><dl className="ops-kv"><div><dt>run</dt><dd>{run.runId}</dd></div><div><dt>created</dt><dd>{new Date(run.createdAt).toISOString()}</dd></div><div><dt>code</dt><dd>{run.codeHash?.slice(0, 16) ?? 'n/a'}{run.dirty ? '-dirty' : ''}</dd></div></dl><div className="ops-shards">{run.shards.map(shard => <article key={shard.shard} className={`is-${shard.status}`}><div><strong>shard {shard.shard} · {shard.status}</strong><span>{duration(shard.durationMs)}</span></div><code>{shard.target}</code>{shard.failureClass ? <p>{shard.failureClass}: {shard.error}</p> : null}<div>{shard.artifacts.map(artifact => artifact.url ? <a key={artifact.relativePath} href={artifact.url} target="_blank" rel="noreferrer">{artifact.kind}</a> : <span key={artifact.relativePath}>{artifact.kind}</span>)}</div></article>)}</div></> : <p>No QA run is available.</p>}</section></div>
        <QaAdminControls run={run} restartAllowed={cockpit.restartAllowed && (cockpit.auth === 'admin' || cockpit.auth === 'open')} restartActive={cockpit.restartActive} onChanged={load} />
      </> : loading ? <div className="ops-loading">Reading protected QA evidence…</div> : null}
    </section>
  );
};
