import { useSyncExternalStore } from 'react';

import { formatQaBytes } from '../../../src/lib/health/adminHealth';
import type { RpcHealthProbeResult } from '../../../src/lib/health/rpcHealth';
import {
  buildOpsHealthMetrics,
  deriveOpsHealthDisplayVerdict,
  shortOpsHealthHash,
  type OpsHealthEvidence,
} from './ops-health-model';
import { opsHealthSource } from './ops-health-runtime';
import { OpsShell } from './ops-shell';
import './styles/ops-health.css';

const formatObservedAt = (timestamp: number): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);

const formatRate = (bytesPerHour: number): string =>
  bytesPerHour === 0 ? 'stable' : `${bytesPerHour > 0 ? '+' : '-'}${formatQaBytes(Math.abs(bytesPerHour))}/h`;

function EvidenceHeader({ health }: Readonly<{ health: OpsHealthEvidence }>) {
  return (
    <div className="ops-evidence-meta" aria-label="Health evidence identity">
      <span>height <strong>{health.sourceHeight === null ? 'n/a' : health.sourceHeight}</strong></span>
      <span>hash <strong>{shortOpsHealthHash(health.codeHash)}</strong></span>
      <span>owner <strong>{health.sourceOwner ?? 'unreported'}</strong></span>
    </div>
  );
}

function HealthMetrics({ health, rpc }: Readonly<{
  health: OpsHealthEvidence;
  rpc: RpcHealthProbeResult | null;
}>) {
  return (
    <section className="ops-metrics" aria-label="Health metrics">
      {buildOpsHealthMetrics(health, rpc).map(metric => (
        <article className={`ops-metric is-${metric.state}`} key={metric.label}>
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
        </article>
      ))}
    </section>
  );
}

function RuntimeEvidence({ health }: Readonly<{ health: OpsHealthEvidence }>) {
  const admin = health.admin;
  return (
    <section className="ops-evidence-grid" aria-label="Runtime evidence">
      <article className="ops-panel ops-process-panel">
        <header><span>01</span><h2>Process evidence</h2></header>
        <dl className="ops-process-list">
          <div><dt>Resident memory</dt><dd>{health.rssBytes === null ? 'n/a' : formatQaBytes(health.rssBytes)}</dd></div>
          <div><dt>Heap used</dt><dd>{health.heapUsedBytes === null ? 'n/a' : formatQaBytes(health.heapUsedBytes)}</dd></div>
          <div><dt>Relay profiles</dt><dd>{admin.relayProfileCount}</dd></div>
          <div><dt>Watchtowers</dt><dd>{admin.watchtowerCount}</dd></div>
          <div><dt>Disk used</dt><dd>{admin.disk.usedPct === null ? 'n/a' : `${admin.disk.usedPct.toFixed(1)}%`}</dd></div>
          <div><dt>MM phase</dt><dd>{health.marketMakerPhase ?? (health.marketMakerEnabled ? 'unreported' : 'disabled')}</dd></div>
        </dl>
      </article>

      <article className="ops-panel ops-owners-panel">
        <header><span>02</span><h2>Runtime owners</h2><b>{admin.owners.length}</b></header>
        {admin.owners.length === 0 ? (
          <p className="ops-empty">No owner records reported by the health endpoint.</p>
        ) : (
          <div className="ops-table-wrap">
            <table>
              <thead><tr><th>Role</th><th>Identity</th><th>Status</th><th>Detail</th></tr></thead>
              <tbody>
                {admin.owners.map((owner, index) => (
                  <tr key={`${owner.role}:${owner.name}:${index}`}>
                    <td>{owner.role}</td>
                    <td><strong>{owner.name}</strong><small>{owner.runtimeId ?? 'runtime unreported'}</small></td>
                    <td><span className={`ops-state is-${owner.status}`}>{owner.status}</span></td>
                    <td>{owner.detail ?? owner.dbPath ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>

      <article className="ops-panel ops-storage-panel">
        <header><span>03</span><h2>Storage tracks</h2><b>{admin.tracked.length}</b></header>
        {admin.tracked.length === 0 ? (
          <p className="ops-empty">No tracked storage paths reported by the health endpoint.</p>
        ) : (
          <div className="ops-storage-list">
            {admin.tracked.map(track => (
              <div className="ops-storage-row" key={`${track.name}:${track.path}`}>
                <div><strong>{track.name}</strong><span>{track.kind} · {track.scanMode}</span></div>
                <code title={track.path}>{track.path}</code>
                <div className="ops-storage-size">
                  <strong>{formatQaBytes(track.currentBytes)}</strong>
                  <span className={track.bytesPerHour > 0 ? 'is-growing' : undefined}>{formatRate(track.bytesPerHour)}</span>
                </div>
                {track.scanTruncated ? <em>scan truncated</em> : null}
              </div>
            ))}
          </div>
        )}
      </article>
    </section>
  );
}

export function OpsHealthPage() {
  const snapshot = useSyncExternalStore(
    opsHealthSource.subscribe,
    opsHealthSource.getSnapshot,
    opsHealthSource.getSnapshot,
  );
  const verdict = snapshot.health
    ? deriveOpsHealthDisplayVerdict(snapshot.health, snapshot.rpc, snapshot.error)
    : null;

  return (
    <OpsShell activePath="/health">
      <header className="ops-health-header">
        <div>
          <p>operator / health</p>
          <h1>System health</h1>
          <span>Runtime, relay, process, storage, and RPC evidence from live boundaries.</span>
        </div>
        <div className="ops-health-controls">
          <label>
            <input
              checked={snapshot.autoRefresh}
              onChange={event => opsHealthSource.setAutoRefresh(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>Auto · 4s</span>
          </label>
          <button disabled={snapshot.refreshing} onClick={() => void opsHealthSource.refresh()} type="button">
            {snapshot.refreshing ? 'Refreshing…' : 'Refresh now'}
          </button>
        </div>
      </header>

      {snapshot.status === 'loading' && !snapshot.health ? (
        <section className="ops-loading" aria-live="polite">
          <span aria-hidden="true" />
          <p><strong>Reading operator evidence</strong>Health and RPC probes are running in parallel.</p>
        </section>
      ) : null}

      {snapshot.status === 'error' ? (
        <section className="ops-error" role="alert">
          <span>UNAVAILABLE</span>
          <div><strong>Health evidence could not be refreshed.</strong><code>{snapshot.error}</code></div>
          <button onClick={() => void opsHealthSource.refresh()} type="button">Retry probe</button>
        </section>
      ) : null}

      {snapshot.health && verdict ? (
        <div className="ops-health-evidence">
          <section className={`ops-verdict is-${verdict.status.toLowerCase()}`} aria-live="polite">
            <div><span>{snapshot.error ? 'STALE EVIDENCE' : 'LIVE VERDICT'}</span><strong>{verdict.status}</strong></div>
            <p>{verdict.reason}</p>
            <EvidenceHeader health={snapshot.health} />
          </section>
          {snapshot.health.resetInProgress || snapshot.health.resetError ? (
            <section className="ops-warning" role="status">
              <strong>{snapshot.health.resetInProgress ? 'Reset in progress' : 'Previous reset failed'}</strong>
              <span>{snapshot.health.resetError ?? 'Health evidence may change while reset work completes.'}</span>
            </section>
          ) : null}
          <HealthMetrics health={snapshot.health} rpc={snapshot.rpc} />
          <RuntimeEvidence health={snapshot.health} />
          <footer className="ops-health-footer">
            <span>Observed {formatObservedAt(snapshot.health.timestamp)}</span>
            <span>Endpoint /api/health · probe /rpc</span>
          </footer>
        </div>
      ) : null}
    </OpsShell>
  );
}
