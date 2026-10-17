import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CompiledClause } from '@xln/core/runtime/custom-contracts/types';
import { readJson } from '../runtime/http';
import { loadClauseTemplates, compileClause, generateClauseSource, type ClauseTemplate } from '../runtime/financial/custom-contracts';
import { encodeClauseFields } from '@xln/core/protocol/dispute/custom-contract-abi';
import { ArgumentFields, fieldArguments, type FieldValues } from '../components/contracts/ArgumentFields';

/** Ephemeral source laboratory. No Account proposal, durable program or J deployment path. */
export function CustomContracts() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<ClauseTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [source, setSource] = useState('');
  const [contractName, setContractName] = useState('');
  const [artifact, setArtifact] = useState<CompiledClause | null>(null);
  const [values, setValues] = useState<FieldValues>({});
  const [encoded, setEncoded] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rules, setRules] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (error) { setError(String(error)); } finally { setBusy(false); }
  };
  const selectTemplate = (id: string, items = templates) => {
    const template = items.find(item => item.id === id);
    if (!template) throw new Error('Unknown contract template');
    setTemplateId(id); setSource(template.source); setContractName(template.contractName); setArtifact(null); setEncoded('');
  };
  useEffect(() => {
    void loadClauseTemplates().then(items => {
      setTemplates(items); if (items[0]) selectTemplate(items[0].id, items);
    }).catch(error => setError(String(error)));
    void fetch('/api/assistant/models').then(readJson).then(result => {
      const rows = result['models']; if (!Array.isArray(rows)) throw new Error('AI model catalog unavailable');
      const ids = rows.map(row => String(row.id)); setModels(ids); setModel(ids[0] ?? '');
    }).catch(error => setNotice('AI unavailable: ' + String(error)));
  }, []);
  const generate = async () => {
    const template = templates.find(item => item.id === templateId);
    if (!template || !rules.trim() || !model) throw new Error('Choose a model and describe the rules');
    setSource(await generateClauseSource(rules, model, template)); setContractName('CustomClause'); setArtifact(null);
  };
  return <div className="screen fade-in stack" style={{ gap: 20 }}>
    <header className="page-head"><h1 className="page-title">Contract source preview</h1><button className="btn ghost" onClick={() => navigate('/manage')}>Back to Manage</button></header>
    <div className="card" role="note" data-testid="custom-expert-warning"><strong>Experimental · experts only</strong>
      <p data-testid="custom-unavailable">New custom-contract admission is unavailable. Arbitrary programs have no bounded dispute-gas proof. This tool only compiles and previews source; it cannot submit financial state. AI drafts are unverified.</p></div>
    <section className="card stack" style={{ gap: 16 }}>
      <label className="field">Template<select className="input" data-testid="custom-template" value={templateId} onChange={event => selectTemplate(event.target.value)}>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
      <details><summary>AI source draft</summary><label className="field">Model<select className="input" value={model} onChange={event => setModel(event.target.value)}>{models.map(id => <option key={id}>{id}</option>)}</select></label>
        <label className="field">Rules<textarea className="input" maxLength={4000} value={rules} onChange={event => setRules(event.target.value)} /></label>
        <button className="btn" disabled={busy || !model} onClick={() => void run(generate)}>Generate draft</button></details>
      <label className="field">Contract name<input className="input" value={contractName} onChange={event => { setContractName(event.target.value); setArtifact(null); }} /></label>
      <label className="field">Solidity source<textarea className="input" data-testid="custom-source" style={{ minHeight: 300, fontFamily: 'monospace' }} value={source} onChange={event => { setSource(event.target.value); setArtifact(null); }} /></label>
      <button className="btn primary" disabled={busy || !source} data-testid="custom-compile" onClick={() => void run(async () => { setArtifact(await compileClause(source, contractName)); setValues({}); setEncoded(''); })}>{busy ? 'Working…' : 'Compile Solidity'}</button>
      {artifact ? <><p data-testid="custom-compiled">Compiled with {artifact.compilerVersion} · {(artifact.runtimeBytecode.length - 2) / 2} code bytes</p>
        <ArgumentFields fields={artifact.schemas.params} values={values} onChange={setValues} prefix="param" />
        <button className="btn" onClick={() => void run(async () => { setEncoded(encodeClauseFields(artifact.schemas.params, fieldArguments(artifact.schemas.params, values))); })}>Preview encoded parameters</button>
        {encoded ? <code>{encoded}</code> : null}</> : null}
    </section>
    {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
  </div>;
}
