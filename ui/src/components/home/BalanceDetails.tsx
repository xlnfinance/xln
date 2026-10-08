import { Bar } from '../Bars';
import { formatUsd } from '../../runtime/format';
import { useApp } from '../../runtime/store';
import type { WalletView } from '../../runtime/views';

export function BalanceDetails({ wallet }: { wallet: WalletView }) {
  const scaleMode = useApp(s => s.scaleMode);
  const setScaleMode = useApp(s => s.setScaleMode);
  const places = useApp(s => s.places);
  const parts = [
    {
      visible: places.accounts,
      kind: 'coll' as const,
      amount: wallet.usd.secured,
      id: 'home-secured',
      label: 'Collateral-backed',
      description: 'Owed to you, covered by funds locked on-chain.',
    },
    {
      visible: places.accounts,
      kind: 'risk' as const,
      amount: wallet.usd.risk,
      id: 'home-risk',
      label: 'At risk',
      description: 'Owed to you; repayment depends on the other party.',
    },
    {
      visible: places.onchain,
      kind: 'onchain' as const,
      amount: wallet.usd.onchain,
      id: 'home-onchain',
      label: 'Blockchain wallet',
      description: 'Held directly at your blockchain address.',
    },
    {
      visible: places.reserve,
      kind: 'reserve' as const,
      amount: wallet.usd.reserve,
      id: 'home-reserve',
      label: 'Reserve',
      description: 'In the xln contract, not yet in an account.',
    },
  ].filter(part => part.visible);
  return (
    <section className="wallet-breakdown" aria-label="Balance breakdown" data-testid="home-balance-breakdown">
      <div className="sect">
        <h3>Where your balance is held</h3>
        <span className="note wallet-scale-note">
          Same dollar value = same bar length · {scaleMode === 'auto' ? 'Auto scale' : 'Fixed scale'}
          {scaleMode === 'fixed' && (
            <button type="button" className="more" onClick={() => setScaleMode('auto')}>
              Fit all balances
            </button>
          )}
        </span>
      </div>
      <Bar segments={parts.map(part => ({ usd: part.amount, kind: part.kind }))} height={8} />
      <div className="stats">
        {parts.map(part => (
          <div key={part.id} className="stat" title={part.description}>
            <div data-testid={part.id}>
              <span className="stat-label">
                <i className={`sw c-${part.kind}`} />
                {part.label}
              </span>
              <strong className="stat-value num">{formatUsd(part.amount)}</strong>
            </div>
            <p className="note">{part.description}</p>
          </div>
        ))}
      </div>
      {places.accounts && wallet.usd.owed > 0 && (
        <p className="note wallet-breakdown-note">
          <i className="sw c-debt" /> You owe {formatUsd(wallet.usd.owed)}. This is deducted from your total balance.
        </p>
      )}
      {places.reserve && wallet.usd.pending > 0 && (
        <p className="note st-pending wallet-breakdown-note">
          {formatUsd(wallet.usd.pending)} being deposited · not yet in your balance
        </p>
      )}
      <p className="note wallet-breakdown-note">Fixed reference prices, not live market value.</p>
    </section>
  );
}
