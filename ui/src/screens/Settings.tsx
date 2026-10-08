import { Networks } from '../components/Networks';
import { PageHead } from '../components/PageHead';
import { CopyId } from '../components/CopyId';
import { Appearance } from '../components/settings/Appearance';
import { BalanceSettings, ScalePreview } from '../components/settings/BalanceSettings';
import { Profile } from '../components/settings/Profile';
import { Vault } from '../components/settings/Vault';
import { useState } from 'react';
import { peekXLN } from '../runtime/xln-loader';
import { getAdapter, getEmbeddedEnv } from '../runtime/adapter';
import { useApp } from '../runtime/store';

export function SettingsScreen() {
  const height = useApp(s => s.height);
  const usdPerPx = useApp(s => s.usdPerPx);
  const adapter = getAdapter();
  const [diagnostics, setDiagnostics] = useState('');
  const inspect = () => {
    const env = getEmbeddedEnv();
    if (!env) return setDiagnostics('No local runtime');
    const infra = env.infrastructure;
    const p2p = peekXLN()?.getP2P(env);
    setDiagnostics(JSON.stringify({
      height: env.state.height, phase: infra?.lifecyclePhase, loopActive: infra?.loopActive,
      halted: infra?.halted, fatal: infra?.fatalDebugPayload?.message,
      paused: infra?.persistencePaused, quiescing: infra?.persistenceQuiescing,
      inputsReady: infra?.entityInputsReady, networkInbox: env.networkInbox?.length,
      peers: p2p?.getDirectPeerState(), queues: p2p?.getQueueState(),
      accounts: [...env.state.eReplicas.values()].flatMap(entity => [...entity.state.accounts].map(([id, account]) => ({
        owner: entity.entityId, peer: id, height: account.currentHeight,
        pending: account.pendingFrame?.height, mempool: account.mempool.length,
      }))),
    }, null, 2));
  };
  return (
    <div className="screen fade-in">
      <PageHead title="Settings" eyebrow="Wallet" sub="Identity, appearance, the guided tour, runtime and vault." />
      <div className="two-col">
        <div className="flat-col">
          <Profile />
          <Appearance />
          <BalanceSettings />
          <div className="sect">
            <h3 className="caps">Runtime</h3>
          </div>
          <Networks />
          <div className="setting first">
            <div className="t">Mode</div>
            <span className="muted">{adapter?.mode ?? '—'}</span>
          </div>
          <div className="setting" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
            <div className="t">Runtime id</div>
            <CopyId value={adapter ? adapter.runtimeId : ''} label="Runtime id" full />
          </div>
          <div className="setting">
            <div className="t">Frame</div>
            <span className="mono muted">#{height.toLocaleString('en-US')}</span>
          </div>

          <details className="disclosure">
            <summary>Connection diagnostics</summary>
            <button type="button" className="btn sm" onClick={inspect}>Inspect connection</button>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{diagnostics}</pre>
          </details>
          <Vault />
        </div>
        <div className="aside">
          <ScalePreview usdPerPx={usdPerPx} />
        </div>
      </div>
    </div>
  );
}
