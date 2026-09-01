import { useState, useSyncExternalStore } from 'react';

import type { QaFailureInboxItem, QaView } from '../../../packages/runtime-client/src/qa-types';
import { OpsShell } from './ops-shell';
import { OpsQaBenchmarks, OpsQaCatalog } from './ops-qa-catalog';
import { OpsQaEvidenceBoard, OpsQaGallery } from './ops-qa-gallery';
import { OpsQaHistory } from './ops-qa-history';
import { opsQaSource } from './ops-qa-runtime';
import { OpsQaRunView } from './ops-qa-run';
import { OpsQaRunRail, OpsQaVerdict } from './ops-qa-summary';
import { OpsQaTestLedger } from './ops-qa-test-ledger';
import './styles/ops-qa.css';
import './styles/ops-qa-detail.css';

const TABS: readonly Readonly<{ id: QaView; label: string }>[] = [
  { id: 'gallery', label: 'UX Gallery' }, { id: 'e2e', label: 'Runs Ledger' },
  { id: 'scenarios', label: 'Scenario Player' }, { id: 'suites', label: 'Suites' },
  { id: 'benchmarks', label: 'Benchmarks' }, { id: 'history', label: 'Database' },
];

export function OpsQaPage() {
  const source = useSyncExternalStore(opsQaSource.subscribe, opsQaSource.getSnapshot, opsQaSource.getSnapshot);
  const [activeView, setActiveView] = useState<QaView>('gallery');
  const [token, setToken] = useState('');
  const [storyIndex, setStoryIndex] = useState<number | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const openFailure = async (item: QaFailureInboxItem): Promise<void> => {
    if (item.runId) await opsQaSource.selectRun(item.runId);
    const current = opsQaSource.getSnapshot();
    const run = current.selectedRun;
    if (run) {
      const explicit = item.shard === undefined ? -1 : run.shards.findIndex(shard => shard.shard === item.shard);
      const failed = run.shards.findIndex(shard => shard.status === 'failed');
      opsQaSource.selectShard(explicit >= 0 ? explicit : failed >= 0 ? failed : 0);
    }
    setActiveView('e2e');
  };
  const openStoryShard = (index: number): void => {
    opsQaSource.selectShard(index);
    setActiveView('e2e');
  };
  const applyToken = async (): Promise<void> => {
    setAuthBusy(true);
    try { await opsQaSource.applyToken(token); } finally { setAuthBusy(false); }
  };
  const clearToken = async (): Promise<void> => {
    setAuthBusy(true); setToken('');
    try { await opsQaSource.clearToken(); } finally { setAuthBusy(false); }
  };

  return <OpsShell activePath="/qa">
    <div className="ops-qa" data-testid="qa-cockpit">
      <header className="ops-qa-header">
        <div><span>OPERATOR EVIDENCE / EXACT</span><h1>Test Cockpit</h1><p>Inspect run authority, browser failures, performance regression, artifacts, and controlled recovery.</p></div>
        <div><label><input checked={source.autoRefresh} onChange={event => opsQaSource.setAutoRefresh(event.currentTarget.checked)} type="checkbox" /> Auto refresh</label><button disabled={source.refreshing} onClick={() => void opsQaSource.refresh()} type="button">{source.refreshing ? 'Refreshing…' : 'Refresh evidence'}</button><a href="/qa/hlt">Open HLT</a></div>
      </header>
      <section className="ops-qa-auth" data-auth={source.auth} data-testid="qa-auth-panel"><div><span>QA ACCESS</span><strong>{source.auth}</strong></div>{source.auth === 'open' ? <p>Server authentication is explicitly disabled.</p> : <form className="ops-qa-auth-controls" onSubmit={event => { event.preventDefault(); void applyToken(); }}><label>Admin token<input autoComplete="off" onChange={event => setToken(event.currentTarget.value)} placeholder="optional — admin actions only" type="password" value={token} /></label><button disabled={authBusy} type="submit">Apply</button><button disabled={authBusy} onClick={() => void clearToken()} type="button">Clear</button></form>}</section>
      {source.error ? <section className="ops-qa-error" role="alert"><span>QA READ FAILED</span><strong>{source.error}</strong><button onClick={() => void opsQaSource.refresh()} type="button">Retry</button></section> : null}
      <OpsQaTestLedger rows={source.testLedger} />
      <nav className="ops-qa-tabs" data-testid="qa-test-tabs">{TABS.map(tab => <button aria-current={activeView === tab.id ? 'page' : undefined} key={tab.id} onClick={() => setActiveView(tab.id)} type="button">{tab.label}</button>)}<a data-testid="qa-hlt-tab" href="/qa/hlt">HLT</a></nav>
      <OpsQaVerdict onOpenFailure={item => void openFailure(item)} source={source} />
      <div className="ops-qa-layout">
        <OpsQaRunRail onSelectRun={runId => { void opsQaSource.selectRun(runId); }} source={source} />
        <div className="ops-qa-workspace">
          <OpsQaEvidenceBoard onOpenShard={openStoryShard} onOpenStory={index => { setStoryIndex(index); setActiveView('gallery'); }} source={source} />
          {activeView === 'gallery' ? <OpsQaGallery onSelectStory={setStoryIndex} releasePack={source.releasePack} selectedStoryIndex={storyIndex} stories={source.stories} /> : null}
          {activeView === 'e2e' ? <OpsQaRunView onRefresh={opsQaSource.refresh} onSelectShard={opsQaSource.selectShard} source={source} /> : null}
          {activeView === 'scenarios' ? <section className="ops-qa-scenario"><header><span>DETERMINISTIC SCENARIOS</span><h2>Scenario Player</h2><p>Visual Runtime scenarios with wallet preview and frame scrubbing.</p></header><iframe allowFullScreen data-testid="qa-scenario-player-frame" loading="lazy" src="/scenarios" title="Scenario Player" /></section> : null}
          {activeView === 'suites' ? <OpsQaCatalog onRefresh={opsQaSource.refresh} source={source} /> : null}
          {activeView === 'benchmarks' ? <OpsQaBenchmarks source={source} /> : null}
          {activeView === 'history' ? <OpsQaHistory onRefresh={opsQaSource.refresh} source={source} /> : null}
          {source.status === 'loading' ? <p className="ops-qa-empty">Loading QA evidence…</p> : null}
        </div>
      </div>
    </div>
  </OpsShell>;
}
