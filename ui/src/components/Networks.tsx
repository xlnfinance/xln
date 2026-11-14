import { useState } from 'react';
import { getJurisdictionIdentityRef } from '@xln/core/jurisdiction/machine/jurisdiction-runtime';
import { getEmbeddedEnv } from '../runtime/adapter';
import { CONTRACT_FIELDS, connectNetwork, replaceNetworkRpc, type NetworkDraft } from '../runtime/network';
import { useApp } from '../runtime/store';
import { CopyId } from './CopyId';

const INITIAL: NetworkDraft = {
  name: '',
  rpc: '',
  chainId: '',
  ticker: 'ETH',
  blockTimeMs: '12000',
  deploymentBlock: '',
  contracts: { depository: '', entityProvider: '', account: '', deltaTransformer: '' },
};
const LABELS: Record<keyof Omit<NetworkDraft, 'contracts'>, string> = {
  name: 'Name',
  rpc: 'RPC endpoint',
  chainId: 'Chain id',
  ticker: 'Currency ticker',
  blockTimeMs: 'Block time (ms)',
  deploymentBlock: 'EntityProvider deployment block',
};

export function NetworkRpc({
  name,
  published,
  onReplaced,
}: {
  name: string;
  published: string;
  onReplaced?: () => void;
}) {
  const [rpc, setRpc] = useState('');
  const env = getEmbeddedEnv();
  const network = env?.state.jReplicas.get(name);
  const active =
    env && network
      ? (env.infrastructure?.trustedJurisdictionRpcUrls?.get(getJurisdictionIdentityRef(network).toLowerCase()) ??
        published)
      : published;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const replace = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await replaceNetworkRpc(name, rpc);
      setNotice({ error: false, text: `${name} RPC verified. Chain sync controls when new commands are ready.` });
      setRpc('');
      onReplaced?.();
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        void replace();
      }}
    >
      <p className="note">
        RPC{' '}
        <span className="mono" data-testid={`network-rpc-active-${name}`}>
          {active || 'none'}
        </span>
      </p>
      <label className="field">
        Use another RPC for this chain
        <input
          className="input mono"
          data-testid={`network-rpc-input-${name}`}
          required
          value={rpc}
          disabled={busy}
          onChange={event => setRpc(event.target.value)}
        />
      </label>
      <button className="btn" data-testid={`network-rpc-replace-${name}`} disabled={busy}>
        {busy ? 'Verifying RPC…' : 'Verify and use'}
      </button>
      {notice && (
        <p className="note" data-testid={`network-rpc-notice-${name}`} role={notice.error ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}
    </form>
  );
}

export function Networks() {
  useApp(state => state.height);
  const [draft, setDraft] = useState(INITIAL);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const env = getEmbeddedEnv();
  const submit = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await connectNetwork(draft);
      setNotice({
        error: false,
        text: `${draft.name.trim()} connected. Create or select an entity on this network to use it.`,
      });
      setDraft(INITIAL);
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="card" data-testid="settings-networks">
      <summary className="caps">Networks</summary>
      {!env ? (
        <p className="note">Manage networks on the device hosting this runtime.</p>
      ) : (
        <>
          {[...env.state.jReplicas.entries()].map(([name, network]) => (
            <details key={name} className="setting" style={{ display: 'block' }} data-testid={`network-row-${name}`}>
              <summary>
                {name} · chain {network.chainId}
              </summary>
              <p className="note">
                Depository{' '}
                {network.contracts?.depository ? (
                  <CopyId value={network.contracts.depository} label="Depository" />
                ) : (
                  'Not configured'
                )}
              </p>
              <p className="note">
                EntityProvider{' '}
                {network.contracts?.entityProvider ? (
                  <CopyId value={network.contracts.entityProvider} label="EntityProvider" />
                ) : (
                  'Not configured'
                )}
              </p>
              {network.rpcs?.length ? <NetworkRpc name={name} published={network.rpcs[0]!} /> : null}
            </details>
          ))}
          <details>
            <summary>Add a network</summary>
            <p className="note">
              Connect an existing xln deployment. Verify its network and contract addresses before using it.
            </p>
            <form
              onSubmit={event => {
                event.preventDefault();
                void submit();
              }}
            >
              {(Object.keys(LABELS) as Array<keyof typeof LABELS>).map(key => (
                <label className="field" key={key}>
                  {LABELS[key]}
                  <input
                    className="input"
                    data-testid={`network-${key}`}
                    required
                    value={draft[key]}
                    disabled={busy}
                    onChange={event => setDraft(value => ({ ...value, [key]: event.target.value }))}
                  />
                </label>
              ))}
              {CONTRACT_FIELDS.map(key => (
                <label className="field" key={key}>
                  {key}
                  <input
                    className="input mono"
                    data-testid={`network-contract-${key}`}
                    required
                    value={draft.contracts[key]}
                    disabled={busy}
                    onChange={event =>
                      setDraft(value => ({ ...value, contracts: { ...value.contracts, [key]: event.target.value } }))
                    }
                  />
                </label>
              ))}
              <button className="btn primary" data-testid="network-connect" disabled={busy}>
                {busy ? 'Verifying network…' : 'Verify and connect'}
              </button>
            </form>
          </details>
        </>
      )}
      {notice && (
        <p className="note" data-testid="network-notice" role={notice.error ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}
    </details>
  );
}
