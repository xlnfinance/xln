import { useState } from 'react';
import {
  fetchRemoteRuntimeImportSource,
  validateRemoteRuntimeImportEntries,
  writeRemoteRuntimeImportSummary,
  type RemoteRuntimeImportValidationResult,
} from '../../../frontend/src/lib/utils/onboarding/remoteRuntimeImportValidation';
import type {
  RemoteRuntimeImportEntry,
  StoredRemoteRuntimeImportEntry,
} from '../../../frontend/src/lib/utils/onboarding/remoteRuntimeImport';
import { useApp } from '../runtime/store';

/** Remember endpoint metadata only. Capabilities remain in this consent screen's memory. */
function rememberRuntime(entry: StoredRemoteRuntimeImportEntry): void {
  if (!entry.hubEntityId) throw new Error(`REMOTE_RUNTIME_PRIMARY_ENTITY_MISSING:${entry.label}`);
  const id = `remote:${entry.wsUrl}:${entry.hubEntityId}`;
  const app = useApp.getState();
  if (!app.vaults.some(vault => vault.id === id))
    app.addVault({
      id,
      name: entry.label,
      kind: 'remote',
      createdAt: Date.now(),
      remote: { wsUrl: entry.wsUrl },
    });
}

export function RemoteRuntimeImport({
  source,
  onSelect,
  onBack,
}: {
  source: string;
  onSelect: (entry: StoredRemoteRuntimeImportEntry) => void;
  onBack: () => void;
}) {
  const [entries, setEntries] = useState<RemoteRuntimeImportEntry[] | null>(null);
  const [results, setResults] = useState<RemoteRuntimeImportValidationResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const validate = (): void => {
    if (!entries) return;
    void run(async () => {
      const importedAt = Date.now();
      const checked = await validateRemoteRuntimeImportEntries(entries, { importedAt });
      setResults(checked);
      writeRemoteRuntimeImportSummary(checked, entries.length, importedAt);
      for (const result of checked) if (result.ok) rememberRuntime(result.stored);
    });
  };
  return (
    <div className="gate">
      <div className="gate-cards">
        <h1 className="gate-title">Remote runtimes</h1>
        <p className="note">
          Load the runtime list from {window.location.host}. Review the endpoints before authorizing connections.
        </p>
        {error && (
          <p role="alert" className="gate-error">
            {error}
          </p>
        )}
        {!entries && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void run(async () => setEntries(await fetchRemoteRuntimeImportSource(source)))}
          >
            {busy ? 'Loading…' : 'Load runtime list'}
          </button>
        )}
        {entries && !results && (
          <>
            <div className="gate-cards">
              {entries.map(entry => (
                <div key={entry.wsUrl} className="gate-card">
                  <span>
                    <strong className="gate-card-title">{entry.label}</strong>
                    <span className="gate-card-sub muted mono" style={{ overflowWrap: 'anywhere' }}>
                      {entry.wsUrl}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            <p className="note">
              Validate reads each runtime's authenticated identity and entities. Open a validated runtime to choose its
              entity.
            </p>
            <button type="button" className="btn" disabled={busy} onClick={validate}>
              {busy ? 'Validating…' : 'Validate & attach'}
            </button>
          </>
        )}
        {results && (
          <div className="gate-cards">
            {results.map(result =>
              result.ok ? (
                <button
                  type="button"
                  className="gate-card"
                  key={result.index}
                  disabled={busy}
                  data-testid="validated-runtime"
                  data-runtime-id={result.stored.runtimeId}
                  data-entity-id={result.stored.hubEntityId}
                  data-entity-label={result.stored.hubName}
                  onClick={() => onSelect(result.stored)}
                >
                  <span>
                    <strong className="gate-card-title">{result.stored.label}</strong>
                    <span className="gate-card-sub muted mono" style={{ overflowWrap: 'anywhere' }}>
                      {result.stored.wsUrl}
                    </span>
                    <span className="gate-card-sub">
                      {result.stored.hubName} · {result.stored.hubEntityId?.slice(0, 18)}…
                    </span>
                    <span className="gate-card-sub muted">
                      {result.stored.entityCount} entities · height {result.stored.height}
                    </span>
                  </span>
                </button>
              ) : (
                <div key={result.index} role="alert">
                  <strong>{result.entry.label}</strong>: {result.reason}
                </div>
              ),
            )}
          </div>
        )}
        <button type="button" className="btn quiet" disabled={busy} onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
