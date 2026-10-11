import { Bar } from '../Bars';
import { formatAmount, formatUsd, getTokenMeta } from '../../runtime/format';
import { usdOf } from '../../runtime/financial/prices';
import { useApp } from '../../runtime/store';
import type { TokenTotals, WalletView } from '../../runtime/views';

export function BalanceDetails({ wallet, token }: { wallet: WalletView; token: TokenTotals | undefined }) {
  const places = useApp(s => s.places);
  const meta = token ? getTokenMeta(token.tokenId) : null;
  const amount = (key: 'secured' | 'risk' | 'onchain' | 'reserve' | 'pending') =>
    token ? usdOf(token.tokenId, token[key]) : wallet.usd[key];
  const money = (key: 'secured' | 'risk' | 'onchain' | 'reserve' | 'pending') =>
    token && meta
      ? `${formatAmount(token[key], meta.decimals, meta.decimals)} ${meta.symbol}`
      : formatUsd(wallet.usd[key]);
  const owed = token ? usdOf(token.tokenId, -token.owed) : wallet.usd.owed;
  const parts = [
    {
      visible: places.accounts,
      kind: 'coll' as const,
      key: 'secured' as const,
      id: 'home-secured',
      label: 'Backed by collateral',
      description: 'Covered by funds locked on-chain.',
    },
    {
      visible: places.accounts,
      kind: 'risk' as const,
      key: 'risk' as const,
      id: 'home-risk',
      label: 'Without collateral',
      description: 'Repayment depends on the other party.',
    },
    {
      visible: places.onchain,
      kind: 'onchain' as const,
      key: 'onchain' as const,
      id: 'home-onchain',
      label: 'Blockchain wallet',
      description: 'Funds held directly at your blockchain address.',
    },
    {
      visible: places.reserve,
      kind: 'reserve' as const,
      key: 'reserve' as const,
      id: 'home-reserve',
      label: 'Contract reserve',
      description: 'Your funds in the XLN contract, not allocated to a payment account.',
    },
  ].filter(part => part.visible);
  return (
    <section className="wallet-breakdown" aria-label="Balance breakdown" data-testid="home-balance-breakdown">
      <h3 className="caps">How your money is held</h3>
      <Bar segments={parts.map(part => ({ usd: amount(part.key), kind: part.kind }))} height={8} />
      <div className="balance-parts">
        {parts.map(part => (
          <div key={part.id} className={`balance-part${amount(part.key) === 0 ? ' empty' : ''}`}>
            <div data-testid={part.id}>
              <span>
                <i className={`sw c-${part.kind}`} />
                {part.label}
              </span>
              <strong className="num">{money(part.key)}</strong>
            </div>
            <p className="note">{part.description}</p>
          </div>
        ))}
      </div>
      {places.accounts && owed > 0 && (
        <p className="note">
          <i className="sw c-debt" />
          You owe{' '}
          {token && meta
            ? `${formatAmount(-token.owed, meta.decimals, meta.decimals)} ${meta.symbol}`
            : formatUsd(owed)}
          . Deducted from your total balance.
        </p>
      )}
      {places.reserve && amount('pending') > 0 && (
        <p className="note st-pending">{money('pending')} depositing · not yet in your balance</p>
      )}
    </section>
  );
}
