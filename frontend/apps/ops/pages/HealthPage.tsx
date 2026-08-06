import { useEffect } from 'react';
import { useExternalStore } from '../../../packages/react-adapters/use-external-store';
import { opsHealthController, opsHealthExternalStore } from '../data/ops-health-store';

const bytes = (value: number | null): string => {
  if (value === null) return 'n/a';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${value} B`;
};
const uptime = (value: number | null): string => value === null ? 'n/a' : `${Math.floor(value / 3_600_000)}h ${Math.floor((value % 3_600_000) / 60_000)}m`;

export const HealthPage = () => {
  const state = useExternalStore(opsHealthExternalStore);
  useEffect(() => { opsHealthController.start(); return () => opsHealthController.stop(); }, []);
  const health = state.health;
  return (
    <section className="ops-page ops-health" data-testid="ops-health-page">
      <header className="ops-page-head">
        <div><p className="ops-eyebrow">operator cockpit</p><h1>Health</h1><p>Bootstrap, Runtime adapter, mesh, storage, and process evidence.</p></div>
        <button type="button" disabled={state.loading} onClick={() => void opsHealthController.refresh()}>{state.loading ? 'Reading…' : 'Refresh exact evidence'}</button>
      </header>
      {state.error ? <div className="ops-error" role="alert"><strong>Health read failed</strong><code>{state.error}</code></div> : null}
      {health ? <>
        <section className={`ops-verdict is-${health.verdict.toLowerCase()}`} data-testid="health-verdict-banner">
          <div><span>system verdict</span><strong data-testid="health-verdict-status">{health.verdict}</strong></div>
          <p data-testid="health-verdict-reason">{health.reason}</p>
          <dl><div><dt>source frame</dt><dd data-testid="health-source-height">{health.sourceHeight ?? 'n/a'}</dd></div><div><dt>uptime</dt><dd>{uptime(health.uptimeMs)}</dd></div><div><dt>RPC</dt><dd>{state.rpc.ok === null ? 'unknown' : state.rpc.ok ? `${state.rpc.latencyMs}ms` : state.rpc.error}</dd></div><div><dt>code</dt><dd data-testid="health-code-hash">{health.codeHash?.slice(0, 12) ?? 'n/a'}{health.dirty ? '-dirty' : ''}</dd></div></dl>
        </section>
        <section className="ops-gate-grid" aria-label="Health gates">
          {health.gates.map(gate => <article key={gate.id} className={`is-${gate.status}`}><span>{gate.label}</span><strong>{gate.status}</strong><p>{gate.detail}</p></article>)}
        </section>
        <div className="ops-two-column">
          <section className="ops-panel"><header><span>canonical hubs</span><strong>{health.hubs.filter(hub => hub.online).length}/{health.hubs.length} online</strong></header><div className="ops-list">{health.hubs.map(hub => <article key={hub.entityId}><i className={`is-${hub.status}`} /><div><strong>{hub.name}</strong><code>{hub.entityId}</code></div><span>{hub.accounts ?? 'n/a'} accounts</span></article>)}</div></section>
          <section className="ops-panel"><header><span>process tree</span><strong>{health.processes.filter(process => process.online).length}/{health.processes.length} online</strong></header><div className="ops-list">{health.processes.map(process => <article key={`${process.role}:${process.name}`}><i className={process.online ? 'is-healthy' : 'is-down'} /><div><strong>{process.name}</strong><code>{process.role}</code></div><span>{process.restartCount} restarts</span></article>)}</div></section>
        </div>
        <section className="ops-metrics"><article><span>disk free</span><strong>{bytes(health.storage.freeBytes)}</strong></article><article><span>disk used</span><strong>{health.storage.usedPct ?? 'n/a'}%</strong></article><article><span>tracked stores</span><strong>{health.storage.tracked}</strong></article><article data-testid="health-runtime-entities"><span>Runtime entities</span><strong>{state.entities.length}</strong></article><article data-testid="health-runtime-events"><span>activity window</span><strong>{state.events.length}</strong></article></section>
        {state.projectionError ? <p className="ops-notice" role="status" data-testid="health-projection-status">Runtime projection is explicitly unavailable: <code>{state.projectionError}</code></p> : null}
      </> : state.loading ? <div className="ops-loading">Reading health evidence…</div> : null}
    </section>
  );
};
