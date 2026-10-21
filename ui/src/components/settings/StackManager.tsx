import { useEffect, useState } from 'react';
import { formatEther } from 'ethers';
import {
  defaultStackStablecoinKind,
  type StackManagerDeployRequest,
  type StackManagerDeployResult,
  type StackManagerProbe,
  type StackManagerStatus,
} from '@xln/frontend/lib/components/Settings/stack-manager-client';
import { deployRemoteStack, getAdapter, readRemoteStackManager } from '../../runtime/adapter';
import { useApp } from '../../runtime/store';
import { CopyId } from '../CopyId';

type Draft = Omit<StackManagerDeployRequest, 'expectedChainId' | 'stablecoin'> & {
  stablecoinKind: 'existing' | 'test';
  stablecoinAddress: string;
};
const INITIAL: Draft = {
  name: '',
  key: '',
  rpcUrl: '',
  signerId: '',
  foundationRecipient: '',
  blockTimeMs: 12_000,
  currency: 'ETH',
  explorer: '',
  description: '',
  publication: 'local',
  confirmations: 12,
  stablecoinKind: 'existing',
  stablecoinAddress: '',
};
const keyForName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The selected daemon owns signing and receipt verification; this form sends public deployment parameters only. */
export function StackManager() {
  useApp(state => state.adapterStatus);
  const adapter = getAdapter();
  const runtimeId = adapter?.runtimeId;
  const authorized = adapter?.mode === 'remote' && adapter.authLevel === 'admin' && adapter.status === 'connected';
  const [draft, setDraft] = useState(INITIAL);
  const [signers, setSigners] = useState<readonly string[]>([]);
  const [status, setStatus] = useState<StackManagerStatus | null>(null);
  const [probe, setProbe] = useState<StackManagerProbe | null>(null);
  const [result, setResult] = useState<StackManagerDeployResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stablecoinEdited, setStablecoinEdited] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setProbe(null);
    setResult(null);
    setConfirmed(false);
    setSigners([]);
    if (!authorized) return;
    setBusy(true);
    setError('');
    void readRemoteStackManager()
      .then(response => {
        if (!active) return;
        setStatus(response.status);
        setSigners(response.signerIds);
        const signerId = response.signerIds[0];
        if (!signerId) throw new Error('This runtime has no unlocked deployment signer.');
        setDraft({ ...INITIAL, signerId, foundationRecipient: signerId });
      })
      .catch(cause => {
        if (active) setError(message(cause));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [runtimeId, authorized]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft(previous => ({ ...previous, [key]: value }));
    setConfirmed(false);
    setResult(null);
    if (key === 'rpcUrl' || key === 'signerId') setProbe(null);
    if (key === 'stablecoinKind') setStablecoinEdited(true);
  };
  const refresh = async (): Promise<void> => {
    setBusy(true);
    setError('');
    setResult(null);
    setProbe(null);
    setConfirmed(false);
    try {
      const response = await readRemoteStackManager(draft.rpcUrl.trim(), draft.signerId);
      if (!response.signerIds.includes(draft.signerId))
        throw new Error('Deployment signer is no longer owned by this runtime.');
      if (
        !response.probe ||
        response.probe.rpcUrl !== draft.rpcUrl.trim() ||
        response.probe.signerId !== draft.signerId
      )
        throw new Error('The network probe does not match the selected RPC and signer.');
      setStatus(response.status);
      setSigners(response.signerIds);
      setProbe(response.probe);
      const kind = defaultStackStablecoinKind(response.probe.chainId);
      setDraft(previous => ({
        ...previous,
        confirmations: kind === 'test' ? 1 : 12,
        stablecoinKind: stablecoinEdited ? previous.stablecoinKind : kind,
      }));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const ready =
    authorized &&
    !busy &&
    !status?.active &&
    confirmed &&
    probe !== null &&
    probe.rpcUrl === draft.rpcUrl.trim() &&
    probe.signerId === draft.signerId &&
    BigInt(probe.nativeBalanceWei) > 0n &&
    draft.name.trim() &&
    draft.key.trim() &&
    draft.foundationRecipient.trim() &&
    draft.currency.trim() &&
    Number.isSafeInteger(draft.confirmations) &&
    draft.confirmations > 0 &&
    Number.isSafeInteger(draft.blockTimeMs) &&
    draft.blockTimeMs > 0 &&
    (draft.stablecoinKind === 'test' || draft.stablecoinAddress.trim());
  const deploy = async (): Promise<void> => {
    if (!ready || !probe) return;
    setBusy(true);
    setError('');
    setResult(null);
    setConfirmed(false);
    try {
      const { stablecoinKind, stablecoinAddress, description, ...request } = draft;
      const response = await deployRemoteStack({
        ...request,
        name: draft.name.trim(),
        key: draft.key.trim(),
        rpcUrl: draft.rpcUrl.trim(),
        foundationRecipient: draft.foundationRecipient.trim(),
        currency: draft.currency.trim(),
        explorer: draft.explorer.trim(),
        ...(description?.trim() ? { description: description.trim() } : {}),
        expectedChainId: probe.chainId,
        stablecoin:
          stablecoinKind === 'test' ? { kind: 'test' } : { kind: 'existing', address: stablecoinAddress.trim() },
      });
      setResult(response.result);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const textField = (
    key: 'key' | 'foundationRecipient' | 'stablecoinAddress' | 'currency' | 'explorer' | 'description',
    label: string,
    id: string,
  ) => (
    <label className="field">
      {label}
      <input
        className="input"
        data-testid={`stack-manager-${id}`}
        value={draft[key] ?? ''}
        onChange={event => update(key, event.target.value)}
      />
    </label>
  );
  return (
    <details className="card" data-testid="settings-stack-manager">
      <summary className="caps">Stack Manager</summary>
      <section data-testid="stack-manager-v1" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        <h3>Jurisdiction deployment</h3>
        {!authorized ? (
          <p className="note">
            Connect a remote runtime with administrator access. Deployment keys stay on that runtime.
          </p>
        ) : (
          <>
            <p className="note">
              Check the RPC, chain and signer before deploying. Contracts are saved after receipt and bytecode
              verification.
            </p>
            {status && (
              <p className="note">
                Runtime deployment: {status.phase}
                {status.error ? ` · ${status.error}` : ''}
              </p>
            )}
            <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
              <label className="field">
                RPC URL
                <input
                  className="input"
                  data-testid="stack-manager-rpc"
                  value={draft.rpcUrl}
                  onChange={event => update('rpcUrl', event.target.value)}
                />
              </label>
              <label className="field">
                Network name
                <input
                  className="input"
                  data-testid="stack-manager-name"
                  value={draft.name}
                  onChange={event => {
                    const name = event.target.value;
                    if (!draft.key || draft.key === keyForName(draft.name)) update('key', keyForName(name));
                    update('name', name);
                  }}
                />
              </label>
              <label className="field">
                Runtime signer
                <select
                  className="input"
                  data-testid="stack-manager-signer"
                  value={draft.signerId}
                  disabled={!signers.length}
                  style={{ maxWidth: '100%' }}
                  onChange={event => {
                    const signer = event.target.value;
                    if (!signers.includes(signer)) throw new Error('Unknown runtime signer');
                    if (signers.includes(draft.foundationRecipient)) update('foundationRecipient', signer);
                    update('signerId', signer);
                  }}
                >
                  {!signers.length && <option value="">No unlocked signer</option>}
                  {signers.map(signer => (
                    <option key={signer} value={signer}>
                      {signer}
                    </option>
                  ))}
                </select>
              </label>
              <p className="note">
                Chain ID: <strong>{probe?.chainId ?? '—'}</strong>
                <br />
                Signer balance: {probe ? `${formatEther(probe.nativeBalanceWei)} native` : 'Not checked'}
              </p>
              <button
                type="button"
                className="btn"
                data-testid="stack-manager-refresh"
                disabled={!draft.rpcUrl.trim() || !draft.signerId}
                onClick={() => void refresh()}
              >
                Refresh RPC & balance
              </button>
              <details className="disclosure">
                <summary>Advanced deployment parameters</summary>
                {textField('key', 'Jurisdiction key', 'key')}
                {textField('foundationRecipient', 'Foundation recipient / stack admin', 'foundation')}
                <label className="field">
                  Stablecoin
                  <select
                    className="input"
                    data-testid="stack-manager-stablecoin"
                    value={draft.stablecoinKind}
                    onChange={event => {
                      const value = event.target.value;
                      if (value === 'existing' || value === 'test') update('stablecoinKind', value);
                    }}
                  >
                    <option value="existing">Existing 6-decimal USDT</option>
                    <option value="test">Deploy explicit test token</option>
                  </select>
                </label>
                {draft.stablecoinKind === 'existing' && textField('stablecoinAddress', 'USDT address', 'usdt')}
                <label className="field">
                  Publication
                  <select
                    className="input"
                    data-testid="stack-manager-publication"
                    value={draft.publication}
                    onChange={event => {
                      const value = event.target.value;
                      if (value === 'local' || value === 'community' || value === 'official')
                        update('publication', value);
                    }}
                  >
                    <option value="local">Local discovery only</option>
                    <option value="community">Community Gossip</option>
                    <option value="official">Official Foundation stack</option>
                  </select>
                </label>
                <label className="field">
                  Receipt confirmations
                  <input
                    className="input"
                    type="number"
                    min="1"
                    step="1"
                    data-testid="stack-manager-confirmations"
                    value={draft.confirmations}
                    onChange={event => update('confirmations', Number(event.target.value))}
                  />
                </label>
                <label className="field">
                  Block time (ms)
                  <input
                    className="input"
                    type="number"
                    min="1"
                    step="1"
                    data-testid="stack-manager-block-time"
                    value={draft.blockTimeMs}
                    onChange={event => update('blockTimeMs', Number(event.target.value))}
                  />
                </label>
                {textField('currency', 'Native currency', 'currency')}
                {textField('explorer', 'Block explorer URL', 'explorer')}
                {textField('description', 'Description', 'description')}
              </details>
              <label className="note" style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
                <input
                  type="checkbox"
                  data-testid="stack-manager-confirm"
                  checked={confirmed}
                  onChange={event => setConfirmed(event.target.checked)}
                />
                I verified the RPC, chain ID, signer, gas balance, recipient and token configuration.
              </label>
              <button
                type="button"
                className="btn primary"
                data-testid="stack-manager-deploy"
                disabled={!ready}
                onClick={() => void deploy()}
              >
                {busy ? 'Deploying and verifying…' : 'Deploy V1 stack'}
              </button>
            </fieldset>
            {error && (
              <p className="note" data-testid="stack-manager-error" role="alert">
                {error}
              </p>
            )}
            {result && (
              <div data-testid="stack-manager-result">
                <h4>{result.localJurisdiction.name} deployed</h4>
                <p className="note">
                  Chain {result.manifest.chainId} · block {result.manifest.entityProviderDeploymentBlock} ·{' '}
                  {result.publication.scope} {result.publication.status.replaceAll('_', ' ')}
                </p>
                {Object.entries(result.manifest.contracts).map(([name, address]) => (
                  <p className="note" key={name}>
                    {name}
                    <br />
                    <CopyId value={address} label={name} full />
                  </p>
                ))}
                <p className="note">
                  USDT
                  <br />
                  <CopyId value={result.manifest.registeredTokens.USDT.address} label="USDT" full />
                </p>
              </div>
            )}
          </>
        )}
      </section>
    </details>
  );
}
