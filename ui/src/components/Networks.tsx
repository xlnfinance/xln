import { useState } from 'react';
import { getEmbeddedEnv } from '../runtime/adapter';
import { CONTRACT_FIELDS, connectNetwork, type NetworkDraft } from '../runtime/network';
import { useApp } from '../runtime/store';
import { CopyId } from './CopyId';

const INITIAL: NetworkDraft = { name: '', rpc: '', chainId: '', ticker: 'ETH', blockTimeMs: '12000', deploymentBlock: '', contracts: { depository: '', entityProvider: '', account: '', deltaTransformer: '' } };
const LABELS: Record<keyof Omit<NetworkDraft, 'contracts'>, string> = { name: 'Name', rpc: 'RPC endpoint', chainId: 'Chain id', ticker: 'Currency ticker', blockTimeMs: 'Block time (ms)', deploymentBlock: 'EntityProvider deployment block' };

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
      setNotice({ error: false, text: `${draft.name.trim()} connected. Create or select an entity on this network to use it.` });
      setDraft(INITIAL);
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  };
  return <details className="card" data-testid="settings-networks">
    <summary className="caps">Networks</summary>
    {!env ? <p className="note">Manage networks on the device hosting this runtime.</p> : <>
      {[...env.state.jReplicas.entries()].map(([name, network]) => <details key={name} className="setting" style={{ display: 'block' }}>
        <summary>{name} · chain {network.chainId}</summary>
        <p className="note">Depository {network.contracts?.depository ? <CopyId value={network.contracts.depository} label="Depository" /> : 'Not configured'}</p>
        <p className="note">EntityProvider {network.contracts?.entityProvider ? <CopyId value={network.contracts.entityProvider} label="EntityProvider" /> : 'Not configured'}</p>
      </details>)}
      <details><summary>Add a network</summary>
        <p className="note">Connect an existing xln deployment. Verify its network and contract addresses before using it.</p>
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          {(Object.keys(LABELS) as Array<keyof typeof LABELS>).map(key => <label className="field" key={key}>{LABELS[key]}
            <input className="input" data-testid={`network-${key}`} required value={draft[key]} disabled={busy} onChange={event => setDraft(value => ({ ...value, [key]: event.target.value }))} />
          </label>)}
          {CONTRACT_FIELDS.map(key => <label className="field" key={key}>{key}
            <input className="input mono" data-testid={`network-contract-${key}`} required value={draft.contracts[key]} disabled={busy} onChange={event => setDraft(value => ({ ...value, contracts: { ...value.contracts, [key]: event.target.value } }))} />
          </label>)}
          <button className="btn primary" data-testid="network-connect" disabled={busy}>{busy ? 'Verifying network…' : 'Verify and connect'}</button>
        </form>
      </details>
    </>}
    {notice && <p className="note" data-testid="network-notice" role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
  </details>;
}
