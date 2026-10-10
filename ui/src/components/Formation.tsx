import { useState } from 'react';
import { getEmbeddedEnv } from '../runtime/adapter';
import { useApp } from '../runtime/store';
import { useWallet } from '../runtime/views';
import { formEntity, type BoardMember } from '../runtime/financial/formation';
import { CopyId } from './CopyId';

export function Formation() {
  const entityId = useApp(state => state.activeEntityId);
  const wallet = useWallet(entityId);
  const networks = [...(getEmbeddedEnv()?.state.jReplicas.keys() ?? [])];
  const [name, setName] = useState('');
  const [network, setNetwork] = useState(wallet.jurisdiction);
  const [kind, setKind] = useState<'lazy' | 'numbered'>('numbered');
  const [shared, setShared] = useState(false);
  const [members, setMembers] = useState<BoardMember[]>([]);
  const [threshold, setThreshold] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof formEntity>> | null>(null);
  const board = shared ? members : [{ name: wallet.signerId, weight: 1 }];
  const total = board.reduce((sum, member) => sum + member.weight, 0);
  const submit = async () => {
    setBusy(true); setError(''); setResult(null);
    try { setResult(await formEntity({ name, jurisdiction: network || networks[0] || '', kind, members: board, threshold: shared ? threshold : 1, signerId: wallet.signerId })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <details className="card" data-testid="entity-formation">
    <summary className="caps">Create an entity</summary>
    <p className="note">Separate your personal wallet, business or shared treasury. Each has its own accounts and approval rules.</p>
    {!networks.length ? <p className="note">Connect a network on this device first.</p> : <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0 }}>
        <label className="field">Name<input className="input" required value={name} onChange={event => setName(event.target.value)} data-testid="formation-name" /></label>
        <label className="field">Network<select className="input" value={network || networks[0]} onChange={event => setNetwork(event.target.value)}>{networks.map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="field">Identity<select className="input" value={kind} onChange={event => setKind(event.target.value as typeof kind)} data-testid="formation-kind"><option value="numbered">Registered · on-chain identity and shares</option><option value="lazy">Self-issued · identity fixed by its board</option></select></label>
        <p className="note">{kind === 'numbered' ? 'Registration spends network gas from your signing wallet.' : 'No registration transaction. Changing this board produces a different entity id.'}</p>
        <label className="field"><span><input type="checkbox" checked={shared} onChange={event => { setShared(event.target.checked); if (!members.length) setMembers([{ name: wallet.signerId, weight: 1 }]); }} /> Shared approval</span></label>
        {shared && <>
          {members.map((member, index) => <div className="field-row" key={index}>
            <label className="field">Signer address<input className="input mono" required value={member.name} onChange={event => setMembers(rows => rows.map((row, i) => i === index ? { ...row, name: event.target.value } : row))} /></label>
            <label className="field">Weight<input className="input" type="number" min="1" max="65535" required value={member.weight} onChange={event => setMembers(rows => rows.map((row, i) => i === index ? { ...row, weight: Number(event.target.value) } : row))} /></label>
            <button type="button" className="btn quiet" aria-label={`Remove signer ${index + 1}`} disabled={members.length === 1} onClick={() => setMembers(rows => rows.filter((_, i) => i !== index))}>Remove</button>
          </div>)}
          <button type="button" className="btn quiet" onClick={() => { setMembers(rows => [...rows, { name: '', weight: 1 }]); setThreshold(total + 1); }}>Add signer</button>
          <label className="field">Required voting weight · total {total}<input className="input" type="number" min="1" max={total} required value={threshold} onChange={event => setThreshold(Number(event.target.value))} /></label>
          <p className="note">Signers must operate their own runtimes. Funds may become inaccessible if the required signing weight is unavailable.</p>
        </>}
        <button className="btn primary" disabled={!wallet.signerId} data-testid="formation-submit">{busy ? 'Creating…' : kind === 'numbered' ? 'Register on-chain' : 'Create entity'}</button>
      </fieldset>
    </form>}
    {error && <p className="note" role="alert">{error}</p>}
    {result && <div role="status" data-testid="formation-result" data-entity-id={result.entityId}><p>{result.imported ? 'Entity created. Select it in your entity switcher.' : 'Board registered. Its members can import the configuration.'}</p><CopyId value={result.entityId} label="Created entity id" />{result.transactionHash && <p><CopyId value={result.transactionHash} label="Registration transaction" /></p>}</div>}
  </details>;
}
