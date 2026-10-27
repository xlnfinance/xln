import { getJurisdictionBadgeInfo } from '@xln/frontend/lib/utils/identity/jurisdictionBadge';
import { useApp } from '../runtime/store';
import { chainSyncText } from '../runtime/chain-catchup';
import type { WalletView } from '../runtime/views';
import '@xln/frontend/lib/utils/identity/jurisdiction-theme.css';

export function JurisdictionBanner({ wallet }: { wallet: WalletView }) {
  const setTour = useApp(s => s.setTour);
  const tour = useApp(s => s.tour);
  const chainSync = useApp(s => s.chainSync);
  const network = wallet.frame?.activeEntity?.core?.config.jurisdiction;
  const badge = getJurisdictionBadgeInfo(network?.name ?? wallet.jurisdiction, network?.chainId);
  return (
    <aside className="jurisdiction-banner" data-testid="jurisdiction-banner" aria-label="Active jurisdiction">
      <div className="jurisdiction-heading">
        <span>
          Jurisdiction · <strong>{badge?.name ?? 'Loading network…'}</strong>
        </span>
        {network?.chainId !== undefined && <span data-testid="jurisdiction-chain">Chain {network.chainId}</span>}
        <button
          type="button"
          data-testid="wallet-tutorial"
          onClick={() => setTour({ active: !tour.active, ...(tour.completed ? { index: 0, completed: false } : {}) })}
        >
          {tour.active ? 'Pause tutorial' : 'Tutorial · all features'}
        </button>
      </div>
      {chainSync && (
        <p
          className={`state ${chainSync.state === 'stalled' ? 'st-dispute' : 'st-inflight'}`}
          role="status"
          data-testid="chain-sync"
          data-state={chainSync.state}
        >
          {chainSyncText(chainSync)}
        </p>
      )}
      <details className="jurisdiction-stack" data-testid="jurisdiction-stack">
        <summary>Contract stack</summary>
        <p>This blockchain enforces the rules. Each stack has its own contracts and governance.</p>
        <p>
          Depository · <code>{network?.depositoryAddress || 'Not loaded'}</code>
        </p>
        <p>
          Entity Provider · <code>{network?.entityProviderAddress || 'Not loaded'}</code>
        </p>
      </details>
    </aside>
  );
}
