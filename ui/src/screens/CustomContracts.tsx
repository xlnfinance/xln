import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CompiledClause } from '@xln/core/runtime/custom-contracts/types';
import { useApp } from '../runtime/store';
import { useWallet } from '../runtime/views';
import { postJson, readJson } from '../runtime/http';
import { sendEntityTxs } from '../runtime/tx';
import { loadClauseTemplates, compileClause, clauseProposal, submitClauseTransition, generateClauseSource,
  encodeClauseFields, type ClauseTemplate } from '../runtime/financial/custom-contracts';
import { ArgumentFields, fieldArguments, type FieldValues } from '../components/contracts/ArgumentFields';
import { ContractReview } from '../components/contracts/ContractReview';
import { PendingBatch } from '../components/PendingBatch';

export function CustomContracts() {
  const navigate = useNavigate(); const entityId = useApp(s => s.activeEntityId); const wallet = useWallet(entityId);
  const [templates, setTemplates] = useState<ClauseTemplate[]>([]); const [templateId, setTemplateId] = useState('');
  const [source, setSource] = useState(''); const [contractName, setContractName] = useState('');
  const [artifact, setArtifact] = useState<CompiledClause | null>(null); const [values, setValues] = useState<FieldValues>({});
  const [accountId, setAccountId] = useState(''); const [factory, setFactory] = useState('');
  const [tokenId, setTokenId] = useState(''); const [leftLimit, setLeftLimit] = useState('0'); const [rightLimit, setRightLimit] = useState('0');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [rules, setRules] = useState(''); const [models, setModels] = useState<string[]>([]); const [model, setModel] = useState('');
  const account = wallet.accounts.find(entry => entry.counterpartyId === accountId);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  useEffect(() => {
    void loadClauseTemplates().then(items => { setTemplates(items); const first = items[0]; if (first) {
      setTemplateId(first.id); setSource(first.source); setContractName(first.contractName);
    } }).catch(e => setError(String(e)));
    void fetch('/api/assistant/models').then(readJson).then(result => {
      const rows = result['models']; if (!Array.isArray(rows)) throw new Error('AI model catalog unavailable');
      const ids = rows.map(row => String(row.id)); setModels(ids); setModel(ids[0] ?? '');
    }).catch(e => setNotice(`AI unavailable: ${String(e)}. Templates and the source editor remain usable.`));
  }, []);
  useEffect(() => { if (!accountId && wallet.accounts[0]) setAccountId(wallet.accounts[0].counterpartyId); }, [accountId, wallet.accounts]);
  const domainKey = account ? `${account.doc.state.domain.chainId}:${account.doc.state.domain.depositoryAddress}` : '';
  useEffect(() => {
    setFactory(''); if (!account) return;
    let cancelled = false;
    void postJson('/api/custom-contracts/domain', account.doc.state.domain, 20_000, window.location.origin).then(result => {
      if (!cancelled) setFactory(String(result['factory']));
    }).catch(e => { if (!cancelled) setError(`Selected jurisdiction does not support custom contracts: ${String(e)}`); });
    return () => { cancelled = true; };
    // Only the immutable jurisdiction identity owns this request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainKey]);
  const changeTemplate = (id: string) => {
    const template = templates.find(item => item.id === id); if (!template) return;
    setTemplateId(id); setSource(template.source); setContractName(template.contractName); setArtifact(null); setValues({});
  };
  const submit = async (transition: Parameters<typeof submitClauseTransition>[3]) => {
    if (!account) throw new Error('Select an account');
    await submitClauseTransition(wallet.entityId, wallet.signerId, accountId, transition);
    setNotice('Submitted to Account consensus. The committed status below confirms acceptance.');
  };
  const propose = async () => {
    if (!artifact || artifact.source !== source || !factory || !account) throw new Error('Compile the current source and select a supported account');
    await submit(clauseProposal(artifact, factory, encodeClauseFields(artifact.schemas.params, fieldArguments(artifact.schemas.params, values)),
      [{ tokenId: Number(tokenId), leftAllowance: BigInt(leftLimit), rightAllowance: BigInt(rightLimit) }]));
  };
  const generate = async () => {
    const template = templates.find(item => item.id === templateId);
    if (!template || !rules.trim() || !model) throw new Error('Choose a model and describe the rules');
    const generated = await generateClauseSource(rules, model, template);
    setSource(generated); setContractName('CustomClause'); setArtifact(null); setValues({});
    setNotice('AI draft generated. Review the Solidity and compile before proposing.');
  };
  return <div className="screen fade-in stack" style={{ gap: 20 }}>
    <header className="page-head"><div><h1 className="page-title">Custom Contracts</h1><p className="page-sub">Signed Solidity rules inside an Account.</p></div>
      <button className="btn ghost" onClick={() => navigate('/manage')}>Back to Manage</button></header>
    <div className="card" role="note" data-testid="custom-expert-warning"><strong>Experimental · experts only</strong>
      <p>Both parties must review the code, arguments and maximum spending limits. A reverting or gas-heavy clause can block dispute finalization. AI output is an unverified draft. Revealed secrets become visible to the counterparty and, during disputes, to the jurisdiction.</p></div>
    <label className="field">Account<select className="input" data-testid="custom-account" value={accountId} onChange={e => setAccountId(e.target.value)}>
      <option value="">Select account</option>{wallet.accounts.map(item => <option key={item.counterpartyId} value={item.counterpartyId}>{item.label} · {item.counterpartyId.slice(0, 12)}</option>)}</select></label>
    <section className="card stack" style={{ gap: 12 }}><h2>Author a transformer</h2>
      <label className="field">Template<select className="input" data-testid="custom-template" value={templateId} onChange={e => changeTemplate(e.target.value)}>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <p className="note">{templates.find(t => t.id === templateId)?.description}</p>
      <details><summary>Generate Solidity with AI</summary><label className="field">Model<select className="input" value={model} onChange={e => setModel(e.target.value)}>{models.map(id => <option key={id}>{id}</option>)}</select></label>
        <label className="field">Rules<textarea className="input" data-testid="custom-ai-rules" maxLength={4000} value={rules} onChange={e => setRules(e.target.value)} /></label>
        <button className="btn" disabled={busy || !model} data-testid="custom-ai-generate" onClick={() => void run(generate)}>Generate draft and argument form</button></details>
      <label className="field">Contract name<input className="input" data-testid="custom-name" value={contractName} onChange={e => { setContractName(e.target.value); setArtifact(null); }} /></label>
      <label className="field">Solidity source<textarea className="input" data-testid="custom-source" style={{ minHeight: 300, fontFamily: 'monospace' }} value={source} onChange={e => { setSource(e.target.value); setArtifact(null); }} /></label>
      <button className="btn primary" disabled={busy || !source} data-testid="custom-compile" onClick={() => void run(async () => { setArtifact(await compileClause(source, contractName)); setValues({}); })}>{busy ? 'Working…' : 'Compile Solidity'}</button>
      {artifact ? <><p data-testid="custom-compiled">Compiled with {artifact.compilerVersion} · {(artifact.runtimeBytecode.length - 2) / 2} code bytes</p>
        <h3>Signed parameters</h3><ArgumentFields fields={artifact.schemas.params} values={values} onChange={setValues} prefix="param" />
        <h3>Maximum spending limits</h3><p className="note">Smallest token units. These caps reserve the payer’s capacity only after the counterparty approves.</p>
        <label className="field">Allowance token<select className="input" data-testid="custom-token" value={tokenId} onChange={e => setTokenId(e.target.value)}><option value="">Select token</option>{account?.tokens.map(t => <option key={t.tokenId} value={t.tokenId}>{t.tokenId}</option>)}</select></label>
        <label className="field">Left may receive<input className="input" data-testid="custom-left-limit" value={leftLimit} onChange={e => setLeftLimit(e.target.value)} /></label>
        <label className="field">Right may receive<input className="input" data-testid="custom-right-limit" value={rightLimit} onChange={e => setRightLimit(e.target.value)} /></label>
        <button className="btn primary" disabled={busy || !factory || !tokenId || account?.disputed} data-testid="custom-propose" onClick={() => void run(propose)}>Propose to counterparty</button></> : null}
    </section>
    {error ? <p role="alert" data-testid="custom-error">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {account ? [...(account.doc.state.subcontracts ?? [])].map(([id, clause]) => <ContractReview key={`${id}:${clause.createdHeight}`} id={id} clause={clause} account={account} submit={submit}
      onDispute={async args => {
        const data = { counterpartyEntityId: accountId, customArguments: { [id]: args } };
        const active = account.doc.activeDispute;
        if (active?.observedOnChain) {
          await sendEntityTxs(wallet.entityId, wallet.signerId, [{ type: 'disputeFinalize', data }]);
        } else await sendEntityTxs(wallet.entityId, wallet.signerId, [{ type: 'prepareDispute', data }]);
        setNotice('Dispute action queued. Sign and send the batch below; starter arguments are sealed when the dispute starts.');
      }} />) : null}
    <PendingBatch wallet={wallet} />
  </div>;
}
