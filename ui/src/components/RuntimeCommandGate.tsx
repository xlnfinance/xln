import { useEffect, useState } from 'react';
import { loadRuntimeIncident, type IncidentLookup } from '@xln/frontend/lib/debug/runtime-incident';
import { useApp } from '../runtime/store';
import './runtime-command-gate.css';

/** A new outage/target mounts fresh evidence; an earlier incident cannot look current. */
function IncidentEvidence({ runtimeId }: { runtimeId: string }) {
  const [result, setResult] = useState<IncidentLookup | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    // Use the serving orchestrator, never forward a remote daemon capability.
    // The registry independently authorizes every request.
    void loadRuntimeIncident(window.location.origin, runtimeId, controller.signal).then(
      value => {
        if (!controller.signal.aborted) setResult(value);
      },
      error => {
        if (!controller.signal.aborted)
          setResult({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => controller.abort();
  }, [runtimeId]);
  return (
    <div>
      {result?.status === 'found' ? (
        <>
          <span>{result.code}</span> <code data-testid="runtime-command-gate-incident">{result.fingerprint}</code>
        </>
      ) : result?.status === 'error' ? (
        <span data-testid="runtime-command-gate-incident-unavailable">
          Incident registry unavailable · {result.error}
        </span>
      ) : result?.status === 'not-found' ? (
        <span data-testid="runtime-command-gate-incident-pending">Root incident is not indexed yet</span>
      ) : (
        <span>Resolving root incident…</span>
      )}{' '}
      <a href="/health">Runtime health</a>
    </div>
  );
}

/** Readiness comes only from the Runtime adapter; journal evidence never enables commands. */
export function RuntimeCommandGate() {
  const ready = useApp(s => s.commandReady);
  const reason = useApp(s => s.commandReadyReason);
  const entityId = useApp(s => s.activeEntityId);
  const runtimeId = useApp(s => s.operatorRuntimeId);
  if (!entityId || ready) return null;
  return (
    <aside className="runtime-command-gate" data-testid="runtime-command-gate" role="status">
      <strong>Runtime paused · financial actions disabled</strong>
      <span data-testid="runtime-command-gate-reason">{reason || 'readiness unavailable'}</span>
      {runtimeId && <IncidentEvidence key={`${runtimeId}|${reason}`} runtimeId={runtimeId} />}
    </aside>
  );
}
