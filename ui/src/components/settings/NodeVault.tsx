import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BRAINVAULT_V1, BRAINVAULT_V1_SPEC_ID, validateInputs } from '../../../../brainvault/src/core';
import type {
  RuntimeAdapterBrainVaultProgress,
  RuntimeAdapterBrainVaultResult,
  RuntimeAdapterEntitySummary,
} from '@xln/core/api/runtime-adapter/types';
import {
  estimateBrainVaultWork,
  formatRuntimeDurationRounded,
} from '@xln/frontend/lib/components/Views/runtime-creation-model';
import { getAdapter } from '../../runtime/adapter';
import { FACTOR_PRESETS } from '../../runtime/brainvault';
import { switchActiveEntity } from '../../runtime/entities';
import { useApp } from '../../runtime/store';
import { Sheet } from '../Sheet';

/** The authenticated node owns derivation, key storage and signing; the browser receives only its public receipt. */
export function NodeVault() {
  useApp(state => state.adapterStatus);
  const adapter = getAdapter();
  const authorized = adapter?.mode === 'remote' && adapter.status === 'connected' && adapter.authLevel === 'admin';
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [factor, setFactor] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<RuntimeAdapterBrainVaultProgress | null>(null);
  const [result, setResult] = useState<RuntimeAdapterBrainVaultResult | null>(null);
  const abort = useRef<AbortController | null>(null);
  const navigate = useNavigate();
  const work = FACTOR_PRESETS.find(preset => preset.factor === factor)!;
  const estimate = estimateBrainVaultWork(
    work.shardCount,
    BRAINVAULT_V1.SHARD_MEMORY_KB / 1024,
    3000,
    Math.max(1, Math.min((navigator.hardwareConcurrency || 2) - 1, work.shardCount, 4)),
  );

  useEffect(() => {
    setOpen(false);
    setResult(null);
    setPassphrase('');
    return () => {
      abort.current?.abort();
      abort.current = null;
    };
  }, [adapter]);

  const close = () => {
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    setPassphrase('');
    setOpen(false);
  };
  const derive = async () => {
    if (!authorized || !adapter) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    setProgress(null);
    try {
      const receipt = await adapter.deriveBrainVault(
        { specId: BRAINVAULT_V1_SPEC_ID, name, passphrase, shardInput: factor, workers: 256 },
        {
          signal: controller.signal,
          onProgress: sample => {
            if (abort.current === controller) setProgress(sample);
          },
        },
      );
      if (abort.current !== controller || controller.signal.aborted || getAdapter() !== adapter) return;
      if (receipt.specId !== BRAINVAULT_V1_SPEC_ID || receipt.shardCount !== work.shardCount)
        throw new Error('BRAINVAULT_NODE_RESULT_SPEC_MISMATCH');
      setResult(receipt);
    } catch (cause) {
      if (abort.current === controller) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (abort.current === controller) {
        setBusy(false);
        setPassphrase('');
        abort.current = null;
      }
    }
  };
  const openWallet = async () => {
    if (!result || !adapter || getAdapter() !== adapter || !authorized) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    try {
      const summaries = await adapter.read<RuntimeAdapterEntitySummary[]>('entities', { entityId: result.entityId });
      if (abort.current !== controller || controller.signal.aborted || getAdapter() !== adapter) return;
      const owner = summaries.find(
        entry =>
          entry.entityId === result.entityId &&
          entry.signerId?.toLowerCase() === result.ethereumAddress.toLowerCase() &&
          entry.runtimeId?.toLowerCase() === adapter.runtimeId.toLowerCase(),
      );
      if (!owner || getAdapter() !== adapter) throw new Error('BRAINVAULT_NODE_OWNER_NOT_SERVED');
      switchActiveEntity(result.entityId);
      close();
      navigate('/');
    } catch (cause) {
      if (abort.current === controller) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (abort.current === controller) {
        setBusy(false);
        abort.current = null;
      }
    }
  };

  if (!authorized) return null;
  return (
    <>
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        BrainVault on this node
      </button>
      {open && (
        <Sheet title="BrainVault on this node" onClose={close}>
          {result ? (
            <div data-testid="brainvault-node-ready" className="stack">
              <p>
                Wallet ready on the node. Recovery material stays in the owner-only node state and is never delivered to
                this browser.
              </p>
              <p>
                Native benchmark: {formatRuntimeDurationRounded(result.derivationTimeMs)} · {result.shardCount} shards ·{' '}
                {result.workers} workers
              </p>
              <p className="mono" data-testid="node-vault-entity" style={{ overflowWrap: 'anywhere' }}>
                {result.entityId}
              </p>
              <button type="button" className="btn" disabled={busy} onClick={() => void openWallet()}>
                Open node wallet
              </button>
            </div>
          ) : (
            <form
              className="stack"
              onSubmit={event => {
                event.preventDefault();
                void derive();
              }}
            >
              <p className="note">
                Your passphrase is sent to this trusted node for derivation. The recovery phrase and signing key stay on
                the node.
              </p>
              <label className="field">
                <span className="field-label">Vault name public derivation input</span>
                <input className="input" value={name} onChange={event => setName(event.target.value)} disabled={busy} />
              </label>
              <label className="field">
                <span className="field-label">Secret passphrase</span>
                <input
                  className="input"
                  type="password"
                  value={passphrase}
                  onChange={event => setPassphrase(event.target.value)}
                  disabled={busy}
                  autoComplete="off"
                />
              </label>
              <div className="field">
                <label className="field-label" htmlFor="node-vault-work">
                  Derivation work
                </label>
                <select
                  id="node-vault-work"
                  className="input"
                  value={factor}
                  onChange={event => setFactor(Number(event.target.value))}
                  disabled={busy}
                >
                  {FACTOR_PRESETS.map(preset => (
                    <option key={preset.factor} value={preset.factor}>
                      {preset.factor} {preset.tier}
                    </option>
                  ))}
                </select>
              </div>
              <p className="note" data-testid="brainvault-work-estimate">
                Initial browser estimate: {formatRuntimeDurationRounded(estimate.recoveryMs)} (assumes 3 seconds per
                shard; not measured on this device).
              </p>
              <p className="note">Browser comparison only. The native node benchmark appears after derivation.</p>
              {progress && (
                <p role="status">
                  {progress.completed}/{progress.total} shards · {progress.workers} node workers
                </p>
              )}
              <button className="btn" type="submit" disabled={busy || !validateInputs(name, passphrase, factor).valid}>
                {busy ? 'Deriving on node…' : 'Derive on node'}
              </button>
            </form>
          )}
          {error && <p role="alert">{error}</p>}
        </Sheet>
      )}
    </>
  );
}
