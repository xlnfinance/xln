import { useState } from 'react';
import type { AccountCustomContract, CustomContractTransition } from '@xln/core/types/finance/custom-contract';
import type { AccountView } from '../../runtime/views';
import { ArgumentFields, fieldArguments, type FieldValues } from './ArgumentFields';
import { verifyClause, simulateClause, encodeClauseFields, decodeClauseValues } from '../../runtime/financial/custom-contracts';

export function ContractReview({ id, clause, account, submit, onDispute }: {
  id: string; clause: AccountCustomContract; account: AccountView;
  submit: (transition: CustomContractTransition) => Promise<void>;
  onDispute: (args: string) => Promise<void>;
}) {
  const [verified, setVerified] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [left, setLeft] = useState<FieldValues>({}); const [right, setRight] = useState<FieldValues>({});
  const [gas, setGas] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const reference = { id, createdHeight: clause.createdHeight, revision: clause.revision };
  const encodeArguments = (fields: typeof clause.schemas.params, values: FieldValues) =>
    fields.every(field => values[field.name] === undefined || values[field.name] === '') ? '0x' : encodeClauseFields(fields, fieldArguments(fields, values));
  const argumentsPair = () => ({ leftArguments: encodeArguments(clause.schemas.leftArguments, left),
    rightArguments: encodeArguments(clause.schemas.rightArguments, right) });
  const resolve = async (cancel: boolean) => {
    const args = cancel ? { leftArguments: '0x', rightArguments: '0x' } : argumentsPair();
    const result = cancel ? { effects: [], gas: '0' } : await simulateClause(clause, account.doc, args.leftArguments, args.rightArguments);
    setGas(result.gas); await submit({ ...reference, kind: 'resolve', ...args, effects: result.effects });
  };
  const confirm = async () => {
    const resolution = clause.resolution;
    if (!resolution) throw new Error('No resolution proposal');
    const result = resolution.effects.length === 0 && resolution.leftArguments === '0x' && resolution.rightArguments === '0x'
      ? { effects: [], gas: '0' } : await simulateClause(clause, account.doc, resolution.leftArguments, resolution.rightArguments);
    if (result.effects.length !== resolution.effects.length || result.effects.some((effect, i) =>
      effect.tokenId !== resolution.effects[i]?.tokenId || effect.amount !== resolution.effects[i]?.amount)) throw new Error('Simulation differs from the proposed effects; do not sign');
    setGas(result.gas); await submit({ ...reference, kind: 'confirm' });
  };
  return <section className="card stack" data-testid="custom-contract" data-status={clause.status} style={{ gap: 12 }}>
    <h2>{clause.contractName} · {clause.status}</h2>
    <p className="note">{clause.proposerIsLeft === account.isLeft ? 'You proposed' : 'Counterparty proposed'} · Revision {clause.revision}</p>
    <details><summary>Signed source and parameters</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{clause.source}</pre>
      {decodeClauseValues(clause.schemas.params, clause.encodedBatch).map(value => <p key={value}>{value}</p>)}
      <p className="note">Counterfactual address: {clause.transformerAddress}</p></details>
    {clause.allowances.map(row => <p key={row.tokenId} className="note">Token {row.tokenId}: left may receive ≤ {String(row.leftAllowance)}; right may receive ≤ {String(row.rightAllowance)} smallest units.</p>)}
    <button className="btn" disabled={busy} data-testid="contract-verify" onClick={() => void run(async () => { await verifyClause(clause); setVerified(true); })}>{verified ? 'Source verified' : 'Compile and verify signed source'}</button>
    {clause.status === 'proposed' && clause.proposerIsLeft !== account.isLeft ? <div className="actions">
      <button className="btn primary" disabled={busy || !verified} data-testid="contract-approve" onClick={() => void run(() => submit({ ...reference, kind: 'approve' }))}>Approve spending limits</button>
      <button className="btn" disabled={busy} data-testid="contract-reject" onClick={() => void run(() => submit({ ...reference, kind: 'reject' }))}>Reject</button></div> : null}
    {clause.status === 'active' ? <>
      <h3>Execution arguments</h3><p className="note">Left is {account.isLeft ? 'you' : 'counterparty'}. Arguments are included in the resolution proposal. Both parties must confirm the effect.</p>
      <h4>Left arguments</h4><ArgumentFields fields={clause.schemas.leftArguments} values={left} onChange={setLeft} prefix="left-arg" />
      <h4>Right arguments</h4><ArgumentFields fields={clause.schemas.rightArguments} values={right} onChange={setRight} prefix="right-arg" />
      <div className="actions"><button className="btn primary" disabled={busy || !verified} data-testid="contract-resolve" onClick={() => void run(() => resolve(false))}>Simulate and propose resolution</button>
        <button className="btn" disabled={busy} data-testid="contract-cancel" onClick={() => void run(() => resolve(true))}>Propose cancellation</button></div>
      {clause.resolution ? <div><h4>Resolution awaiting confirmation</h4><pre>{clause.resolution.effects.map(effect => `Token ${effect.tokenId}: ${effect.amount}`).join('\n') || 'Cancel clause without payment'}</pre>
        <p className="note">Left arguments: {clause.resolution.leftArguments}<br />Right arguments: {clause.resolution.rightArguments}</p>
        {clause.resolution.proposerIsLeft !== account.isLeft ? <button className="btn primary" disabled={busy || !verified} data-testid="contract-confirm" onClick={() => void run(confirm)}>Verify effects and confirm</button> : <p className="note">Waiting for counterparty.</p>}</div> : null}
      <button className="btn" disabled={busy || !verified} data-testid="contract-dispute" onClick={() => void run(() => {
        const args = argumentsPair(); return onDispute(account.isLeft ? args.leftArguments : args.rightArguments);
      })}>Enforce through jurisdiction</button>
    </> : null}
    {gas ? <p className="note">Simulation execution gas: {gas}. Deployment and finalization are estimated separately by the J submitter.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
