import { useSyncExternalStore } from 'react';

import { walletScenarioPreviewSource } from './wallet-scenario-preview-runtime';
import './styles/wallet-scenario-preview.css';

export function WalletScenarioPreview() {
  const snapshot = useSyncExternalStore(
    walletScenarioPreviewSource.subscribe,
    walletScenarioPreviewSource.getSnapshot,
    walletScenarioPreviewSource.getSnapshot,
  );
  return <section className="wallet-scenario-preview" data-state={snapshot.status} data-testid="scenario-preview-wallet-banner">
    <header><div><p>Deterministic scenario preview</p><h1>{snapshot.option.title}</h1><span>Reconstructed from the scenario ID and committed frame index. No live wallet state is replaced.</span></div><a href={`/scenarios#${snapshot.option.id}`}>Back to player</a></header>
    {snapshot.status === 'loading' ? <div className="wallet-scenario-state">Running the Runtime scenario…</div> : null}
    {snapshot.status === 'error' ? <div className="wallet-scenario-state is-error" role="alert">{snapshot.error}</div> : null}
    {snapshot.status === 'ready' ? <div className="wallet-scenario-body"><div className="wallet-scenario-graph"><svg aria-label="Scenario wallet graph" viewBox="0 0 100 64">{snapshot.visual.edges.map(edge => <line className={edge.disputed ? 'is-disputed' : undefined} key={edge.key} x1={edge.from.x} x2={edge.to.x} y1={edge.from.y} y2={edge.to.y} />)}{snapshot.visual.nodes.map(node => <g className={node.isHub ? 'is-hub' : undefined} key={node.id}><circle cx={node.x} cy={node.y} r={node.isHub ? 4.8 : 4.1} /><text x={node.x} y={node.y + 8.2}>{node.label}</text></g>)}</svg></div><aside><p>Committed frame {snapshot.currentFrame + 1}/{snapshot.frameCount}</p><h2>{snapshot.visual.title}</h2><span>{snapshot.visual.description}</span><dl><div><dt>Height</dt><dd>{snapshot.height}</dd></div><div><dt>Entities</dt><dd>{snapshot.visual.nodes.length}</dd></div><div><dt>Accounts</dt><dd>{snapshot.visual.accountCount}</dd></div><div><dt>Disputes</dt><dd>{snapshot.visual.activeDisputes}</dd></div></dl><a href="/app">Exit preview</a></aside></div> : null}
  </section>;
}
